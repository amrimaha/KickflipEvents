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
import pkg from 'pg';
import { embedQuery, embedEvent } from './services/embeddingService.js';
import { runCrawl } from './scripts/crawler.js';

const { Pool } = pkg;

const app = express();
const port = process.env.PORT || 3001;

// ─── Clients ────────────────────────────────────────────────────────
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || '');
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Direct PG pool — saved events (portable to AWS RDS, no Supabase SDK) ────
// Set DATABASE_URL in Railway to your Supabase Transaction Pooler string:
//   postgresql://postgres.PROJECT:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
const pgPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    })
  : null;

// Auto-create kickflip_saved_events table (no FK constraint → works without users table)
if (pgPool) {
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS kickflip_saved_events (
      id            BIGSERIAL PRIMARY KEY,
      user_id       TEXT        NOT NULL,
      event_id      TEXT        NOT NULL,
      event_payload JSONB       NOT NULL,
      source_url    TEXT,
      saved_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS kickflip_saved_events_user_idx ON kickflip_saved_events (user_id);
  `).catch(e => console.warn('[pg:init] kickflip_saved_events table setup failed:', e.message));

  // Auto-create chat scoring tables
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          TEXT,
      user_message     TEXT        NOT NULL,
      ai_response      TEXT        NOT NULL DEFAULT '',
      events_returned  JSONB,
      source           TEXT,
      similarity_score FLOAT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_conversations_created_idx ON chat_conversations (created_at DESC);
    CREATE INDEX IF NOT EXISTS chat_conversations_user_idx    ON chat_conversations (user_id);

    CREATE TABLE IF NOT EXISTS chat_scores (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id  UUID        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      score_type       TEXT        NOT NULL,
      score            TEXT        NOT NULL CHECK (score IN ('helpful','somewhat_helpful','not_helpful')),
      score_reason     TEXT,
      scored_by        TEXT,
      scored_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (conversation_id, score_type)
    );
    CREATE INDEX IF NOT EXISTS chat_scores_convo_idx  ON chat_scores (conversation_id);
    CREATE INDEX IF NOT EXISTS chat_scores_scored_idx ON chat_scores (scored_at DESC);
  `).catch(e => console.warn('[pg:init] chat scoring tables setup failed:', e.message));
}

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

// ─── Startup env check ───────────────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('[startup] MISSING ENV VARS:', missingEnv.join(', '));
} else {
  console.log('[startup] All required env vars present');
  console.log('[startup] ANTHROPIC_API_KEY starts with:', process.env.ANTHROPIC_API_KEY?.slice(0, 10) + '...');
  console.log('[startup] VOYAGE_API_KEY starts with:', process.env.VOYAGE_API_KEY?.slice(0, 10) + '...');
  console.log('[startup] SUPABASE_URL:', process.env.SUPABASE_URL);
}

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), missingEnv });
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

// Returns true only for real http(s) URLs — filters out "null", "undefined", "", etc.
const isValidImageUrl = (u) => typeof u === 'string' && /^https?:\/\/.+/.test(u.trim());

// Unsplash fallback images by category — shared by chat search helpers + GET /api/events
const UNSPLASH_FALLBACK = {
  music:    'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&fit=crop&auto=format',
  art:      'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format',
  arts:     'https://images.unsplash.com/photo-1547891654-e66ed7ebb968?w=800&fit=crop&auto=format',
  food:     'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&fit=crop&auto=format',
  outdoor:  'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&fit=crop&auto=format',
  comedy:   'https://images.unsplash.com/photo-1527224538127-2104bb71c51b?w=800&fit=crop&auto=format',
  sports:   'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&fit=crop&auto=format',
  wellness: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800&fit=crop&auto=format',
  party:    'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&auto=format',
  default:  'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=800&fit=crop&auto=format',
};

// ─── Keyword → category map (for user preference capture) ─────────────────────
// Maps common search keywords to our 10 event categories.
const KEYWORD_TO_CATEGORY = {
  // food
  sushi: 'food', ramen: 'food', pho: 'food', taco: 'food', pizza: 'food',
  burger: 'food', brunch: 'food', dinner: 'food', lunch: 'food', chef: 'food',
  restaurant: 'food', foodie: 'food', eat: 'food', taste: 'food', cuisine: 'food',
  dumpling: 'food', bbq: 'food', boba: 'food', coffee: 'food', cocktail: 'food',
  // music
  concert: 'music', band: 'music', dj: 'music', live: 'music', jazz: 'music',
  rap: 'music', hip: 'music', techno: 'music', indie: 'music', pop: 'music',
  metal: 'music', classical: 'music', symphony: 'music', beats: 'music', rave: 'music',
  // art
  gallery: 'art', exhibit: 'art', museum: 'art', painting: 'art', sculpture: 'art',
  installation: 'art', mural: 'art', photography: 'art', film: 'art', cinema: 'art',
  // party
  club: 'party', nightlife: 'party', glow: 'party', halloween: 'party', masquerade: 'party',
  // outdoor
  hike: 'outdoor', hiking: 'outdoor', kayak: 'outdoor', bike: 'outdoor', cycling: 'outdoor',
  climb: 'outdoor', climbing: 'outdoor', camp: 'outdoor', camping: 'outdoor', trail: 'outdoor',
  nature: 'outdoor', park: 'outdoor', garden: 'outdoor', market: 'outdoor',
  // wellness
  yoga: 'wellness', meditation: 'wellness', wellness: 'wellness', fitness: 'wellness',
  gym: 'wellness', pilates: 'wellness', breathwork: 'wellness', soundbath: 'wellness',
  // comedy
  comedy: 'comedy', standup: 'comedy', improv: 'comedy', laugh: 'comedy', funny: 'comedy',
  // sports
  sports: 'sports', game: 'sports', basketball: 'sports', soccer: 'sports', football: 'sports',
  baseball: 'sports', tennis: 'sports', volleyball: 'sports', esports: 'sports',
  // fashion
  fashion: 'fashion', style: 'fashion', design: 'fashion', runway: 'fashion', thrift: 'fashion',
};

/**
 * Infer a category from a query string by scanning for known keywords.
 * Returns the first matched category or null.
 */
function extractQueryCategory(query) {
  const lower = query.toLowerCase();
  const words = lower.split(/\W+/);
  for (const word of words) {
    if (KEYWORD_TO_CATEGORY[word]) return KEYWORD_TO_CATEGORY[word];
  }
  // substring scan for multi-char terms (e.g. "outdoor")
  for (const [kw, cat] of Object.entries(KEYWORD_TO_CATEGORY)) {
    if (lower.includes(kw)) return cat;
  }
  return null;
}

/** Upsert user preference — increment search_count and add new keyword */
async function upsertUserPreference(userId, category, keyword) {
  if (!pgPool || !userId || !category) return;
  try {
    const pseudo = pseudonymize(String(userId));
    await pgPool.query(`
      INSERT INTO user_preferences (user_id, category, search_count, keywords, last_searched)
      VALUES ($1, $2, 1, ARRAY[$3]::TEXT[], NOW())
      ON CONFLICT (user_id, category) DO UPDATE SET
        search_count  = user_preferences.search_count + 1,
        keywords      = CASE
                          WHEN $3 = ANY(user_preferences.keywords) THEN user_preferences.keywords
                          ELSE array_append(user_preferences.keywords, $3)
                        END,
        last_searched = NOW()
    `, [pseudo, category, keyword || category]);
  } catch (err) {
    console.warn('[prefs:upsert] non-fatal:', err.message);
  }
}

/** Load top 3 categories for a user — used to personalize Claude prompt */
async function loadUserPreferences(userId) {
  if (!pgPool || !userId) return [];
  try {
    const pseudo = pseudonymize(String(userId));
    const { rows } = await pgPool.query(`
      SELECT category, search_count, keywords
      FROM user_preferences
      WHERE user_id = $1
      ORDER BY search_count DESC, last_searched DESC
      LIMIT 3
    `, [pseudo]);
    return rows;
  } catch (err) {
    console.warn('[prefs:load] non-fatal:', err.message);
    return [];
  }
}

/** Fetch full event objects from Supabase by id array */
async function fetchEventsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const { data } = await supabase
    .from('kickflip_events')
    .select('id, payload, image_url, categories')
    .in('id', ids);
  return (data || []).map(row => {
    const p = row.payload || {};
    const cat = (p.category || (Array.isArray(row.categories) ? row.categories[0] : null) || 'other').toLowerCase();
    if (!isValidImageUrl(p.imageUrl)) p.imageUrl = isValidImageUrl(row.image_url) ? row.image_url : (UNSPLASH_FALLBACK[cat] || UNSPLASH_FALLBACK.default);
    return { id: row.id, ...p };
  });
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
  return (data || []).map(row => {
    const p = row.payload || {};
    const cat = (p.category || 'other').toLowerCase();
    if (!isValidImageUrl(p.imageUrl)) p.imageUrl = UNSPLASH_FALLBACK[cat] || UNSPLASH_FALLBACK.default;
    return { similarity: row.similarity, ...p, id: row.id };
  });
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
  return (data || []).map(row => {
    const p = row.payload || {};
    const cat = (p.category || 'other').toLowerCase();
    if (!isValidImageUrl(p.imageUrl)) p.imageUrl = UNSPLASH_FALLBACK[cat] || UNSPLASH_FALLBACK.default;
    return { ...p, id: row.id };
  });
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
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
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

// ─── Option A helper: template vibe text (no Claude call) ────────────
function buildVibeText(_query, events) {
  const cats = [...new Set(events.slice(0, 3).map(e => e.category).filter(Boolean))];
  if (cats.length === 1) return `Top ${cats[0]} picks in Seattle.`;
  if (cats.length === 2) return `${cats[0]} & ${cats[1]} vibes in Seattle.`;
  return `${events.length} events matching your vibe in Seattle.`;
}

// ─── Option B helper: stream Claude vibe text → append events JSON ────
async function streamVibeWithClaude(query, events, _currentDateTime, res, userPrefs = [], conversationId) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no');
    if (conversationId) res.setHeader('X-Conversation-Id', conversationId);
  }
  const snippets = events.slice(0, 5).map(e => ({
    title: e.title, category: e.category,
    date: e.date || e.startDate, location: e.locationName || e.location,
  }));
  const prefHint = userPrefs.length > 0
    ? ` This user loves ${userPrefs.map(p => p.category).join(' and ')} events — reflect that in the vibe when relevant.`
    : '';
  const stream = anthropic.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 60,
    system: `You are Kickflip, Seattle's event guide. Reply in 1 sentence, max 12 words. Capture the vibe. No JSON.${prefHint}`,
    messages: [{ role: 'user', content: `Query: "${query}"\nTop matches: ${JSON.stringify(snippets)}` }],
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      res.write(event.delta.text);
    }
  }
  res.write('\n\n[EVENTS_JSON]\n');
  res.write(JSON.stringify({ conversationId: conversationId || null, events }));
  res.end();
}

// ─── Shared stream sender (for cache hits, web search, errors) ────────
function sendStreamResult(res, text, events, conversationId) {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no'); // prevent Railway/Nginx from buffering
    if (conversationId) res.setHeader('X-Conversation-Id', conversationId);
  }
  res.write(text || '');
  res.write('\n\n[EVENTS_JSON]\n');
  res.write(JSON.stringify({ conversationId: conversationId || null, events: events || [] }));
  res.end();
}

// ─── Claude web_search fallback (live discovery) ──────────────────────

async function discoverWithWebSearch(query, currentDateTime) {
  const conversationMessages = [{
    role: 'user',
    content: `CURRENT DATE/TIME: ${currentDateTime} (Seattle)
USER QUERY: "${query}"

No matching events were found in the internal database.
Use web_search to find real upcoming Seattle events matching this query.
- Do at least 2 searches: one specific to the query, one broader (e.g. "Seattle food events this week" if no exact match)
- Find real events with actual future dates and venues — no past events
- NEVER return empty events[]. If nothing specific found, return the best related Seattle events you find.
Return valid JSON: {"text": "max 12 word vibe", "events": [array of event objects]}

Each event needs: id (string), title, date, location, description,
category (music/food/art/party/outdoor/wellness/fashion/sports/comedy/other),
vibeTags (array), price, link (real URL).`,
  }];

  let finalText = '';
  const MAX_TURNS = 4;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
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
      // web_search_20250305 is a server-side tool — the API auto-executes the search
      // and includes web_search_tool_result_20250305 blocks in the same response.
      // Push the full assistant response, then ask Claude to produce the JSON.
      conversationMessages.push({ role: 'assistant', content: response.content });
      conversationMessages.push({
        role: 'user',
        content: 'Based on those search results, return the JSON now with the events you found. If nothing specific, return the best related Seattle events from your results.',
      });
    } else break;
  }

  const match = finalText.match(/\{[\s\S]*\}/);
  if (!match) return { text: 'Scouting the Seattle scene...', events: [] };

  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return { text: finalText.trim(), events: [] }; }

  // Strip <cite index="...">...</cite> and any other XML/HTML tags that
  // Claude's web_search tool injects into the response text.
  const stripTags = (v) => typeof v === 'string' ? v.replace(/<[^>]+>/g, '').trim() : v;

  if (Array.isArray(parsed.events)) {
    parsed.events = parsed.events.map(e => {
      const cat = (e.category || 'other').toLowerCase();
      return {
        ...e,
        title:       stripTags(e.title),
        description: stripTags(e.description),
        location:    stripTags(e.location),
        date:        stripTags(e.date),
        price:       stripTags(e.price),
        imageUrl:    isValidImageUrl(e.imageUrl) ? e.imageUrl : (UNSPLASH_FALLBACK[cat] || UNSPLASH_FALLBACK.default),
      };
    });
  }
  if (parsed.text) parsed.text = stripTags(parsed.text);

  return parsed;
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
        origin: 'live_discovered',
        crawled_at: new Date().toISOString(),
        source_url: event.link || null,
        crawl_source: event.crawlSource || null,
        expires_at: expiresAt,
      }, { onConflict: 'id' });
    } catch (err) {
      console.warn(`Failed to store discovered event "${event.title}":`, err.message);
    }
  }
}

/** Save a chat interaction for scoring — non-blocking, fire-and-forget */
async function saveConversation({ userId, conversationId, query, aiText, events, source, similarityScore }) {
  if (!pgPool) return;
  try {
    const pseudo = userId ? pseudonymize(String(userId)) : null;
    const id = conversationId || crypto.randomUUID();
    await pgPool.query(
      `INSERT INTO chat_conversations (id, user_id, user_message, ai_response, events_returned, source, similarity_score, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        pseudo,
        query,
        aiText || '',
        JSON.stringify((events || []).slice(0, 10).map(e => ({ id: e.id, title: e.title, category: e.category }))),
        source || null,
        similarityScore || null,
      ]
    );
  } catch (err) {
    console.warn('[chat:save-convo] non-fatal:', err.message);
  }
}

// ─── POST /api/chat — Main query endpoint ────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { query, user_id } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const t0 = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8); // short ID to trace one request in logs
  const conversationId = crypto.randomUUID(); // stable ID for this entire request

  const currentDateTime = new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: 'numeric', timeZone: 'America/Los_Angeles',
  });

  console.log(`[chat:${reqId}] START query="${query}"`);

  try {
    // ── ① Cache check ────────────────────────────────────────────────
    console.log(`[chat:${reqId}] STEP 1 — checking cache`);
    const queryHash = hashQuery(query);
    const cached = await checkCache(queryHash);

    if (cached) {
      console.log(`[chat:${reqId}] STEP 1 — cache HIT, returning cached result`);
      const events = await fetchEventsByIds(cached.event_ids);
      sendStreamResult(res, cached.result_text, events, conversationId);
      saveConversation({ userId: user_id, conversationId, query, aiText: cached.result_text, events, source: 'cache' }).catch(() => {});
      trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: Date.now() - t0, statusCode: 200, source: 'cache' });
      return;
    }

    console.log(`[chat:${reqId}] STEP 1 — cache MISS`);

    // Load user preferences in background (non-blocking until needed)
    const userPrefsPromise = loadUserPreferences(user_id);

    // ── ② Parse query constraints (date range, is_free, intent) ──────
    console.log(`[chat:${reqId}] STEP 2 — parsing query constraints`);
    const constraints = parseQueryConstraints(query);
    const { intent, dateFrom, dateTo, isFree, dateLabel } = constraints;
    console.log(`[chat:${reqId}] STEP 2 — intent="${intent}" dateLabel=${dateLabel || 'none'} isFree=${isFree ?? 'any'}`);

    // Capture search intent for personalization (fire-and-forget)
    const inferredCategory = extractQueryCategory(intent || query);
    if (inferredCategory && user_id) {
      upsertUserPreference(user_id, inferredCategory, (intent || query).toLowerCase().trim()).catch(() => {});
    }

    // ── ③ Embed the intent (date/free phrases stripped) ───────────────
    console.log(`[chat:${reqId}] STEP 3 — embedding query via Voyage AI`);
    let queryVector;
    try {
      queryVector = await embedQuery(intent);
      console.log(`[chat:${reqId}] STEP 3 — embedding OK (${queryVector?.length} dims)`);
    } catch (embedErr) {
      console.warn(`[chat:${reqId}] STEP 3 — embedding FAILED: ${embedErr.message} — falling back to chronological`);
      const fallbackEvents = await searchChronological({ ...constraints, dateFrom: constraints.dateFrom || new Date().toISOString() }, 10);
      console.log(`[chat:${reqId}] STEP 3 fallback — chronological returned ${fallbackEvents.length} events`);
      const result = fallbackEvents.length >= 1
        ? await formatWithClaude(query, fallbackEvents, currentDateTime)
        : await discoverWithWebSearch(query, currentDateTime);
      const rawEvents = (result.events || []).map((e, i) => { if (!e.id) e.id = `result-${Date.now()}-${i}`; return e; });
      await saveCache(queryHash, query, rawEvents.map(e => e.id), result.text || '');
      sendStreamResult(res, result.text || 'Checking the local scene...', rawEvents, conversationId);
      saveConversation({ userId: user_id, conversationId, query, aiText: result.text, events: rawEvents, source: 'chronological' }).catch(() => {});
      trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: Date.now() - t0, statusCode: 200, source: 'chronological' });
      return;
    }

    // ── ④ pgvector similarity search with constraints ─────────────────
    console.log(`[chat:${reqId}] STEP 4 — pgvector search (threshold=0.72)`);
    let matchedEvents;
    try {
      matchedEvents = await searchByEmbedding(queryVector, 0.72, 10, constraints);
      console.log(`[chat:${reqId}] STEP 4 — pgvector returned ${matchedEvents.length} events`);
    } catch (pgErr) {
      console.error(`[chat:${reqId}] STEP 4 — pgvector FAILED: ${pgErr.message} — falling back to web search`);
      // pgvector failure: fall through to web search instead of dying
      matchedEvents = [];
    }

    // ── ④a is_free retry: if 0 results with isFree filter → retry without ──
    let usedFreeRetry = false;
    if (matchedEvents.length === 0 && isFree !== undefined) {
      console.log(`[chat:${reqId}] STEP 4a — retrying without is_free filter`);
      try {
        matchedEvents = await searchByEmbedding(queryVector, 0.72, 10, { dateFrom, dateTo });
        usedFreeRetry = true;
        console.log(`[chat:${reqId}] STEP 4a — retry returned ${matchedEvents.length} events`);
      } catch (retryErr) {
        console.error(`[chat:${reqId}] STEP 4a — retry also FAILED: ${retryErr.message}`);
        matchedEvents = [];
      }
    }

    const topSimilarity = matchedEvents[0]?.similarity ?? 0;
    const userPrefs = await userPrefsPromise.catch(() => []);

    if (matchedEvents.length >= 3) {
      const rawEvents = matchedEvents.map((e, i) => { if (!e.id) e.id = `result-${Date.now()}-${i}`; return e; });
      const responseSource = usedFreeRetry ? 'semantic_nofree' : 'semantic';

      if (topSimilarity >= 0.80) {
        // ── Option A: High-confidence — skip Claude entirely (~1.5s saved) ─
        console.log(`[chat:${reqId}] STEP 5 — Option A: skip Claude (similarity=${topSimilarity.toFixed(2)})`);
        const vibeText = buildVibeText(query, rawEvents);
        await saveCache(queryHash, query, rawEvents.map(e => e.id), vibeText);
        const totalMs = Date.now() - t0;
        console.log(`[chat:${reqId}] DONE (Option A) — ${rawEvents.length} events, ${totalMs}ms`);
        sendStreamResult(res, vibeText, rawEvents, conversationId);
        saveConversation({ userId: user_id, conversationId, query, aiText: vibeText, events: rawEvents, source: `${responseSource}_fast`, similarityScore: topSimilarity }).catch(() => {});
        trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: totalMs, statusCode: 200, source: `${responseSource}_fast` });
        return;
      }

      // ── Option B: Good match — stream Claude vibe text, then events ─
      console.log(`[chat:${reqId}] STEP 5 — Option B: stream Claude vibe (similarity=${topSimilarity.toFixed(2)})`);
      // Cache will be saved after streaming completes — fire a deferred save
      const vibeForCache = buildVibeText(query, rawEvents); // placeholder; real vibe arrives after stream
      saveCache(queryHash, query, rawEvents.map(e => e.id), vibeForCache).catch(() => {});
      saveConversation({ userId: user_id, conversationId, query, aiText: vibeForCache, events: rawEvents, source: responseSource, similarityScore: topSimilarity }).catch(() => {});
      const totalMs = Date.now() - t0;
      console.log(`[chat:${reqId}] DONE (Option B stream) — ${rawEvents.length} events, ${totalMs}ms`);
      trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: totalMs, statusCode: 200, source: responseSource });
      await streamVibeWithClaude(query, rawEvents, currentDateTime, res, userPrefs, conversationId);
      return;

    } else {
      // ── ④c Low confidence — try lower threshold ─────────────────────
      console.log(`[chat:${reqId}] STEP 5 — low match count (${matchedEvents.length}), trying broad threshold=0.5`);
      let broadMatches = matchedEvents.length > 0 ? matchedEvents : [];
      if (broadMatches.length === 0) {
        try {
          broadMatches = await searchByEmbedding(queryVector, 0.5, 6, { dateFrom, dateTo });
          console.log(`[chat:${reqId}] STEP 5 — broad search returned ${broadMatches.length} events`);
        } catch (broadErr) {
          console.error(`[chat:${reqId}] STEP 5 — broad search FAILED: ${broadErr.message}`);
          broadMatches = [];
        }
      }

      if (broadMatches.length >= 2) {
        const rawEvents = broadMatches.map((e, i) => { if (!e.id) e.id = `result-${Date.now()}-${i}`; return e; });
        console.log(`[chat:${reqId}] STEP 5 — stream broad match (${rawEvents.length} events)`);
        const broadVibeText = buildVibeText(query, rawEvents);
        saveCache(queryHash, query, rawEvents.map(e => e.id), broadVibeText).catch(() => {});
        saveConversation({ userId: user_id, conversationId, query, aiText: broadVibeText, events: rawEvents, source: 'embedding' }).catch(() => {});
        const totalMs = Date.now() - t0;
        trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: totalMs, statusCode: 200, source: 'embedding' });
        await streamVibeWithClaude(query, rawEvents, currentDateTime, res, userPrefs, conversationId);
        return;
      }

      // ── ④d Live web search fallback ───────────────────────────────
      console.log(`[chat:${reqId}] STEP 5 — no DB match, triggering web search`);
      const wsResult = await discoverWithWebSearch(query, currentDateTime);
      console.log(`[chat:${reqId}] STEP 5 — web search returned ${wsResult?.events?.length ?? 0} events`);
      let rawEvents = (wsResult.events || []).map((e, i) => { if (!e.id) e.id = `result-${Date.now()}-${i}`; return e; });
      if (rawEvents.length > 0) {
        storeDiscoveredEvents(rawEvents).catch(err =>
          console.warn(`[chat:${reqId}] background store error (non-fatal):`, err.message)
        );
      }

      // ── ④e Chronological fallback — never show an empty feed ──────────
      let finalText = wsResult.text || 'Scouting the Seattle scene...';
      if (rawEvents.length === 0) {
        console.log(`[chat:${reqId}] STEP 6 — web search empty, falling back to chronological`);
        try {
          const fallbackEvents = await searchChronological({ dateFrom: new Date().toISOString() }, 8);
          if (fallbackEvents.length > 0) {
            rawEvents = fallbackEvents;
            const noResultLine = wsResult.text ? `${wsResult.text} ` : '';
            finalText = `${noResultLine}Here's what's coming up in Seattle:`;
            console.log(`[chat:${reqId}] STEP 6 — chronological fallback returned ${rawEvents.length} events`);
          }
        } catch (fallbackErr) {
          console.warn(`[chat:${reqId}] STEP 6 — chronological fallback failed: ${fallbackErr.message}`);
        }
      }

      await saveCache(queryHash, query, rawEvents.map(e => e.id), finalText);
      const totalMs = Date.now() - t0;
      console.log(`[chat:${reqId}] DONE (websearch) — ${rawEvents.length} events, ${totalMs}ms`);
      sendStreamResult(res, finalText, rawEvents, conversationId);
      saveConversation({ userId: user_id, conversationId, query, aiText: finalText, events: rawEvents, source: 'websearch' }).catch(() => {});
      trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: totalMs, statusCode: 200, source: 'websearch' });
      return;
    }

  } catch (error) {
    const totalMs = Date.now() - t0;
    console.error(`[chat:${reqId}] FATAL ERROR after ${totalMs}ms — ${error?.constructor?.name}: ${error?.message}`);
    console.error(`[chat:${reqId}] Stack:`, error?.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI service unavailable', text: 'Connection bumpy. Try again?', events: [] });
    } else {
      // Stream already started — write error as stream and close cleanly
      try { sendStreamResult(res, 'Connection bumpy. Try again?', []); } catch (_) {}
    }
    trackRequest({ endpoint: '/api/chat', userId: user_id || null, responseTimeMs: totalMs, statusCode: 500, source: null });
  }
});

// ─── POST /api/feedback — Thumbs up/down for a chat response ─────────
// Body: { conversationId, score: 'helpful'|'not_helpful', user_id? }

app.post('/api/feedback', async (req, res) => {
  const { conversationId, score, user_id } = req.body;
  const validScores = ['helpful', 'not_helpful'];
  if (!conversationId || !validScores.includes(score)) {
    return res.status(400).json({ error: 'conversationId and score (helpful|not_helpful) required' });
  }
  if (!pgPool) return res.status(503).json({ error: 'DB not configured' });

  try {
    const pseudo = user_id ? pseudonymize(String(user_id)) : null;
    await pgPool.query(`
      INSERT INTO chat_scores
        (conversation_id, score_type, score, scored_by, scored_at, user_id)
      VALUES ($1, 'user_feedback', $2, 'user', NOW(), $3)
      ON CONFLICT (conversation_id, score_type) DO UPDATE SET
        score     = EXCLUDED.score,
        scored_at = NOW()
    `, [conversationId, score, pseudo]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] error:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
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

// ─── Saved Events — direct pg (no Supabase SDK, portable to AWS RDS) ───────────
// Requires DATABASE_URL env var (Supabase Transaction Pooler connection string).
// Falls back to 503 with a clear message when DATABASE_URL is not set so the
// frontend localStorage-only path keeps working for guests.

function savedEventsUnavailable(res) {
  return res.status(503).json({ error: 'DATABASE_URL not configured — saved events unavailable on server' });
}

// POST /api/saved-events — save an event for a user
app.post('/api/saved-events', async (req, res) => {
  if (!pgPool) return savedEventsUnavailable(res);
  const { user_id, event_id, event_payload, source_url } = req.body;
  if (!user_id || !event_id || !event_payload) {
    return res.status(400).json({ error: 'user_id, event_id and event_payload are required' });
  }
  try {
    await pgPool.query(
      `INSERT INTO kickflip_saved_events (user_id, event_id, event_payload, source_url, saved_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, event_id)
       DO UPDATE SET event_payload = EXCLUDED.event_payload,
                     source_url    = EXCLUDED.source_url,
                     saved_at      = NOW()`,
      [user_id, event_id, JSON.stringify(event_payload), source_url || event_payload?.link || null]
    );
    return res.status(201).json({ success: true, event_id });
  } catch (err) {
    console.error('[saved-events] save error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/saved-events/:eventId — unsave an event for a user
app.delete('/api/saved-events/:eventId', async (req, res) => {
  if (!pgPool) return savedEventsUnavailable(res);
  const { eventId } = req.params;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required in request body' });
  try {
    await pgPool.query(
      'DELETE FROM kickflip_saved_events WHERE user_id = $1 AND event_id = $2',
      [user_id, eventId]
    );
    return res.json({ success: true, event_id: eventId });
  } catch (err) {
    console.error('[saved-events] delete error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/saved-events?user_id=xxx — list a user's saved events
// Returns only future / ongoing events (start_date >= today, or date unknown).
app.get('/api/saved-events', async (req, res) => {
  if (!pgPool) return savedEventsUnavailable(res);
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
  try {
    const { rows } = await pgPool.query(
      'SELECT event_id, event_payload, source_url, saved_at FROM kickflip_saved_events WHERE user_id = $1 ORDER BY saved_at DESC',
      [user_id]
    );
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const active = rows.filter(row => {
      const d = resolveEventStartDate(row.event_payload);
      return d === null || d >= now;
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
  } catch (err) {
    console.error('[saved-events] fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
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
// ─── GET /api/events — Live feed of active crawled events ────────────
//
// Returns up to 150 upcoming events from Supabase ordered by start_time.
// Frontend uses this to replace the hardcoded FEATURED_EVENTS on mount.
// Falls back to FEATURED_EVENTS client-side if this endpoint is unavailable.

app.get('/api/events', async (_req, res) => {
  try {
    const now = new Date().toISOString();
    // Select both the legacy payload blob (Node.js crawler) AND individual
    // columns (Ravi's Python crawler).  Events from either crawler are
    // normalized below into the same KickflipEvent shape.
    const { data, error } = await supabase
      .from('kickflip_events')
      .select('id, payload, image_url, start_time, title, venue, address, city, price, is_free, ticket_url, source_url, source_name, categories, event_summary, description, vibe_tags, origin')
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('start_time', { ascending: true, nullsFirst: false })
      .limit(150);

    if (error) throw new Error(error.message);

    // Helper: reject placeholder / null-ish string values
    const realStr = (v) => (v && typeof v === 'string' && !/^(\$?null|tbd|n\/a|unknown|undefined)$/i.test(v.trim()) && v.trim() !== '') ? v.trim() : null;

    // Helper: strip any HTML/XML tags (e.g. <cite index="9-12"> from web_search)
    const stripTags = (v) => (typeof v === 'string') ? v.replace(/<[^>]+>/g, '').trim() : v;

    const UNSPLASH = UNSPLASH_FALLBACK; // use module-level map

    const events = (data || []).map(row => {
      const p = row.payload || {};

      // ── Category (needed before image fallback) ───────────────────────────
      let category = p.category;
      if (!category) {
        const cats = typeof row.categories === 'string' ? JSON.parse(row.categories || '[]') : (row.categories || []);
        if (Array.isArray(cats) && cats.length > 0) category = cats[0].toLowerCase();
      }
      category = category || 'other';

      // ── Image — DB column → payload → Unsplash fallback by category ───────
      // isValidImageUrl guards against "null", "undefined", empty strings stored in DB
      const imageUrl = (isValidImageUrl(row.image_url) ? row.image_url : null)
        || (isValidImageUrl(p.imageUrl) ? p.imageUrl : null)
        || UNSPLASH[category] || UNSPLASH.default;

      // ── Price — filter "$NULL", "null", "TBD", empty ─────────────────────
      const price = realStr(p.price ?? row.price) || undefined;

      // ── Venue / location ─────────────────────────────────────────────────
      const locationName = realStr(p.locationName) || realStr(p.location) || realStr(row.venue) || null;

      // ── Address — filter "TBD" so the map doesn't query that literal string
      const address = realStr(p.address) || realStr(row.address) || null;

      // ── CTA link ─────────────────────────────────────────────────────────
      const link = p.link || row.ticket_url || row.source_url || null;

      // ── Date / time — from payload strings or start_time timestamp ────────
      let startDate = p.startDate;
      let startTime = p.startTime;
      if (!startDate && row.start_time) {
        const dt = new Date(row.start_time);
        startDate = dt.toISOString().split('T')[0];
        // HH:MM in local-ish format (good enough for display)
        startTime = dt.toTimeString().slice(0, 5);
      }

      // ── Vibe tags ────────────────────────────────────────────────────────
      const vibeTags = p.vibeTags
        || (typeof row.vibe_tags === 'string' ? JSON.parse(row.vibe_tags || '[]') : (row.vibe_tags || []))
        || [];

      // ── Text fields — strip any lingering <cite> tags from web_search ───────
      const description = stripTags(p.description || p.vibeDescription || row.event_summary || row.description || '');
      const crawlSource = p.crawlSource || row.source_name || null;
      const organizer = p.organizer || null;
      const city = p.city || row.city || 'Seattle';

      // ── Origin — normalize to 'crawl' so EventCard CTA logic fires ───────
      const origin = (p.origin === 'user') ? 'user' : 'crawl';

      return {
        id:           row.id,
        title:        stripTags(p.title || row.title || ''),
        category,
        price,
        imageUrl,
        link,
        startDate,
        startTime,
        date:         p.date || startDate || '',
        location:     locationName || city,
        locationName,
        address,
        city,
        description,
        vibeTags,
        organizer,
        crawlSource,
        origin,
        overview:     p.overview || null,
      };
    });

    res.json({ events });
  } catch (err) {
    console.error('[GET /api/events] Error:', err.message);
    res.status(500).json({ error: err.message, events: [] });
  }
});

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

// ─── POST /api/score-chats — Daily LLM auto-scorer ───────────────────
//
// Fetches all unscored conversations from the last 48 h and asks Claude
// to rate each as "helpful" | "somewhat_helpful" | "not_helpful".
// Scores + reasons are stored in chat_scores.
//
// Run via Railway cron:  POST /api/score-chats  (daily at 2 am Seattle)
// Or manually:           curl -X POST ... -H "Authorization: Bearer <CRON_SECRET>"
//
// Response:
//   { scored, helpful, somewhat_helpful, not_helpful, helpfulness_pct, on_track }
//   on_track = helpfulness_pct >= 90  (the team's target)

app.post('/api/score-chats', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!pgPool) {
    return res.status(503).json({ error: 'DATABASE_URL not configured — chat scoring unavailable' });
  }

  try {
    // Fetch up to 100 unscored conversations from the last 48 h
    const { rows: convos } = await pgPool.query(`
      SELECT c.id, c.user_message, c.ai_response, c.events_returned, c.source, c.similarity_score
      FROM   chat_conversations c
      WHERE  c.created_at > NOW() - INTERVAL '48 hours'
        AND  NOT EXISTS (
               SELECT 1 FROM chat_scores s
               WHERE  s.conversation_id = c.id
                 AND  s.score_type = 'llm_auto'
             )
      ORDER  BY c.created_at DESC
      LIMIT  100
    `);

    if (convos.length === 0) {
      return res.json({ scored: 0, message: 'No unscored conversations in the last 48 h' });
    }

    console.log(`[score-chats] Scoring ${convos.length} conversations`);

    const SCORING_SYSTEM = `You score an AI event-discovery assistant. Return JSON only — no prose.
Format: {"score": "helpful" | "somewhat_helpful" | "not_helpful", "reason": "one sentence"}

Rubric:
- "helpful": Events clearly match the user's query intent (right vibe, right city, relevant category/date)
- "somewhat_helpful": Partially relevant — some events match but key criteria were missed (wrong category, wrong date, vague)
- "not_helpful": Events do not match the query, wrong city, no events returned, or a generic error message`;

    let scored = 0, helpful = 0, somewhat = 0, notHelpful = 0;

    for (const convo of convos) {
      try {
        const eventsSnippet = JSON.stringify(convo.events_returned || []);
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: SCORING_SYSTEM,
          messages: [{
            role: 'user',
            content: `USER QUERY: "${convo.user_message}"
AI RESPONSE TEXT: "${convo.ai_response}"
EVENTS RETURNED: ${eventsSnippet}
SEARCH METHOD: ${convo.source || 'unknown'}`,
          }],
        });

        const raw = msg.content[0]?.text || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) continue;

        let parsed;
        try { parsed = JSON.parse(match[0]); } catch { continue; }

        const score = ['helpful', 'somewhat_helpful', 'not_helpful'].includes(parsed.score)
          ? parsed.score : 'not_helpful';

        await pgPool.query(
          `INSERT INTO chat_scores
             (conversation_id, score_type, score, score_reason, scored_by, scored_at)
           VALUES ($1, 'llm_auto', $2, $3, $4, NOW())
           ON CONFLICT (conversation_id, score_type)
           DO UPDATE SET score        = EXCLUDED.score,
                         score_reason = EXCLUDED.score_reason,
                         scored_at    = NOW()`,
          [convo.id, score, parsed.reason || null, 'claude-haiku-4-5-20251001']
        );

        scored++;
        if      (score === 'helpful')           helpful++;
        else if (score === 'somewhat_helpful')  somewhat++;
        else                                    notHelpful++;

      } catch (err) {
        console.warn(`[score-chats] failed on convo ${convo.id}:`, err.message);
      }
    }

    const helpfulnessPct = scored > 0 ? Math.round(100 * helpful / scored) : 0;
    console.log(`[score-chats] Done — ${scored} scored, ${helpfulnessPct}% helpful`);

    return res.json({
      scored,
      helpful,
      somewhat_helpful: somewhat,
      not_helpful:      notHelpful,
      helpfulness_pct:  helpfulnessPct,
      target_pct:       90,
      on_track:         helpfulnessPct >= 90,
    });

  } catch (err) {
    console.error('[score-chats] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`KickflipEvents backend running on port ${port}`);
});
