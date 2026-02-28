/**
 * crawler.js
 * Daily batch crawler — uses Claude web_search to find real Seattle events.
 *
 * Why web_search instead of raw HTML fetch:
 * Most event sites (Eventbrite, RA, Axs) are JS-rendered — a plain fetch
 * returns an empty shell. Claude's built-in web_search handles this correctly.
 *
 * Strategy: 3 targeted searches covering the main Seattle event categories.
 * Each search = 1 Claude call with web_search tool.
 * Results are deduplicated, date-filtered, embedded, and stored in Supabase.
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

const WINDOW_DAYS = 7;

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────

function getWindowBounds() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + WINDOW_DAYS);
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

// ─────────────────────────────────────────────
// SEARCH QUERIES — 2 targeted Claude+web_search calls
// ─────────────────────────────────────────────

function buildSearches(todayStr, windowEndStr) {
  return [
    {
      name: 'Music, Nightlife & Arts',
      prompt: `Search for real upcoming Seattle events from ${todayStr} through ${windowEndStr}.

Find events in these categories: live music, concerts, DJ nights, comedy shows, art exhibitions, gallery openings, theatre, film screenings, spoken word.

Search sites like eventbrite.com, ra.co, thestranger.com, axs.com, ticketmaster.com, seattlearts.org.

Return a JSON array of all events you find:
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
  "crawlSource": "Eventbrite"
}]

Rules:
- Only include events from ${todayStr} to ${windowEndStr}
- Use real event URLs from your search results
- category must be one of: music, art, comedy, other
- Return ONLY the JSON array, no other text`,
    },
    {
      name: 'Food, Markets & Outdoor',
      prompt: `Search for real upcoming Seattle events from ${todayStr} through ${windowEndStr}.

Find events in these categories: food festivals, night markets, farmers markets, outdoor activities, sports events, wellness classes, fitness events, community gatherings, cultural festivals.

Search sites like eventbrite.com, seattle.gov, thestranger.com, downtownseattle.org, timeout.com/seattle.

Return a JSON array of all events you find:
[{
  "id": "crawl-<slugified-title>-<YYYYMMDD>",
  "title": "Event Title",
  "date": "Sun, Mar 2 2026",
  "startDate": "2026-03-02",
  "startTime": "10:00 AM",
  "location": "Venue Name, Seattle WA",
  "description": "2-3 sentences about the event vibe and what to expect",
  "category": "food",
  "vibeTags": ["#market", "#outdoor"],
  "price": "Free",
  "link": "https://real-event-url.com",
  "organizer": "Organizer Name",
  "origin": "crawl",
  "crawlSource": "Seattle.gov"
}]

Rules:
- Only include events from ${todayStr} to ${windowEndStr}
- Use real event URLs from your search results
- category must be one of: food, outdoor, wellness, sports, fashion, party, other
- Return ONLY the JSON array, no other text`,
    },
  ];
}

// ─────────────────────────────────────────────
// RUN ONE CLAUDE WEB_SEARCH CALL
// ─────────────────────────────────────────────

async function searchWithClaude(search) {
  console.log(`\n  🔍 Searching: "${search.name}"...`);

  const conversationMessages = [{ role: 'user', content: search.prompt }];
  let finalText = '';
  const MAX_TURNS = 8;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
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

  // Parse JSON array from Claude's response
  const jsonMatch = finalText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn(`  ⚠️  No JSON array in response for "${search.name}"`);
    return [];
  }
  try {
    const events = JSON.parse(jsonMatch[0]);
    console.log(`  ✅ "${search.name}": ${events.length} events found`);
    return events;
  } catch (err) {
    console.warn(`  ⚠️  JSON parse failed for "${search.name}": ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
// DEDUPLICATE BY TITLE + DATE
// ─────────────────────────────────────────────

function deduplicate(events) {
  const seen = new Map();
  const unique = [];
  for (const event of events) {
    const key = `${(event.title || '').toLowerCase().trim()}__${event.startDate || ''}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      unique.push(event);
    }
  }
  return unique;
}

// ─────────────────────────────────────────────
// UPSERT WITH EMBEDDINGS INTO SUPABASE
// ─────────────────────────────────────────────

async function upsertEvents(events, vectors, windowEnd) {
  const expiresAt = new Date(windowEnd);
  expiresAt.setDate(expiresAt.getDate() + 1);

  let stored = 0, duplicates = 0, errors = 0;
  const storedTitles = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const embedding = vectors[i];

    // Ensure id is set
    if (!event.id) {
      const slug = (event.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const dateSlug = (event.startDate || 'undated').replace(/-/g, '');
      event.id = `crawl-${slug}-${dateSlug}`;
    }

    const row = {
      id: event.id,
      title: event.title || 'Untitled Event',
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
// MAIN CRAWL
// ─────────────────────────────────────────────

export async function runCrawl() {
  const startTime = Date.now();
  const { windowStart, windowEnd } = getWindowBounds();
  const todayStr    = formatDate(windowStart);
  const windowEndStr = formatDate(windowEnd);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║       Kickflip Event Crawler             ║');
  console.log(`║  Window: ${todayStr.slice(0,10)} → ${windowEndStr.slice(0,10)}      ║`);
  console.log('╚══════════════════════════════════════════╝');

  // Step 1: Run all searches (sequentially to avoid rate limits)
  console.log('\n🔍 STEP 1: Searching for Seattle events via Claude web_search...');
  const searches = buildSearches(todayStr, windowEndStr);
  let allCandidates = [];

  for (const search of searches) {
    const results = await searchWithClaude(search);
    allCandidates.push(...results);
  }

  console.log(`\n  → Total candidates across all searches: ${allCandidates.length}`);

  // Step 2: Deduplicate
  console.log('\n🔄 STEP 2: Deduplicating...');
  const unique = deduplicate(allCandidates);
  console.log(`  → ${unique.length} unique events (removed ${allCandidates.length - unique.length} duplicates)`);

  // Step 3: Filter to 7-day window
  console.log('\n🗓️  STEP 3: Filtering to 7-day future window...');
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

  console.log(`  → ${validEvents.length} events pass the window filter`);
  console.log(`  → ${rejectedEvents.length} rejected`);
  if (rejectedEvents.length > 0 && rejectedEvents.length <= 5) {
    rejectedEvents.forEach(r => console.log(r));
  }

  if (validEvents.length === 0) {
    console.log('\n⚠️  No valid events to store.');
    return {
      eventsFound: allCandidates.length, eventsRejected: rejectedEvents.length,
      eventsFiltered: 0, eventsStored: 0, duplicates: 0, errors: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 4: Generate embeddings in one batch call
  console.log(`\n🧠 STEP 4: Generating Voyage AI embeddings for ${validEvents.length} events...`);
  const vectors = await embedBatch(validEvents);

  // Step 5: Upsert into Supabase
  console.log(`\n💾 STEP 5: Storing ${validEvents.length} events in Supabase...`);
  const { stored, duplicates, errors, storedTitles } = await upsertEvents(validEvents, vectors, windowEnd);

  // Step 6: Clean expired cache
  console.log('\n🧹 STEP 6: Cleaning expired query cache...');
  const { error: cleanupErr } = await supabase.rpc('cleanup_expired_cache');
  if (cleanupErr) console.warn('  ⚠️  Cache cleanup:', cleanupErr.message);
  else console.log('  ✅ Cache cleaned');

  const durationMs = Date.now() - startTime;

  console.log('\n══════════════════════════════════════════');
  console.log('✅ CRAWL COMPLETE');
  console.log(`   Searches run     : ${searches.length}`);
  console.log(`   Events found     : ${allCandidates.length}`);
  console.log(`   After dedupe     : ${unique.length}`);
  console.log(`   After date filter: ${validEvents.length}`);
  console.log(`   ── Stored new    : ${stored} (with embeddings)`);
  console.log(`   ── Updated exist : ${duplicates}`);
  console.log(`   ── Errors        : ${errors}`);
  console.log(`   Duration         : ${(durationMs / 1000).toFixed(1)}s`);
  console.log('══════════════════════════════════════════');

  if (storedTitles.length > 0) {
    console.log('\n📋 Events stored in Supabase:');
    storedTitles.forEach(t => console.log(t));
  }

  return {
    eventsFound: allCandidates.length,
    eventsUnique: unique.length,
    eventsRejected: rejectedEvents.length,
    eventsFiltered: validEvents.length,
    eventsStored: stored,
    duplicates,
    errors,
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
