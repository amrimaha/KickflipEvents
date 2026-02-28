/**
 * crawler.js
 * Daily batch crawler for Seattle events.
 * Sources: Eventbrite, Seattle.gov, Resident Advisor, Axs
 *
 * Flow:
 *  1. Fetch raw event data from each source
 *  2. Send raw batch to Claude → structured KickflipEvent JSON
 *  3. Generate Voyage AI embeddings for new/updated events
 *  4. Upsert into Supabase with crawled_at, source_url, expires_at
 *  5. Clean up expired query_cache entries
 *
 * Triggered by: POST /api/crawl  (Railway cron calls this daily at 6am PT)
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

// Events expire after 14 days so stale listings auto-disappear
const EXPIRES_DAYS = 14;

// ─────────────────────────────────────────────
// CRAWL SOURCES
// ─────────────────────────────────────────────

const SOURCES = [
  {
    name: 'Eventbrite Seattle',
    url: 'https://www.eventbrite.com/d/wa--seattle/events/',
    type: 'html',
  },
  {
    name: 'Seattle.gov Events',
    url: 'https://www.seattle.gov/neighborhoods/programs-and-services/events',
    type: 'html',
  },
  {
    name: 'Resident Advisor Seattle',
    url: 'https://ra.co/events/us/seattle',
    type: 'html',
  },
  {
    name: 'The Stranger Events',
    url: 'https://www.thestranger.com/events',
    type: 'html',
  },
];

// ─────────────────────────────────────────────
// FETCH RAW HTML FROM A SOURCE
// ─────────────────────────────────────────────

async function fetchSource(source) {
  try {
    console.log(`  📡 Fetching: ${source.name}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KickflipBot/1.0; +https://kickflip-events.vercel.app)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`  ⚠️  ${source.name}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();
    // Trim to first 15k chars to avoid massive Claude prompts
    const trimmed = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s{2,}/g, ' ')
                        .trim()
                        .slice(0, 15000);

    console.log(`  ✅ ${source.name}: ${trimmed.length} chars`);
    return { source, text: trimmed };
  } catch (err) {
    console.warn(`  ❌ ${source.name} failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// STRUCTURE RAW TEXT → KickflipEvent[] via Claude
// ─────────────────────────────────────────────

async function structureWithClaude(rawResults) {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  const combinedText = rawResults
    .map(r => `=== SOURCE: ${r.source.name} (${r.source.url}) ===\n${r.text}`)
    .join('\n\n');

  const prompt = `You are a data extraction assistant for Kickflip, a Seattle event discovery app.

TODAY: ${dateStr} (Seattle Time)

Extract ALL upcoming events from the raw text below. For each event return a JSON object.

RULES:
- Only include future events (on or after today)
- Extract as many events as possible — do not skip events
- Use "other" category if unsure
- vibeTags must be an array of hashtag strings like ["#music", "#live"]
- category must be one of: music, food, art, party, outdoor, wellness, fashion, sports, comedy, other
- If exact date is unknown write "See Website"
- link must be the real event URL if visible, otherwise use the source URL
- price: use "Free" if free, "$X" if known, "Varies" if unclear

RESPOND WITH VALID JSON ONLY — an array of event objects:
[
  {
    "id": "crawl-<slugified-title>-<YYYYMMDD>",
    "title": "Event Title",
    "date": "Sat, Mar 1 2026",
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
    console.log('\n🤖 Sending to Claude for structuring...');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in Claude response');

    const events = JSON.parse(jsonMatch[0]);
    console.log(`  ✅ Claude extracted ${events.length} events`);
    return events;
  } catch (err) {
    console.error(`  ❌ Claude structuring failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
// UPSERT EVENTS INTO SUPABASE
// ─────────────────────────────────────────────

async function upsertEvents(events, vectors) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + EXPIRES_DAYS);

  let successCount = 0;
  let errorCount = 0;

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
      console.error(`  ❌ Upsert failed for "${event.title}": ${error.message}`);
      errorCount++;
    } else {
      successCount++;
    }
  }

  return { successCount, errorCount };
}

// ─────────────────────────────────────────────
// MAIN CRAWL FUNCTION
// ─────────────────────────────────────────────

export async function runCrawl() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║      Kickflip Daily Crawler          ║');
  console.log(`║  ${new Date().toISOString()}  ║`);
  console.log('╚══════════════════════════════════════╝\n');

  // Step 1: Fetch all sources in parallel
  console.log('📡 Step 1: Fetching event sources...');
  const rawResults = (await Promise.all(SOURCES.map(fetchSource))).filter(Boolean);

  if (rawResults.length === 0) {
    console.warn('⚠️  No sources returned data. Crawl aborted.');
    return { eventsFound: 0, eventsStored: 0, errors: 0 };
  }

  // Step 2: Structure with Claude (1 LLM call for all sources combined)
  console.log(`\n🤖 Step 2: Structuring ${rawResults.length} source(s) with Claude...`);
  const events = await structureWithClaude(rawResults);

  if (events.length === 0) {
    console.warn('⚠️  No events extracted. Crawl complete with 0 results.');
    return { eventsFound: 0, eventsStored: 0, errors: 0 };
  }

  // Step 3: Generate embeddings for all events in one batch call
  console.log(`\n🧠 Step 3: Generating embeddings for ${events.length} events...`);
  const vectors = await embedBatch(events);

  // Step 4: Upsert into Supabase
  console.log(`\n💾 Step 4: Upserting ${events.length} events to Supabase...`);
  const { successCount, errorCount } = await upsertEvents(events, vectors);

  // Step 5: Clean up expired query_cache entries
  console.log('\n🧹 Step 5: Cleaning up expired query cache...');
  const { error: cleanupError } = await supabase.rpc('cleanup_expired_cache');
  if (cleanupError) console.warn('  ⚠️  Cache cleanup warning:', cleanupError.message);
  else console.log('  ✅ Cache cleaned');

  console.log('\n══════════════════════════════════════');
  console.log(`✅ Crawl complete`);
  console.log(`   Sources fetched : ${rawResults.length}/${SOURCES.length}`);
  console.log(`   Events extracted: ${events.length}`);
  console.log(`   Events stored   : ${successCount}`);
  console.log(`   Errors          : ${errorCount}`);
  console.log('══════════════════════════════════════\n');

  return { eventsFound: events.length, eventsStored: successCount, errors: errorCount };
}

// Allow direct execution: node scripts/crawler.js
if (process.argv[1].includes('crawler.js')) {
  runCrawl().catch(err => {
    console.error('Crawl failed:', err);
    process.exit(1);
  });
}
