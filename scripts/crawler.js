/**
 * crawler.js
 * Daily batch crawler — uses Claude web_search to find real Seattle events.
 *
 * Configuration: edit crawl-sources.yaml at the repo root to control which
 * sites are searched, the date window, and batch size.
 *
 * Run on demand: POST /api/crawl  Authorization: Bearer <CRON_SECRET>
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { jsonrepair } from 'jsonrepair';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { embedBatch } from '../services/embeddingService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load config from crawl-sources.yaml ─────────────────────────────────────

function loadConfig() {
  const configPath = resolve(__dirname, '../crawl-sources.yaml');
  try {
    const raw = readFileSync(configPath, 'utf8');
    return yaml.load(raw);
  } catch (err) {
    console.warn('[crawler] Could not read crawl-sources.yaml, using defaults:', err.message);
    return {
      settings: { date_window_days: 14, batch_size: 3, max_sources_per_run: 10 },
      sources: [
        { name: 'Eventbrite Seattle', domain: 'eventbrite.com', category: 'all', enabled: true, priority: 1 },
        { name: 'The Stranger',       domain: 'thestranger.com', category: 'music,art,comedy', enabled: true, priority: 2 },
      ],
    };
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getWindowBounds(windowDays) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + windowDays);
  return { windowStart: now, windowEnd: end };
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

function isWithinWindow(event, windowStart, windowEnd) {
  if (!event.startDate || event.startDate === 'See Website') {
    return { valid: true, reason: 'undated' };
  }
  const d = new Date(event.startDate);
  if (isNaN(d.getTime())) return { valid: true, reason: 'unparseable' };
  if (d < windowStart) return { valid: false, reason: `past (${event.startDate})` };
  if (d > windowEnd)   return { valid: false, reason: `beyond window (${event.startDate})` };
  return { valid: true, reason: 'in-window' };
}

// ─── Build search prompt for a batch of sources ───────────────────────────────

function buildBatchPrompt(sources, todayStr, windowEndStr) {
  const siteNames = sources.map(s => s.name).join(', ');
  const domainList = sources.map(s => s.domain).join(', ');

  return {
    name: siteNames,
    prompt: `Search for real upcoming Seattle events from ${todayStr} through ${windowEndStr}.

Search these specific websites for event listings: ${domainList}

For each site, search for "Seattle events" or browse their event calendar pages directly.

Return a JSON array of ALL events you find:
[{
  "id": "crawl-<slugified-title>-<YYYYMMDD>",
  "title": "Event Title",
  "date": "Sat, Mar 1 2026",
  "startDate": "2026-03-01",
  "startTime": "8:00 PM",
  "location": "Venue Name, Seattle WA",
  "description": "2-3 sentences about the event vibe and what to expect",
  "category": "music",
  "vibeTags": ["#live", "#indie"],
  "price": "$25",
  "link": "https://real-event-url.com",
  "organizer": "Organizer Name",
  "origin": "crawl",
  "crawlSource": "${siteNames}"
}]

Rules:
- Only include events dated from ${todayStr} to ${windowEndStr}
- Use real URLs from your search results — not example.com
- category must be one of: music, art, food, outdoor, comedy, wellness, sports, party, other
- Return ONLY the JSON array, no markdown, no explanation`,
  };
}

// ─── Run one Claude web_search call ───────────────────────────────────────────

async function searchWithClaude(search) {
  console.log(`\n  🔍 Searching: "${search.name}"...`);

  const conversationMessages = [{ role: 'user', content: search.prompt }];
  let finalText = '';
  const MAX_TURNS = 8;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`  [turn ${turn + 1}] calling Claude...`);
    const response = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: conversationMessages,
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } }
    );

    const blockTypes = response.content.map(b => b.type).join(', ');
    console.log(`  [turn ${turn + 1}] stop_reason=${response.stop_reason} blocks=[${blockTypes}]`);

    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) finalText = textBlocks.map(b => b.text).join('');

    console.log(`  [turn ${turn + 1}] finalText length=${finalText.length} preview="${finalText.slice(0, 120).replace(/\n/g, ' ')}"`);

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      conversationMessages.push({ role: 'assistant', content: response.content });
      // For the built-in web_search tool, results are already embedded in the
      // assistant message (web_search_tool_result_20250305 blocks). DO NOT
      // resend the full result content — that doubles the token count and blows
      // through the 50K/min input rate limit. Just ACK each tool_use call.
      const toolResults = response.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: 'Search complete.',
        }));
      if (toolResults.length > 0) {
        conversationMessages.push({ role: 'user', content: toolResults });
        // On the penultimate turn, nudge Claude to stop searching and output JSON
        if (turn === MAX_TURNS - 2) {
          conversationMessages.push({ role: 'user', content: 'Good, now compile all events you found into the JSON array. Output ONLY the JSON array, nothing else.' });
        }
      } else break;
    } else break;
  }

  const jsonMatch = finalText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn(`  ⚠️  No JSON array in response for "${search.name}". Full text: "${finalText.slice(0, 300)}"`);
    return [];
  }
  try {
    const events = JSON.parse(jsonMatch[0]);
    console.log(`  ✅ "${search.name}": ${events.length} events found`);
    return events;
  } catch (err) {
    console.warn(`  ⚠️  JSON parse failed, attempting repair for "${search.name}": ${err.message}`);
    try {
      const repaired = jsonrepair(jsonMatch[0]);
      const events = JSON.parse(repaired);
      console.log(`  ✅ "${search.name}": ${events.length} events found (after repair)`);
      return events;
    } catch (repairErr) {
      console.warn(`  ❌  Repair also failed for "${search.name}": ${repairErr.message}`);
      return [];
    }
  }
}

// ─── Deduplicate by title + date ──────────────────────────────────────────────

function deduplicate(events) {
  const seen = new Map();
  return events.filter(event => {
    const key = `${(event.title || '').toLowerCase().trim()}__${event.startDate || ''}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ─── Upsert with embeddings ───────────────────────────────────────────────────

async function upsertEvents(events, vectors, windowEnd) {
  const expiresAt = new Date(windowEnd);
  expiresAt.setDate(expiresAt.getDate() + 1);

  let stored = 0, duplicates = 0, errors = 0;
  const storedTitles = [];
  let firstError = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const embedding = vectors[i];

    if (!event.id) {
      const slug = (event.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const dateSlug = (event.startDate || 'undated').replace(/-/g, '');
      event.id = `crawl-${slug}-${dateSlug}`;
    }

    const row = {
      id:          event.id,
      title:       event.title || 'Untitled Event',
      category:    event.category || 'other',
      payload:     event,
      embedding,
      origin:      'crawl',
      is_active:   true,
      crawled_at:  new Date().toISOString(),
      source_url:  event.link || null,
      crawl_source: event.crawlSource || null,
      expires_at:  expiresAt.toISOString(),
    };

    const { error } = await supabase
      .from('kickflip_events')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      if (error.code === '23505') {
        duplicates++;
      } else {
        console.error(`  ❌ "${event.title}": ${error.message} (code: ${error.code})`);
        if (!firstError) firstError = `${error.message} (code: ${error.code})`;
        errors++;
      }
    } else {
      stored++;
      storedTitles.push(`  • ${event.title} (${event.date || event.startDate || 'undated'}) — ${event.category}`);
    }
  }

  return { stored, duplicates, errors, storedTitles, firstError };
}

// ─── Main crawl ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} [opts.batch]  — if set, only run sources with this batch label
 *                                 e.g. "ticketing" | "media" | "venues" | "extra"
 *                                 omit to run all enabled sources
 */
export async function runCrawl({ batch: batchFilter } = {}) {
  const startTime = Date.now();

  // Load config fresh on each run (picks up YAML edits without restart)
  const config = loadConfig();
  const { date_window_days = 14, batch_size = 3, max_sources_per_run = 10 } = config.settings || {};

  // Filter to enabled sources, optionally by batch label, sort by priority, cap
  const enabledSources = (config.sources || [])
    .filter(s => s.enabled !== false)
    .filter(s => !batchFilter || s.batch === batchFilter)
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .slice(0, max_sources_per_run);

  const { windowStart, windowEnd } = getWindowBounds(date_window_days);
  const todayStr     = formatDate(windowStart);
  const windowEndStr = formatDate(windowEnd);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║          Kickflip Event Crawler              ║');
  console.log(`║  Window : ${todayStr.slice(0,10)} → ${windowEndStr.slice(0,10)} (${date_window_days}d)   ║`);
  console.log(`║  Filter : batch=${batchFilter || 'all'}                    ║`);
  console.log(`║  Sources: ${enabledSources.length} enabled (cap: ${max_sources_per_run})              ║`);
  console.log(`║  Batches: ${batch_size} sources/call                      ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('\nEnabled sources:');
  enabledSources.forEach(s => console.log(`  [${s.priority}] ${s.name} (${s.domain})`));

  // Batch sources into groups of batch_size
  const batches = [];
  for (let i = 0; i < enabledSources.length; i += batch_size) {
    batches.push(enabledSources.slice(i, i + batch_size));
  }

  // Step 1: Run searches
  console.log(`\n🔍 STEP 1: Running ${batches.length} search batch(es)...`);
  let allCandidates = [];

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      // Spread calls across time to stay under Haiku's 50K input tokens/min limit.
      // Each multi-turn web search conversation can be 10–20K tokens.
      console.log(`  ⏳ Waiting 15s before next batch (rate limit spacing)...`);
      await new Promise(r => setTimeout(r, 15_000));
    }
    const search = buildBatchPrompt(batches[i], todayStr, windowEndStr);
    const results = await searchWithClaude(search);
    allCandidates.push(...results);
  }

  console.log(`\n  → Total candidates: ${allCandidates.length}`);

  // Step 2: Deduplicate
  console.log('\n🔄 STEP 2: Deduplicating...');
  const unique = deduplicate(allCandidates);
  console.log(`  → ${unique.length} unique (removed ${allCandidates.length - unique.length} duplicates)`);

  // Step 3: Filter to window
  console.log('\n🗓️  STEP 3: Filtering to date window...');
  const validEvents = [];
  const rejectedEvents = [];

  for (const event of unique) {
    const { valid, reason } = isWithinWindow(event, windowStart, windowEnd);
    if (valid) {
      validEvents.push(event);
    } else {
      rejectedEvents.push(`  ✗ "${event.title}" — ${reason}`);
    }
  }

  console.log(`  → ${validEvents.length} pass filter, ${rejectedEvents.length} rejected`);

  if (validEvents.length === 0) {
    console.log('\n⚠️  No valid events to store.');
    return {
      eventsFound: allCandidates.length, eventsRejected: rejectedEvents.length,
      eventsFiltered: 0, eventsStored: 0, duplicates: 0, errors: 0,
      sourcesRun: enabledSources.length, durationMs: Date.now() - startTime,
    };
  }

  // Step 4: Generate embeddings (non-fatal — events stored with null embedding if this fails)
  console.log(`\n🧠 STEP 4: Generating Voyage AI embeddings for ${validEvents.length} events...`);
  let vectors;
  try {
    vectors = await embedBatch(validEvents);
  } catch (embedErr) {
    console.warn(`  ⚠️  Embedding failed (${embedErr.message}) — storing events without embeddings. Run /api/seed to backfill.`);
    vectors = new Array(validEvents.length).fill(null);
  }

  // Step 5: Upsert
  console.log(`\n💾 STEP 5: Storing ${validEvents.length} events in Supabase...`);
  const { stored, duplicates, errors, storedTitles, firstError } = await upsertEvents(validEvents, vectors, windowEnd);

  // Step 6: Clean expired cache
  console.log('\n🧹 STEP 6: Cleaning expired query cache...');
  const { error: cleanupErr } = await supabase.rpc('cleanup_expired_cache');
  if (cleanupErr) console.warn('  ⚠️  Cache cleanup:', cleanupErr.message);
  else console.log('  ✅ Cache cleaned');

  const durationMs = Date.now() - startTime;

  console.log('\n══════════════════════════════════════════════');
  console.log('✅ CRAWL COMPLETE');
  console.log(`   Sources run      : ${enabledSources.length} (${batches.length} batch calls)`);
  console.log(`   Date window      : ${date_window_days} days`);
  console.log(`   Events found     : ${allCandidates.length}`);
  console.log(`   After dedupe     : ${unique.length}`);
  console.log(`   After date filter: ${validEvents.length}`);
  console.log(`   ── Stored new    : ${stored} (with embeddings)`);
  console.log(`   ── Updated exist : ${duplicates}`);
  console.log(`   ── Errors        : ${errors}`);
  console.log(`   Duration         : ${(durationMs / 1000).toFixed(1)}s`);
  console.log('══════════════════════════════════════════════');

  if (storedTitles.length > 0) {
    console.log('\n📋 Events stored:');
    storedTitles.forEach(t => console.log(t));
  }

  return {
    eventsFound: allCandidates.length,
    eventsUnique: unique.length,
    eventsRejected: rejectedEvents.length,
    eventsFiltered: validEvents.length,
    eventsStored: stored,
    embeddingsGenerated: vectors.filter(Boolean).length,
    duplicates,
    errors,
    firstError: firstError || null,
    sourcesRun: enabledSources.length,
    durationMs,
    storedEvents: storedTitles,
  };
}

// Direct execution: node scripts/crawler.js
if (process.argv[1]?.includes('crawler.js')) {
  runCrawl().catch(err => {
    console.error('Crawl failed:', err);
    process.exit(1);
  });
}
