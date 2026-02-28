/**
 * server.js — Kickflip Events Backend
 *
 * Query pipeline (Layer 2):
 *   ① Check query_cache  → return instantly (0 tokens) on hit
 *   ② Embed query via Voyage AI
 *   ③ pgvector similarity search → top-10 events from Supabase
 *   ④a similarity ≥ 0.72 → Claude formats response (~2k tokens)
 *   ④b similarity < 0.72 → Claude web_search → embed → store → return
 *
 * Batch pipeline (Layer 1) endpoints:
 *   POST /api/crawl  — triggered by Railway cron daily
 *   POST /api/seed   — one-time embedding seed for existing events
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { embedQuery, embedEvent } from './services/embeddingService.js';
import { runCrawl } from './scripts/crawler.js';

const app = express();
const port = process.env.PORT || 3001;

// ─── Clients ────────────────────────────────────────────────────────
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || '');
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Google OAuth ────────────────────────────────────────────────────
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    res.json({ user: { id: p.sub, name: p.name, email: p.email, avatar: p.picture } });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** SHA-256 hash of a query string for cache key */
function hashQuery(query) {
  return crypto.createHash('sha256').update(query.toLowerCase().trim()).digest('hex');
}

/** Check query_cache table for a recent result */
async function checkCache(queryHash) {
  const { data } = await supabase
    .from('query_cache')
    .select('event_ids, result_text')
    .eq('query_hash', queryHash)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data || null;
}

/** Fetch full event objects from Supabase by id array */
async function fetchEventsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const { data } = await supabase
    .from('kickflip_events')
    .select('id, payload')
    .in('id', ids);
  return (data || []).map(row => ({ id: row.id, ...(row.payload || {}) }));
}

/** Save a result to query_cache (6-hour TTL) */
async function saveCache(queryHash, queryText, eventIds, resultText) {
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  await supabase.from('query_cache').upsert({
    query_hash: queryHash,
    query_text: queryText,
    event_ids: eventIds,
    result_text: resultText,
    expires_at: expiresAt,
  }, { onConflict: 'query_hash' });
}

/** pgvector similarity search via Supabase RPC */
async function searchByEmbedding(queryVector, threshold = 0.72, limit = 10) {
  const { data, error } = await supabase.rpc('search_events_by_embedding', {
    query_embedding: queryVector,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) throw new Error(`pgvector search error: ${error.message}`);
  return (data || []).map(row => ({ similarity: row.similarity, ...(row.payload || {}), id: row.id }));
}

// ─── Claude formatting (orchestrator role only) ───────────────────────

const SYSTEM_PROMPT = `You are Kickflip, Seattle's premier event discovery AI.
Your persona is cool, connected, and in-the-know about Seattle's local scene.

CRITICAL: Max 12 words for the "text" field. No fluff. Just the vibe.

RESPONSE FORMAT — valid JSON only:
{"text": "short vibe max 12 words", "events": [...event objects...]}`;

async function formatWithClaude(query, events, currentDateTime) {
  const eventSnippets = events.map(e => ({
    id: e.id,
    title: e.title,
    date: e.date,
    location: e.locationName || e.location,
    description: e.vibeDescription || e.description,
    category: e.category,
    vibeTags: e.vibeTags,
    price: e.price,
    link: e.link,
  }));

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `CURRENT DATE/TIME: ${currentDateTime} (Seattle)
USER QUERY: "${query}"

MATCHING EVENTS (pre-filtered by semantic search):
${JSON.stringify(eventSnippets)}

Rank these by relevance to the query. Return all relevant ones.
Respond with valid JSON: {"text": "...", "events": [...]}`,
    }],
  });

  const text = message.content[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { text: 'Here\'s what\'s happening in Seattle.', events };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { text: 'Here\'s what\'s happening in Seattle.', events };
  }
}

// ─── Claude web_search fallback (live discovery) ──────────────────────

async function discoverWithWebSearch(query, currentDateTime) {
  const conversationMessages = [{
    role: 'user',
    content: `CURRENT DATE/TIME: ${currentDateTime} (Seattle)
USER QUERY: "${query}"

No matching events were found in the internal database.
Use web_search to find real current Seattle events matching this query.
Search for specific event listings, not just venue homepages.
Return valid JSON: {"text": "max 12 word vibe", "events": [array of event objects]}

Each event needs: id (string), title, date, location, description,
category (music/food/art/party/outdoor/wellness/fashion/sports/comedy/other),
vibeTags (array), price, link (real URL).`,
  }];

  let finalText = '';
  const MAX_TURNS = 6;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: conversationMessages,
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } }
    );

    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) finalText = textBlocks.map(b => b.text).join('');
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      conversationMessages.push({ role: 'assistant', content: response.content });
      const toolResults = response.content
        .filter(b => b.type === 'tool_use')
        .map(b => {
          const resultBlock = response.content.find(
            rb => rb.type === 'web_search_tool_result_20250305' && rb.tool_use_id === b.id
          );
          return {
            type: 'tool_result',
            tool_use_id: b.id,
            content: resultBlock ? resultBlock.content : 'Search complete.',
          };
        });
      if (toolResults.length > 0) conversationMessages.push({ role: 'user', content: toolResults });
      else break;
    } else break;
  }

  const match = finalText.match(/\{[\s\S]*\}/);
  if (!match) return { text: 'Scouting the Seattle scene...', events: [] };
  try { return JSON.parse(match[0]); } catch { return { text: finalText.trim(), events: [] }; }
}

/** Store newly discovered events (from web search) back into Supabase with embeddings */
async function storeDiscoveredEvents(events) {
  if (!events || events.length === 0) return;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  for (const event of events) {
    try {
      const embedding = await embedEvent(event);
      await supabase.from('kickflip_events').upsert({
        id: event.id || `discovered-${Date.now()}`,
        title: event.title,
        category: event.category || 'other',
        payload: event,
        embedding,
        crawled_at: new Date().toISOString(),
        source_url: event.link || null,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch (err) {
      console.warn(`Failed to store discovered event "${event.title}":`, err.message);
    }
  }
}

// ─── POST /api/chat — Main query endpoint ────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  const currentDateTime = new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: 'numeric', timeZone: 'America/Los_Angeles',
  });

  try {
    // ── ① Cache check ────────────────────────────────────────────────
    const queryHash = hashQuery(query);
    const cached = await checkCache(queryHash);

    if (cached) {
      console.log(`[cache HIT] "${query}"`);
      const events = await fetchEventsByIds(cached.event_ids);
      return res.json({ text: cached.result_text, events, source: 'cache' });
    }

    console.log(`[cache MISS] "${query}" — running embedding search`);

    // ── ② Embed the query ────────────────────────────────────────────
    const queryVector = await embedQuery(query);

    // ── ③ pgvector similarity search ─────────────────────────────────
    const matchedEvents = await searchByEmbedding(queryVector, 0.72, 10);
    console.log(`[pgvector] found ${matchedEvents.length} events above threshold`);

    let result;

    if (matchedEvents.length >= 3) {
      // ── ④a Good match — Claude formats only the top-10 ─────────────
      console.log(`[claude] formatting ${matchedEvents.length} pre-filtered events`);
      result = await formatWithClaude(query, matchedEvents, currentDateTime);

    } else {
      // ── ④b Low confidence — try lower threshold first ───────────────
      const broadMatches = matchedEvents.length > 0
        ? matchedEvents
        : await searchByEmbedding(queryVector, 0.5, 6);

      if (broadMatches.length >= 2) {
        console.log(`[claude] broad match — formatting ${broadMatches.length} events`);
        result = await formatWithClaude(query, broadMatches, currentDateTime);
      } else {
        // ── ④c Live web search fallback ──────────────────────────────
        console.log(`[web_search] no DB match — triggering live search`);
        result = await discoverWithWebSearch(query, currentDateTime);

        // Store discovered events in background (non-blocking)
        if (result.events && result.events.length > 0) {
          storeDiscoveredEvents(result.events).catch(err =>
            console.warn('Background store error:', err.message)
          );
        }
      }
    }

    // Normalise event objects returned by Claude
    const rawEvents = (result.events || []).map((e, index) => {
      if (!e.id) e.id = `result-${Date.now()}-${index}`;
      return e;
    });

    // ── Save to cache ─────────────────────────────────────────────────
    await saveCache(queryHash, query, rawEvents.map(e => e.id), result.text || '');

    return res.json({
      text: result.text || 'Checking the local scene...',
      events: rawEvents,
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({
      error: 'AI service unavailable',
      text: 'Connection bumpy. Try again?',
      events: [],
    });
  }
});

// ─── POST /api/crawl — Daily batch crawl (Railway cron or on-demand) ──

app.post('/api/crawl', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[crawl] Starting — window: today → +7 days');

  // Set a longer timeout for this endpoint (crawl can take ~60s)
  req.setTimeout(120000);
  res.setTimeout(120000);

  try {
    const summary = await runCrawl();
    return res.json({
      status: 'Crawl complete',
      timestamp: new Date().toISOString(),
      ...summary,
    });
  } catch (err) {
    console.error('[crawl] Failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/seed — One-time embedding seed ────────────────────────

app.post('/api/seed', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[seed] Embedding seed triggered');
  res.json({ status: 'Seed started', timestamp: new Date().toISOString() });

  // Run seed asynchronously
  import('./scripts/seedEmbeddings.js').catch(err =>
    console.error('Seed error:', err)
  );
});

// ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`KickflipEvents backend running on port ${port}`);
});
