/**
 * crawler.js
 * Daily batch crawler for Seattle events — 7-day forward window only.
 *
 * Rules:
 *  - Only future events (today → +7 days)
 *  - Past or expired events are rejected before storage
 *  - Each event gets a Voyage AI embedding stored once in Supabase
 *  - Duplicate events (same id or same title+date) are upserted, not duplicated
 *  - Returns a detailed summary: { eventsFound, eventsStored, eventsDuplicate, eventsRejected, errors }
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { embedBatch } from '../services/embeddingService.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Only keep events for the next 7 days
const WINDOW_DAYS = 7;

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────

function getWindowBounds() {
  const now = new Date();
  now.setHours(0, 0, 0, 0); // start of today Seattle time
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);
  return { windowStart: now, windowEnd };
}

/**
 * Returns true if the event's startDate is within today → +7 days.
 * Accepts YYYY-MM-DD format. If startDate is missing/unknown, allows it through
 * with a flag so Claude can still use it (undated events like "See Calendar").
 */
function isWithinWindow(event, windowStart, windowEnd) {
  if (!event.startDate || event.startDate === 'See Website' || event.startDate === '') {
    return { valid: true, reason: 'undated' };
  }
  const d = new Date(event.startDate);
  if (isNaN(d.getTime())) return { valid: true, reason: 'unparseable-date' };
  if (d < windowStart) return { valid: false, reason: `past (${event.startDate})` };
  if (d > windowEnd) return { valid: false, reason: `beyond-7-days (${event.startDate})` };
  return { valid: true, reason: 'in-window' };
}

// ─────────────────────────────────────────────
// CRAWL SOURCES
// ─────────────────────────────────────────────

const SOURCES = [
  {
    name: 'Eventbrite Seattle',
    url: 'https://www.eventbrite.com/d/wa--seattle/events/',
  },
  {
    name: 'Seattle.gov Events',
    url: 'https://www.seattle.gov/neighborhoods/programs-and-services/events',
  },
  {
    name: 'Resident Advisor Seattle',
    url: 'https://ra.co/events/us/seattle',
  },
  {
    name: 'The Stranger Events',
    url: 'https://www.thestranger.com/events',
  },
];

// ─────────────────────────────────────────────
// FETCH RAW HTML
// ─────────────────────────────────────────────

async function fetchSource(source) {
  try {
    console.log(`  📡 Fetching: ${source.name}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KickflipBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`  ⚠️  ${source.name}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 15000);

    console.log(`  ✅ ${source.name}: ${cleaned.length} chars`);
    return { source, text: cleaned };
  } catch (err) {
    console.warn(`  ❌ ${source.name} failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// STRUCTURE WITH CLAUDE (1 call for all sources)
// ─────────────────────────────────────────────

async function structureWithClaude(rawResults, windowStart, windowEnd) {
  const todayStr = windowStart.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
  const windowEndStr = windowEnd.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const combinedText = rawResults
    .map(r => `=== SOURCE: ${r.source.name} (${r.source.url}) ===\n${r.text}`)
    .join('\n\n');

  const prompt = `You are a data extraction assistant for Kickflip, a Seattle event discovery app.

TODAY: ${todayStr} (Seattle Time)
EXTRACT ONLY events happening between TODAY and ${windowEndStr} (next 7 days).
DO NOT include past events or events beyond 7 days from today.

Extract ALL upcoming events within this 7-day window from the raw text below.

RULES:
- Only include events happening today through ${windowEndStr}
- Skip any event with a past date
- Extract as many events as possible — do not skip events in the window
- category must be one of: music, food, art, party, outdoor, wellness, fashion, sports, comedy, other
- vibeTags must be an array of hashtag strings like ["#music", "#live"]
- startDate must be YYYY-MM-DD format (e.g. "2026-03-01")
- If exact date is unclear but within the window, write today's date as startDate
- link must be the real event URL if visible, otherwise the source URL
- price: use "Free" if free, "$X" if known, "Varies" if unclear
- id must be unique: use "crawl-<slug>-<YYYYMMDD>" format

RESPOND WITH VALID JSON ONLY — a flat array of event objects:
[
  {
    "id": "crawl-event-slug-20260301",
    "title": "Event Title",
    "date": "Sun, Mar 1 2026",
    "startDate": "2026-03-01",
    "startTime": "7:00 PM",
    "location": "Venue Name, Seattle",
    "description": "2-3 sentence description of the event vibe",
    "category": "music",
    "vibeTags": ["#live", "#indie"],
    "price": "$25",
    "link": "https://...",
    "organizer": "Organizer Name",
    "origin": "crawl",
    "crawlSource": "Source Name"
  }
]

RAW EVENT DATA:
${combinedText}`;

  try {
    console.log('\n🤖 Structuring with Claude (1 call for all sources)...');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in Claude response');

    const events = JSON.parse(jsonMatch[0]);
    console.log(`  ✅ Claude extracted ${events.length} candidate events`);
    return events;
  } catch (err) {
    console.error(`  ❌ Claude structuring failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
// UPSERT WITH EMBEDDINGS INTO SUPABASE
// ─────────────────────────────────────────────

async function upsertEvents(events, vectors, windowEnd) {
  // Events expire the day after the window closes
  const expiresAt = new Date(windowEnd);
  expiresAt.setDate(expiresAt.getDate() + 1);

  let stored = 0;
  let duplicates = 0;
  let errors = 0;
  const storedTitles = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const embedding = vectors[i];

    const row = {
      id: event.id,
      title: event.title,
      category: event.category || 'other',
      payload: event,
      embedding,
      crawled_at: new Date().toISOString(),
      source_url: event.link || null,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('kickflip_events')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      // Conflict on existing id = duplicate update (not a real error)
      if (error.code === '23505') {
        duplicates++;
      } else {
        console.error(`  ❌ "${event.title}": ${error.message}`);
        errors++;
      }
    } else {
      stored++;
      storedTitles.push(`  • ${event.title} (${event.date || event.startDate || 'undated'}) — ${event.category}`);
    }
  }

  return { stored, duplicates, errors, storedTitles };
}

// ─────────────────────────────────────────────
// MAIN CRAWL FUNCTION
// ─────────────────────────────────────────────

export async function runCrawl() {
  const startTime = Date.now();
  const { windowStart, windowEnd } = getWindowBounds();

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║       Kickflip Daily Event Crawler       ║');
  console.log(`║  ${new Date().toISOString()}   ║`);
  console.log(`║  Window: today → +${WINDOW_DAYS} days              ║`);
  console.log('╚══════════════════════════════════════════╝\n');

  // Step 1: Fetch all sources in parallel
  console.log('📡 STEP 1: Fetching sources...');
  const rawResults = (await Promise.all(SOURCES.map(fetchSource))).filter(Boolean);
  console.log(`  → ${rawResults.length}/${SOURCES.length} sources returned data\n`);

  if (rawResults.length === 0) {
    return { eventsFound: 0, eventsFiltered: 0, eventsStored: 0, duplicates: 0, errors: 0, sourcesFetched: 0, durationMs: Date.now() - startTime };
  }

  // Step 2: Claude structures all sources in 1 LLM call
  console.log('🤖 STEP 2: Structuring with Claude...');
  const candidates = await structureWithClaude(rawResults, windowStart, windowEnd);

  // Step 3: Filter — keep only future events within 7-day window
  console.log('\n🗓️  STEP 3: Filtering to 7-day future window...');
  const validEvents = [];
  const rejectedEvents = [];

  for (const event of candidates) {
    const { valid, reason } = isWithinWindow(event, windowStart, windowEnd);
    if (valid) {
      validEvents.push(event);
    } else {
      rejectedEvents.push(`  ✗ "${event.title}" — ${reason}`);
    }
  }

  console.log(`  → ${validEvents.length} events in window`);
  console.log(`  → ${rejectedEvents.length} events rejected (past or too far ahead)`);
  if (rejectedEvents.length > 0) {
    rejectedEvents.slice(0, 5).forEach(r => console.log(r));
    if (rejectedEvents.length > 5) console.log(`  ... and ${rejectedEvents.length - 5} more`);
  }

  if (validEvents.length === 0) {
    console.log('\n⚠️  No valid events to store after filtering.');
    return { eventsFound: candidates.length, eventsFiltered: 0, eventsStored: 0, duplicates: 0, errors: 0, sourcesFetched: rawResults.length, durationMs: Date.now() - startTime };
  }

  // Step 4: Generate embeddings in batch (1 Voyage AI call)
  console.log(`\n🧠 STEP 4: Generating embeddings for ${validEvents.length} events...`);
  const vectors = await embedBatch(validEvents);

  // Step 5: Upsert into Supabase
  console.log(`\n💾 STEP 5: Storing in Supabase...`);
  const { stored, duplicates, errors, storedTitles } = await upsertEvents(validEvents, vectors, windowEnd);

  // Step 6: Clean expired query cache
  console.log('\n🧹 STEP 6: Cleaning expired query cache...');
  const { error: cleanupErr } = await supabase.rpc('cleanup_expired_cache');
  if (cleanupErr) console.warn('  ⚠️  Cache cleanup warning:', cleanupErr.message);
  else console.log('  ✅ Cache cleaned');

  const durationMs = Date.now() - startTime;

  // Final report
  console.log('\n══════════════════════════════════════════');
  console.log('✅ CRAWL COMPLETE');
  console.log(`   Sources fetched  : ${rawResults.length}/${SOURCES.length}`);
  console.log(`   Events extracted : ${candidates.length}`);
  console.log(`   Events rejected  : ${rejectedEvents.length} (past/out-of-window)`);
  console.log(`   Events in window : ${validEvents.length}`);
  console.log(`   ── Newly stored  : ${stored} (with embeddings)`);
  console.log(`   ── Duplicates    : ${duplicates} (updated in place)`);
  console.log(`   ── Errors        : ${errors}`);
  console.log(`   Duration         : ${(durationMs / 1000).toFixed(1)}s`);
  console.log('══════════════════════════════════════════');

  if (storedTitles.length > 0) {
    console.log('\n📋 New events stored:');
    storedTitles.forEach(t => console.log(t));
  }

  return {
    eventsFound: candidates.length,
    eventsRejected: rejectedEvents.length,
    eventsFiltered: validEvents.length,
    eventsStored: stored,
    duplicates,
    errors,
    sourcesFetched: rawResults.length,
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
