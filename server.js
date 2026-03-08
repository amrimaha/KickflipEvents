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

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }));
app.options('*', cors()); // respond to CORS preflight for all routes
app.use(express.json({ limit: '2mb' }));

// ─── Analytics helpers ───────────────────────────────────────────────

const SESSION_GAP_MS = 30 * 60 * 1000; // 30-minute inactivity = new session

/**
 * Record a request row in api_requests and update the user's session +
 * last_seen_at. Called at the end of each tracked endpoint handler.
 * Non-blocking: errors are swallowed so analytics never break product flows.
 */
async function trackRequest({ endpoint, method = 'POST', userId = null, responseTimeMs, statusCode, source = null }) {
  try {
    let sessionId = null;

    if (userId) {
      // Update last_seen_at on the user row
      await supabase.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', userId);

      // Find the most recent open session for this user
      const { data: openSession } = await supabase
        .from('user_sessions')
        .select('id, session_start, action_count, query_count')
        .eq('user_id', userId)
        .is('session_end', null)
        .order('session_start', { ascending: false })
        .limit(1)
        .single();

      const now = new Date();

      if (openSession) {
        const elapsed = now - new Date(openSession.session_start);
        if (elapsed <= SESSION_GAP_MS) {
          // Continue existing session
          const isChat = endpoint === '/api/chat';
          await supabase.from('user_sessions').update({
            session_end:  now.toISOString(),
            action_count: openSession.action_count + 1,
            query_count:  openSession.query_count + (isChat ? 1 : 0),
            duration_secs: elapsed / 1000,
          }).eq('id', openSession.id);
          sessionId = openSession.id;
        } else {
          // Gap exceeded — close old session, open new one
          await supabase.from('user_sessions').update({
            session_end:  new Date(new Date(openSession.session_start).getTime() + elapsed).toISOString(),
            duration_secs: elapsed / 1000,
          }).eq('id', openSession.id);

          const { data: newSess } = await supabase
            .from('user_sessions')
            .insert({ user_id: userId, session_start: now.toISOString(), action_count: 1, query_count: endpoint === '/api/chat' ? 1 : 0 })
            .select('id').single();
          sessionId = newSess?.id || null;
        }
      } else {
        // No open session — create one
        const { data: newSess } = await supabase
          .from('user_sessions')
          .insert({ user_id: userId, session_start: now.toISOString(), action_count: 1, query_count: endpoint === '/api/chat' ? 1 : 0 })
          .select('id').single();
        sessionId = newSess?.id || null;
      }
    }

    // Write the api_requests row
    await supabase.from('api_requests').insert({
      endpoint,
      method,
      user_id:          userId,
      session_id:       sessionId,
      response_time_ms: responseTimeMs,
      status_code:      statusCode,
      source,
    });
  } catch (err) {
    // Analytics must never break the main product flow
    console.warn('[analytics] trackRequest error (non-fatal):', err?.message);
  }
}

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Google OAuth ────────────────────────────────────────────────────
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const t0 = Date.now();
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    const user = { id: p.sub, name: p.name, email: p.email, avatar: p.picture };

    // Upsert user row (creates on first login, refreshes avatar on return)
    await supabase.from('users').upsert({
      id: p.sub, name: p.name, email: p.email, avatar: p.picture,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    res.json({ user });
    trackRequest({ endpoint: '/api/auth/google', userId: p.sub, responseTimeMs: Date.now() - t0, statusCode: 200 });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid token' });
    trackRequest({ endpoint: '/api/auth/google', userId: null, responseTimeMs: Date.now() - t0, statusCode: 401 });
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

/** pgvector similarity search via Supabase RPC — supports optional date + is_free constraints */
async function searchByEmbedding(queryVector, threshold = 0.72, limit = 10, constraints = {}) {
  const { dateFrom, dateTo, isFree } = constraints;
  const { data, error } = await supabase.rpc('search_events_by_embedding', {
    query_embedding: queryVector,
    match_threshold: threshold,
    match_count: limit,
    date_from: dateFrom || null,
    date_to: dateTo || null,
    filter_is_free: isFree !== undefined ? isFree : null,
  });
  if (error) throw new Error(`pgvector search error: ${error.message}`);
  return (data || []).map(row => ({ similarity: row.similarity, ...(row.payload || {}), id: row.id }));
}

/**
 * Chronological fallback — returns future events ordered by start date.
 * Used when embedding search returns zero results or embedding API is down.
 */
async function searchChronological(constraints = {}, limit = 10) {
  const { dateFrom, dateTo, isFree } = constraints;
  const { data, error } = await supabase.rpc('search_events_chronological', {
    result_limit: limit,
    date_from: dateFrom || null,
    date_to: dateTo || null,
    filter_is_free: isFree !== undefined ? isFree : null,
  });
  if (error) throw new Error(`chronological search error: ${error.message}`);
  return (data || []).map(row => ({ ...(row.payload || {}), id: row.id }));
}

/**
 * Parse user query for date constraints and free-event intent.
 * Ported from Ravi's app/query/parser.py.
 *
 * Returns:
 *   intent    — query with date/free phrases stripped (used for embedding)
 *   dateFrom  — ISO string or null
 *   dateTo    — ISO string or null
 *   isFree    — true | undefined (never false — don't exclude paid events)
 *   dateLabel — human label for logging ('today', 'weekend', etc.)
 */
function parseQueryConstraints(query) {
  const now = new Date();
  const seattleNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = new Date(seattleNow); today.setHours(0, 0, 0, 0);

  function addDays(d, n) {
    const r = new Date(d); r.setDate(r.getDate() + n); return r;
  }
  function isoDate(d) {
    return d.toISOString().split('T')[0] + 'T00:00:00.000Z';
  }
  function isoEndDate(d) {
    return d.toISOString().split('T')[0] + 'T23:59:59.999Z';
  }

  let dateFrom = null, dateTo = null, dateLabel = null;
  let q = query.toLowerCase();

  // ── Date patterns ────────────────────────────────────────────────────
  const dayOfWeek = seattleNow.getDay(); // 0=Sun, 6=Sat

  if (/\btoday\b/.test(q)) {
    dateFrom = isoDate(today); dateTo = isoEndDate(today); dateLabel = 'today';
    q = q.replace(/\btoday\b/g, '');
  } else if (/\btomorrow\b/.test(q)) {
    const tom = addDays(today, 1);
    dateFrom = isoDate(tom); dateTo = isoEndDate(tom); dateLabel = 'tomorrow';
    q = q.replace(/\btomorrow\b/g, '');
  } else if (/\bthis\s+weekend\b/.test(q)) {
    const daysToSat = (6 - dayOfWeek + 7) % 7 || 7;
    const sat = addDays(today, daysToSat);
    const sun = addDays(sat, 1);
    dateFrom = isoDate(sat); dateTo = isoEndDate(sun); dateLabel = 'weekend';
    q = q.replace(/\bthis\s+weekend\b/g, '');
  } else if (/\bthis\s+week\b/.test(q)) {
    dateFrom = isoDate(today); dateTo = isoEndDate(addDays(today, 7)); dateLabel = 'this_week';
    q = q.replace(/\bthis\s+week\b/g, '');
  } else if (/\bnext\s+week\b/.test(q)) {
    const daysToMon = (1 - dayOfWeek + 7) % 7 || 7;
    const mon = addDays(today, daysToMon);
    const sun = addDays(mon, 6);
    dateFrom = isoDate(mon); dateTo = isoEndDate(sun); dateLabel = 'next_week';
    q = q.replace(/\bnext\s+week\b/g, '');
  } else if (/\bthis\s+month\b/.test(q)) {
    const lastDay = new Date(seattleNow.getFullYear(), seattleNow.getMonth() + 1, 0);
    dateFrom = isoDate(today); dateTo = isoEndDate(lastDay); dateLabel = 'this_month';
    q = q.replace(/\bthis\s+month\b/g, '');
  }

  // ── Free event detection ──────────────────────────────────────────────
  let isFree;
  if (/\bfree\b|\bno\s+cost\b|\bfree\s+events?\b|\bfree\s+admission\b/.test(q)) {
    isFree = true;
    q = q.replace(/\bfree\s+events?\b|\bfree\s+admission\b|\bno\s+cost\b|\bfree\b/g, '');
  }

  const intent = q.replace(/\s+/g, ' ').trim() || query;

  return { intent, dateFrom, dateTo, isFree, dateLabel };
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
  const MAX_TURNS = 3;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
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
        origin: 'crawl',
        status: 'active',
        crawled_at: new Date().toISOString(),
        source_url: event.link || null,
        crawl_source: event.crawlSource || null,
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
  const { query, user_id } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const t0 = Date.now();

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
      res.json({ text: cached.result_text, events, source: 'cache' });
      trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: Date.now() - t0, statusCode: 200, source: 'cache' });
      return;
    }

    console.log(`[cache MISS] "${query}" — running embedding search`);

    // ── ② Parse query constraints (date range, is_free, intent) ──────
    const constraints = parseQueryConstraints(query);
    const { intent, dateFrom, dateTo, isFree, dateLabel } = constraints;
    if (dateLabel || isFree) {
      console.log(`[parse] intent="${intent}" dateLabel=${dateLabel || 'none'} isFree=${isFree ?? 'any'}`);
    }

    // ── ③ Embed the intent (date/free phrases stripped) ───────────────
    let queryVector;
    try {
      queryVector = await embedQuery(intent);
    } catch (embedErr) {
      console.warn(`[embed] failed: ${embedErr.message} — falling back to chronological`);
      const fallbackEvents = await searchChronological(constraints, 10);
      const result = fallbackEvents.length >= 1
        ? await formatWithClaude(query, fallbackEvents, currentDateTime)
        : await discoverWithWebSearch(query, currentDateTime);
      const rawEvents = (result.events || []).map((e, i) => { if (!e.id) e.id = `result-${Date.now()}-${i}`; return e; });
      await saveCache(queryHash, query, rawEvents.map(e => e.id), result.text || '');
      res.json({ text: result.text || 'Checking the local scene...', events: rawEvents });
      trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: Date.now() - t0, statusCode: 200, source: 'chronological' });
      return;
    }

    // ── ④ pgvector similarity search with constraints ─────────────────
    let matchedEvents = await searchByEmbedding(queryVector, 0.72, 10, constraints);
    console.log(`[pgvector] found ${matchedEvents.length} events above threshold`);

    // ── ④a is_free retry: if 0 results with isFree filter → retry without ──
    let usedFreeRetry = false;
    if (matchedEvents.length === 0 && isFree !== undefined) {
      console.log(`[pgvector] 0 results with is_free filter — retrying without it`);
      matchedEvents = await searchByEmbedding(queryVector, 0.72, 10, { dateFrom, dateTo });
      usedFreeRetry = true;
    }

    let result;

    if (matchedEvents.length >= 3) {
      // ── ④b Good match — Claude formats top results ──────────────────
      console.log(`[claude] formatting ${matchedEvents.length} pre-filtered events`);
      result = await formatWithClaude(query, matchedEvents, currentDateTime);

    } else {
      // ── ④c Low confidence — try lower threshold ─────────────────────
      const broadMatches = matchedEvents.length > 0
        ? matchedEvents
        : await searchByEmbedding(queryVector, 0.5, 6, { dateFrom, dateTo });

      if (broadMatches.length >= 2) {
        console.log(`[claude] broad match — formatting ${broadMatches.length} events`);
        result = await formatWithClaude(query, broadMatches, currentDateTime);
      } else {
        // ── ④d Live web search fallback ───────────────────────────────
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

    // Determine source label for analytics
    const responseSource = matchedEvents?.length >= 3 ? 'claude'
      : (usedFreeRetry ? 'semantic_nofree' : matchedEvents?.length >= 2 ? 'embedding' : 'websearch');

    // ── Save to cache ─────────────────────────────────────────────────
    await saveCache(queryHash, query, rawEvents.map(e => e.id), result.text || '');

    res.json({
      text: result.text || 'Checking the local scene...',
      events: rawEvents,
    });
    trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: Date.now() - t0, statusCode: 200, source: responseSource });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({
      error: 'AI service unavailable',
      text: 'Connection bumpy. Try again?',
      events: [],
    });
    trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: Date.now() - t0, statusCode: 500, source: null });
  }
});

// ─── POST /api/crawl — Daily batch crawl (Railway cron or on-demand) ──

app.post('/api/crawl', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { batch } = req.body || {};
  console.log(`[crawl] Starting — batch=${batch || 'all'}`);

  // Set a longer timeout for this endpoint (crawl can take several minutes)
  req.setTimeout(600000);
  res.setTimeout(600000);

  try {
    const summary = await runCrawl({ batch });

    // Auto-backfill embeddings if any events landed without them
    let seedResult = null;
    if (summary.eventsStored > 0 && summary.embeddingsGenerated < summary.eventsStored) {
      console.log('[crawl] Some events missing embeddings — running seed backfill...');
      seedResult = await import('./scripts/seedEmbeddings.js')
        .then(m => m.runSeed())
        .catch(err => {
          console.warn('[crawl] Seed backfill failed (non-fatal):', err.message);
          return null;
        });
    }

    return res.json({
      status: 'Crawl complete',
      timestamp: new Date().toISOString(),
      ...summary,
      seedBackfill: seedResult,
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
  import('./scripts/seedEmbeddings.js')
    .then(m => m.runSeed())
    .then(result => console.log('[seed] Complete:', result))
    .catch(err => console.error('[seed] Failed:', err.message));
  return res.json({ status: 'Seed started', timestamp: new Date().toISOString() });
});

// ─── Saved Events ────────────────────────────────────────────────────
//
// All three endpoints accept/return the same event_payload shape
// (full KickflipEvent JSON) so the frontend never needs a second fetch.
//
// Auth: client sends { user_id } in body / query — same Google OAuth `sub`
// used throughout the app. The backend uses the Supabase SERVICE_ROLE key
// which bypasses RLS, so we validate user_id is a non-empty string.

/** Resolve the start date string from an event payload */
function resolveEventStartDate(payload) {
  // Prefer structured startDate field (YYYY-MM-DD), fall back to .date string
  if (payload.startDate) return new Date(payload.startDate);
  if (payload.date) {
    const d = new Date(payload.date);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// POST /api/saved-events — save an event for a user
app.post('/api/saved-events', async (req, res) => {
  const { user_id, event_id, event_payload, source_url } = req.body;
  if (!user_id || !event_id || !event_payload) {
    return res.status(400).json({ error: 'user_id, event_id and event_payload are required' });
  }

  const { error } = await supabase.from('saved_events').upsert({
    user_id,
    event_id,
    event_payload,
    // Prefer explicitly-passed source_url, fall back to link field inside the payload
    source_url: source_url || event_payload?.link || null,
    saved_at: new Date().toISOString(),
  }, { onConflict: 'user_id,event_id' });

  if (error) {
    console.error('[saved-events] save error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ success: true, event_id });
});

// DELETE /api/saved-events/:eventId — unsave an event for a user
app.delete('/api/saved-events/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required in request body' });

  const { error } = await supabase
    .from('saved_events')
    .delete()
    .eq('user_id', user_id)
    .eq('event_id', eventId);

  if (error) {
    console.error('[saved-events] delete error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ success: true, event_id: eventId });
});

// GET /api/saved-events?user_id=xxx — list a user's saved events
// Returns only future / ongoing events (start_date >= today, or date unknown).
app.get('/api/saved-events', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });

  const { data, error } = await supabase
    .from('saved_events')
    .select('event_id, event_payload, source_url, saved_at')
    .eq('user_id', user_id)
    .order('saved_at', { ascending: false });

  if (error) {
    console.error('[saved-events] fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0); // compare at day boundary

  // Filter out events whose start date is in the past
  const active = (data || []).filter(row => {
    const d = resolveEventStartDate(row.event_payload);
    return d === null || d >= now; // keep if date unknown or in the future
  });

  return res.json({
    saved_events: active.map(row => ({
      event_id:   row.event_id,
      saved_at:   row.saved_at,
      source_url: row.source_url || row.event_payload?.link || null,
      event: { id: row.event_id, ...row.event_payload },
    })),
    total: active.length,
  });
});

// ─── GET /api/admin/telemetry — live metrics for dashboard ───────────
//
// Returns the most recent platform_metrics_snapshots row plus a few
// real-time counts computed inline (supply mix comes from kickflip_events
// directly so it's always fresh).

app.get('/api/admin/telemetry', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Latest snapshot (may be null on first deploy before any snapshot is taken)
    const { data: snap } = await supabase
      .from('platform_metrics_snapshots')
      .select('*')
      .order('computed_at', { ascending: false })
      .limit(1)
      .single();

    // Real-time supply counts (always fresh — cheap query)
    const { data: supplyRows } = await supabase
      .from('kickflip_events')
      .select('origin', { count: 'exact' })
      .eq('status', 'active');

    const totalEvents  = supplyRows?.length ?? 0;
    const userEvents   = supplyRows?.filter(r => r.origin === 'user').length ?? 0;
    const crawlEvents  = supplyRows?.filter(r => r.origin === 'crawl').length ?? 0;
    const providerPct  = totalEvents > 0 ? Math.round(userEvents  / totalEvents * 100) : 0;
    const crawlerPct   = totalEvents > 0 ? Math.round(crawlEvents / totalEvents * 100) : 0;

    // Format interaction time as "Xm Ys"
    const avgSecs = snap?.avg_interaction_secs ?? null;
    const interactionTime = avgSecs
      ? `${Math.floor(avgSecs / 60)}m ${Math.floor(avgSecs % 60)}s`
      : null;

    return res.json({
      // From latest snapshot (may be slightly stale — refreshes every 5 min)
      mau:              snap?.mau               ?? 0,
      unique_users:     snap?.unique_users_total ?? 0,
      new_users_today:  snap?.new_users_today    ?? 0,
      interaction_time: interactionTime,
      avg_response_ms:  snap?.avg_response_time_ms  ? Math.round(snap.avg_response_time_ms) : null,
      p95_response_ms:  snap?.p95_response_time_ms  ? Math.round(snap.p95_response_time_ms) : null,
      queries_today:    snap?.total_queries_today  ?? 0,
      cache_hit_rate:   snap?.cache_hit_rate_pct   ?? 0,
      active_sessions:  snap?.active_sessions_now  ?? 0,
      sessions_today:   snap?.total_sessions_today ?? 0,
      computed_at:      snap?.computed_at           ?? null,

      // Always real-time supply mix
      total_events:  totalEvents,
      user_events:   userEvents,
      crawl_events:  crawlEvents,
      provider_pct:  providerPct,
      crawler_pct:   crawlerPct,
    });
  } catch (err) {
    console.error('[telemetry] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/metrics/snapshot — compute & store a snapshot ───
//
// Called by Railway cron every 5 minutes:
//   POST /api/admin/metrics/snapshot   Authorization: Bearer <CRON_SECRET>
// Also callable on-demand from the admin dashboard.

app.post('/api/admin/metrics/snapshot', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const crawlSourcesCount = req.body?.crawl_sources_count ?? 0;
    const { data, error } = await supabase.rpc('compute_platform_metrics', {
      p_crawl_sources_count: crawlSourcesCount,
    });
    if (error) throw new Error(error.message);
    return res.json({ success: true, snapshot_id: data, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[metrics/snapshot] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/events/click — clickstream event tracking ─────────────
//
// Records a user action on an event card (view, CTA, save, share, etc.).
// No auth required — anonymous tracking via anon_id (localStorage UUID).
// Fire-and-forget from the frontend: errors must not block the UX.
//
// Body: { event_id, action, anon_id, user_id?, session_id?, source?, extras? }
// Actions: view_detail | cta_click | save | unsave | share | checkout_start

const VALID_CLICK_ACTIONS = new Set([
  'view_detail', 'cta_click', 'save', 'unsave', 'share', 'checkout_start',
]);

app.post('/api/events/click', async (req, res) => {
  const { event_id, action, anon_id, user_id, session_id, source, source_url, extras } = req.body || {};

  // Validate required fields
  if (!event_id || typeof event_id !== 'string') {
    return res.status(400).json({ error: 'event_id is required' });
  }
  if (!action || !VALID_CLICK_ACTIONS.has(action)) {
    return res.status(400).json({ error: `action must be one of: ${[...VALID_CLICK_ACTIONS].join(', ')}` });
  }
  if (!anon_id || typeof anon_id !== 'string') {
    return res.status(400).json({ error: 'anon_id is required' });
  }

  try {
    const { error } = await supabase.from('event_clicks').insert({
      event_id:   event_id.trim(),
      action,
      anon_id:    anon_id.trim(),
      user_id:    user_id    || null,
      session_id: session_id || null,
      source:     source     || null,
      source_url: source_url || null,
      extras:     extras     || null,
    });

    if (error) {
      console.error('[events/click] insert error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[events/click] unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Chat Session API ─────────────────────────────────────────────────────────
//
// Privacy design: the real user UUID is NEVER stored in chat tables.
// pseudonymize() converts it to a deterministic HMAC-SHA256 token using
// PSEUDONYM_SECRET (Railway env var). DB consumers see only the token;
// the backend can always re-derive the same token to look up a user's chats.
//
// Anonymous users: anon_id (browser fingerprint) is stored directly —
// anonymous sessions carry no PII so no pseudonymization is needed.

function pseudonymize(userId) {
  const secret = process.env.PSEUDONYM_SECRET;
  if (!secret) {
    console.warn('[chat] PSEUDONYM_SECRET not set — user_id stored as-is in dev');
    return String(userId);
  }
  return crypto.createHmac('sha256', secret).update(String(userId)).digest('hex');
}

// POST /api/chats
// Create a new chat thread + its first session atomically.
// Body: { user_id?, anon_id?, title }
// Returns: { chat_id, session_id }
app.post('/api/chats', async (req, res) => {
  const { user_id, anon_id, title } = req.body || {};
  if (!user_id && !anon_id) {
    return res.status(400).json({ error: 'user_id or anon_id required' });
  }

  const pseudo = user_id ? pseudonymize(user_id) : null;
  const now    = new Date().toISOString();

  try {
    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .insert({
        user_pseudo_id: pseudo,
        anon_id:        anon_id || null,
        title:          (title || 'New Chat').slice(0, 100),
        created_at:     now,
        updated_at:     now,
      })
      .select('id')
      .single();
    if (chatErr) return res.status(500).json({ error: chatErr.message });

    const { data: session, error: sessErr } = await supabase
      .from('chat_sessions')
      .insert({
        chat_id:        chat.id,
        user_pseudo_id: pseudo,
        anon_id:        anon_id || null,
        session_num:    1,
        started_at:     now,
      })
      .select('id')
      .single();
    if (sessErr) return res.status(500).json({ error: sessErr.message });

    return res.status(201).json({ chat_id: chat.id, session_id: session.id });
  } catch (err) {
    console.error('[chats/create]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/chats?user_id=...
// List all non-archived chats for a user, newest first.
// Returns: { chats: [{ id, title, updated_at, last_session_id, session_count }] }
app.get('/api/chats', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const pseudo = pseudonymize(String(user_id));

  try {
    const { data: chats, error } = await supabase
      .from('chats')
      .select('id, title, created_at, updated_at')
      .eq('user_pseudo_id', pseudo)
      .eq('is_archived', false)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });

    // Enrich each chat with its latest session id and total session count
    const enriched = await Promise.all((chats || []).map(async (c) => {
      const { data: sessions, count } = await supabase
        .from('chat_sessions')
        .select('id, session_num', { count: 'exact' })
        .eq('chat_id', c.id)
        .order('session_num', { ascending: false })
        .limit(1);
      return {
        ...c,
        last_session_id: sessions?.[0]?.id   || null,
        session_count:   count                || 1,
      };
    }));

    return res.json({ chats: enriched });
  } catch (err) {
    console.error('[chats/list]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/chats/:chatId?user_id=...
// Return all messages for a chat (across all sessions), ordered chronologically.
// Ownership is verified via the pseudonymized user_id.
// Returns: { chat_id, title, messages: [{ role, content, event_urls, event_ids, seq, created_at }] }
app.get('/api/chats/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const pseudo = pseudonymize(String(user_id));

  try {
    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id, title')
      .eq('id', chatId)
      .eq('user_pseudo_id', pseudo)
      .single();
    if (chatErr || !chat) return res.status(404).json({ error: 'Chat not found' });

    const { data: messages, error: msgErr } = await supabase
      .from('chat_messages')
      .select('id, session_id, role, content, event_urls, event_ids, seq, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .order('seq',        { ascending: true });
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    return res.json({ chat_id: chatId, title: chat.title, messages: messages || [] });
  } catch (err) {
    console.error('[chats/get]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/chats/:chatId/sessions
// Start a new session on an existing chat (user resumed a past chat).
// Body: { user_id }
// Returns: { session_id, session_num }
app.post('/api/chats/:chatId/sessions', async (req, res) => {
  const { chatId } = req.params;
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const pseudo = pseudonymize(String(user_id));

  try {
    // Verify ownership
    const { data: chat, error: chatErr } = await supabase
      .from('chats')
      .select('id')
      .eq('id', chatId)
      .eq('user_pseudo_id', pseudo)
      .single();
    if (chatErr || !chat) return res.status(404).json({ error: 'Chat not found' });

    // Count existing sessions to set session_num
    const { count } = await supabase
      .from('chat_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('chat_id', chatId);

    const sessionNum = (count || 0) + 1;
    const now        = new Date().toISOString();

    const { data: session, error: sessErr } = await supabase
      .from('chat_sessions')
      .insert({ chat_id: chatId, user_pseudo_id: pseudo, session_num: sessionNum, started_at: now })
      .select('id')
      .single();
    if (sessErr) return res.status(500).json({ error: sessErr.message });

    await supabase.from('chats').update({ updated_at: now }).eq('id', chatId);

    return res.status(201).json({ session_id: session.id, session_num: sessionNum });
  } catch (err) {
    console.error('[chats/sessions/create]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/chats/:chatId/sessions/:sessionId/end
// Mark a session as ended (sets ended_at = now).
// No auth check here — the chatId + sessionId pair acts as an implicit token.
app.put('/api/chats/:chatId/sessions/:sessionId/end', async (req, res) => {
  const { chatId, sessionId } = req.params;
  try {
    await supabase
      .from('chat_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id',      sessionId)
      .eq('chat_id', chatId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[chats/sessions/end]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/chats/:chatId/sessions/:sessionId/messages
// Append one or more messages (a single turn = user + assistant pair) to a session.
// Body: { messages: [{ role, content, event_urls?, event_ids? }] }
// Returns: { ok: true, stored: N }
app.post('/api/chats/:chatId/sessions/:sessionId/messages', async (req, res) => {
  const { chatId, sessionId } = req.params;
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    // Determine current seq offset so appended messages continue from the right index
    const { count } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    let seq = count || 0;
    const now = new Date().toISOString();

    const rows = messages.map(m => ({
      chat_id:    chatId,
      session_id: sessionId,
      role:       m.role === 'user' ? 'user' : 'assistant',
      content:    String(m.content || ''),
      event_urls: Array.isArray(m.event_urls) ? m.event_urls : [],
      event_ids:  Array.isArray(m.event_ids)  ? m.event_ids  : [],
      seq:        seq++,
      created_at: now,
    }));

    const { error } = await supabase.from('chat_messages').insert(rows);
    if (error) return res.status(500).json({ error: error.message });

    // Keep chat.updated_at fresh so list view sorts correctly
    await supabase.from('chats').update({ updated_at: now }).eq('id', chatId);

    return res.status(201).json({ ok: true, stored: rows.length });
  } catch (err) {
    console.error('[chats/messages/store]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`KickflipEvents backend running on port ${port}`);
});
