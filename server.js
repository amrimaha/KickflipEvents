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

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'] }));
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

    // Determine source label for analytics
    const responseSource = matchedEvents?.length >= 3 ? 'claude'
      : (matchedEvents?.length >= 2 ? 'embedding' : 'websearch');

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
  const { user_id, event_id, event_payload } = req.body;
  if (!user_id || !event_id || !event_payload) {
    return res.status(400).json({ error: 'user_id, event_id and event_payload are required' });
  }

  const { error } = await supabase.from('saved_events').upsert({
    user_id,
    event_id,
    event_payload,
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
    .select('event_id, event_payload, saved_at')
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
      event_id: row.event_id,
      saved_at: row.saved_at,
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
  const { event_id, action, anon_id, user_id, session_id, source, extras } = req.body || {};

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
      user_id:    user_id   || null,
      session_id: session_id || null,
      source:     source    || null,
      extras:     extras    || null,
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

// ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`KickflipEvents backend running on port ${port}`);
});
