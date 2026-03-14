/**
 * crawler.js — v2 (tiered, rate-limit-safe)
 *
 * Architecture (learnings from Bryce's kickflip-engine):
 *
 * Tier 1 — RSS feeds (zero Claude cost)
 *   Directly fetch structured feeds. Fast, free, reliable. Most aggregators
 *   (EverOut, The Stranger) publish RSS. ~0 API tokens.
 *
 * Tier 2 — HTML scrape + Claude extract (cheap, no web_search)
 *   fetch() the venue/aggregator page → strip noise with cheerio → single
 *   Claude Haiku call to extract JSON (no web_search tool, no multi-turn loop).
 *   ~2–4K input tokens per source. 10× cheaper than the old approach.
 *
 * Tier 3 — AI gap-fill (targeted, single-turn web_search)
 *   Only runs when a category has < min_gap_fill events after Tiers 1+2.
 *   Single Claude Haiku call with web_search tool — no looping, take the
 *   LAST text block (Bryce's pattern). 35s cooldown between calls.
 *   Claude is used as a discovery fallback, not the primary crawler.
 *
 * Quality pipeline (after all tiers):
 *   normalize → quality gate → deduplicate → embed → upsert
 *
 * Configuration: crawl-sources.yaml — each source now has scrape_method
 *   (rss | html | disabled) and url (the actual page URL, not just domain).
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { jsonrepair } from 'jsonrepair';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import RssParser from 'rss-parser';
import * as cheerio from 'cheerio';
import { embedBatch } from '../services/embeddingService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = resolve(__dirname, '../crawl-sources.yaml');
  try {
    return yaml.load(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.warn('[crawler] Could not read crawl-sources.yaml:', err.message);
    return { settings: {}, sources: [] };
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const rssParser = new RssParser();

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'music', 'art', 'food', 'outdoor', 'comedy', 'wellness', 'sports', 'party', 'other',
]);

// Categories checked for gap-fill (AI will search for these if coverage is thin)
const GAP_FILL_CATEGORIES = [
  { key: 'music',    label: 'Music & Nightlife concerts shows' },
  { key: 'art',      label: 'Arts & Culture gallery openings performances' },
  { key: 'food',     label: 'Food, Drink & Culinary events classes' },
  { key: 'outdoor',  label: 'Outdoor & Adventure activities' },
  { key: 'comedy',   label: 'Comedy shows open mics stand-up' },
  { key: 'wellness', label: 'Fitness & Wellness yoga classes workshops' },
];

const BLOCKLIST = [
  'mlm', 'network marketing', 'pyramid scheme', 'get rich',
  'passive income', 'multi-level', 'downline',
];

const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getWindowBounds(windowDays) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + windowDays);
  return { windowStart: now, windowEnd: end };
}

function formatDatePretty(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

function toISO(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// ─── Quality gate (Bryce-inspired) ───────────────────────────────────────────

function qualityGate(event, windowStart, windowEnd) {
  if (!event.title || event.title.trim().length < 5) {
    return { pass: false, reason: 'title too short' };
  }
  if (!event.link || !event.link.startsWith('http')) {
    return { pass: false, reason: 'no valid URL' };
  }
  const desc = event.description || '';
  if (desc.trim().length > 0 && desc.trim().length < 15) {
    return { pass: false, reason: 'description too short' };
  }

  if (event.startDate && event.startDate !== 'See Website') {
    const d = new Date(event.startDate);
    if (!isNaN(d.getTime())) {
      if (d < windowStart) return { pass: false, reason: `past (${event.startDate})` };
      if (d > windowEnd)   return { pass: false, reason: `beyond window (${event.startDate})` };
    }
  }

  const text = `${event.title} ${event.description ?? ''}`.toLowerCase();
  for (const word of BLOCKLIST) {
    if (text.includes(word)) return { pass: false, reason: `blocked keyword: "${word}"` };
  }
  return { pass: true, reason: 'ok' };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function makeDedupKey(event) {
  const title = (event.title || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '').slice(0, 50);
  const date  = event.startDate || '';
  return `${title}__${date}`;
}

/**
 * Levenshtein edit distance — O(m·n), space-optimised to O(n).
 * Used for fuzzy title dedup: catches the same event listed by two
 * scrapers with slightly different titles, e.g.:
 *   "John Mulaney Live"  vs  "John Mulaney – Live at Paramount"
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = temp;
    }
  }
  return row[b.length];
}

// ─── Normalize event fields ───────────────────────────────────────────────────

function normalizeEvent(raw, sourceName) {
  const cat = (raw.category || 'other').split(',')[0].trim().toLowerCase();
  return {
    title:       (raw.title || 'Untitled').trim().slice(0, 200),
    date:        raw.date || raw.startDate || null,
    startDate:   raw.startDate || null,
    startTime:   raw.startTime || null,
    location:    raw.location || null,
    description: (raw.description || '').slice(0, 500),
    category:    VALID_CATEGORIES.has(cat) ? cat : 'other',
    vibeTags:    raw.vibeTags || [],
    price:       raw.price || null,
    link:        raw.link || raw.source_url || null,
    organizer:   raw.organizer || null,
    origin:      'crawl',
    crawlSource: sourceName,
    imageUrl:    raw.imageUrl || raw.image_url || null,
  };
}

// ─── Tier 1: RSS ──────────────────────────────────────────────────────────────

async function scrapeRss(source) {
  console.log(`  📡 [rss] ${source.name}...`);
  try {
    const feed = await rssParser.parseURL(source.url);
    const now = new Date();
    const events = (feed.items ?? []).map(item => {
      // item.isoDate is the RSS *publication* date, not necessarily the event date.
      // Event calendar plugins (EverOut/WordPress) often set pubDate = event start date,
      // so a FUTURE isoDate is likely the actual event date.
      // A PAST isoDate is the publication date of an already-announced event — we don't
      // know the real event date from RSS alone, so leave startDate null (passes quality gate).
      const isoDate = item.isoDate ? new Date(item.isoDate) : null;
      const startDate = isoDate && isoDate > now ? item.isoDate.slice(0, 10) : null;

      return normalizeEvent({
        title:       item.title,
        startDate,
        date:        startDate || item.pubDate || null,
        link:        item.link,
        description: item.contentSnippet || item.content || '',
        category:    (item.categories ?? [source.category ?? 'other'])[0],
        location:    '',
        price:       null,
      }, source.name);
    });
    console.log(`  ✅ [rss] ${source.name}: ${events.length} items (${events.filter(e => e.startDate).length} dated)`);
    return events;
  } catch (err) {
    console.warn(`  ⚠️  [rss] ${source.name} failed: ${err.message}`);
    return [];
  }
}

// ─── Tier 2: HTML fetch + Claude extract ─────────────────────────────────────
//
// Deliberately does NOT use web_search_20250305.
// Fetches real HTML → strips noise → single Haiku call to extract events.
// ~2–4K input tokens. No looping. No rate-limit risk.

async function scrapeHtml(source) {
  console.log(`  🌐 [html] ${source.name}...`);

  let html = null;
  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'KickflipBot/2.0 (+https://kickflip-events.vercel.app)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.warn(`  ⚠️  [html] ${source.name} fetch failed: ${err.message}`);
    return [];
  }

  // Strip noise, keep first 10KB of meaningful text
  const $ = cheerio.load(html);
  $('script, style, nav, footer, noscript, iframe, [aria-hidden="true"]').remove();
  const bodyText = ($('main, [class*="event"], [id*="event"], article').first().text()
    || $('body').text())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000);

  if (bodyText.length < 80) {
    console.warn(`  ⚠️  [html] ${source.name}: page too short to parse`);
    return [];
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Extract upcoming Seattle events from this page text.
Output ONLY a valid JSON array — no markdown, no explanation.
Schema (use null for unknown fields):
[{"title":"string","startDate":"YYYY-MM-DD","startTime":"HH:MM AM/PM","location":"Venue, Seattle WA","description":"string","category":"music|art|food|outdoor|comedy|wellness|sports|party|other","price":"$N or Free","link":"https://real-url"}]
If no events, return [].

Page URL: ${source.url}
Text: ${bodyText}`,
      }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    // Strip optional markdown code fence
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn(`  ⚠️  [html] ${source.name}: no JSON array in response`);
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      parsed = JSON.parse(jsonrepair(match[0]));
    }
    if (!Array.isArray(parsed)) return [];

    const events = parsed.map(e => normalizeEvent({
      ...e,
      link: e.link?.startsWith('http') ? e.link : source.url,
    }, source.name));
    console.log(`  ✅ [html] ${source.name}: ${events.length} events`);
    return events;
  } catch (err) {
    console.warn(`  ⚠️  [html] ${source.name} Claude extract failed: ${err.message}`);
    return [];
  }
}

// ─── Tier 3: AI gap-fill (single-turn web_search) ────────────────────────────
//
// Based directly on Bryce's discovery.ts approach:
// - Single message, web_search tool enabled
// - Take the LAST text block (intermediate blocks are search thoughts, not answers)
// - Parse ```json block first, fall back to bare array
// - Only called when category coverage is thin

async function aiGapFill(catKey, catLabel, todayStr, windowEndStr) {
  console.log(`  🤖 [gap-fill] category="${catKey}"...`);
  try {
    const response = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: `Find ${catLabel} events in Seattle, WA from ${todayStr} to ${windowEndStr}.
Search sites like everout.com, thestranger.com, eventbrite.com, ra.co, do206.com.
Only include events with a real URL and approximate date.

At the end output a JSON array in a code block:
\`\`\`json
[{
  "title": "string",
  "startDate": "YYYY-MM-DD",
  "startTime": "HH:MM AM/PM or null",
  "location": "Venue name, neighborhood",
  "description": "What makes this event interesting (30+ chars)",
  "category": "${catKey}",
  "price": "$N or Free or null",
  "link": "https://real-event-url.com"
}]
\`\`\`
Return [] if nothing found. Only real events with real URLs.`,
        }],
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } }
    );

    // Take the LAST text block — intermediate ones are just "I'll search for..."
    const textBlocks = response.content.filter(b => b.type === 'text');
    const lastText = textBlocks[textBlocks.length - 1]?.text ?? '';

    // Prefer ```json block, fall back to bare array
    const codeMatch = lastText.match(/```json\s*([\s\S]*?)```/i);
    const bareMatch = lastText.match(/\[[\s\S]*\]/);
    const jsonStr = codeMatch?.[1]?.trim() ?? bareMatch?.[0];

    if (!jsonStr) {
      console.warn(`  ⚠️  [gap-fill] "${catKey}": no JSON. Preview: "${lastText.slice(0, 150)}"`);
      return [];
    }

    let events;
    try {
      events = JSON.parse(jsonStr);
    } catch {
      events = JSON.parse(jsonrepair(jsonStr));
    }
    if (!Array.isArray(events)) return [];

    const tagged = events
      .filter(e => e.link?.startsWith('http')) // require real URL
      .map(e => normalizeEvent({ ...e, category: catKey }, `ai_gap_fill:${catKey}`));
    console.log(`  ✅ [gap-fill] "${catKey}": ${tagged.length} events`);
    return tagged;
  } catch (err) {
    console.warn(`  ⚠️  [gap-fill] "${catKey}" failed: ${err.message.slice(0, 120)}`);
    return [];
  }
}

// ─── OG image enrichment (Bryce's approach — $0 Claude cost) ─────────────────
//
// For newly stored events that have no imageUrl, fetch their source_url and
// extract the og:image / twitter:image meta tag. Regex-only, no Claude.
// 300ms delay between fetches to avoid hammering source sites.

const OG_PATTERNS = [
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
];

function extractOgImage(html) {
  for (const pattern of OG_PATTERNS) {
    const match = html.match(pattern);
    const url = match?.[1];
    if (url && url.startsWith('http') && !url.startsWith('data:')) return url;
  }
  return null;
}

async function enrichImages(events, limit = 40) {
  // Only enrich events that were newly stored (have a source_url, no imageUrl)
  const needsImage = events
    .filter(e => e.link && !e.imageUrl)
    .slice(0, limit);

  if (needsImage.length === 0) return 0;
  console.log(`\n🖼️  IMAGE ENRICHMENT: fetching og:image for ${needsImage.length} events...`);

  let enriched = 0;
  for (const event of needsImage) {
    try {
      const res = await fetch(event.link, {
        headers: { 'User-Agent': 'KickflipBot/2.0 (+https://kickflip-events.vercel.app)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;

      // Only read enough HTML to find the <head> og tags (first 10KB is plenty)
      const html = (await res.text()).slice(0, 15000);
      const imageUrl = extractOgImage(html);
      if (!imageUrl) continue;

      // Update payload.imageUrl in Supabase
      const { data: existing } = await supabase
        .from('kickflip_events')
        .select('id, payload')
        .eq('source_url', event.link)
        .single();

      if (existing) {
        const updatedPayload = { ...existing.payload, imageUrl };
        await supabase
          .from('kickflip_events')
          .update({ payload: updatedPayload })
          .eq('id', existing.id);
        enriched++;
      }
    } catch {
      // Non-fatal — image enrichment is best-effort
    }
    await SLEEP(300);
  }

  console.log(`  ✅ Enriched ${enriched}/${needsImage.length} events with og:image`);
  return enriched;
}

// ─── AI Tagging (Bryce's batch pattern — cheap, big quality win) ─────────────
//
// After upsert, run Claude Haiku in batches of 10 to enrich events with:
//   vibeTags : adventurous | relaxing | social | educational |
//              family-friendly | romantic | creative | cultural
//   tags     : 3–5 specific descriptors ("date-night","outdoor","21+")
//   price_tier: free | low | medium | premium | unknown
//
// Results are merged back into payload so the frontend can use them
// immediately (vibeTags already rendered by EventCard).

async function tagBatch(events) {
  const prompt = events
    .map((e, i) =>
      `Event ${i + 1} (id: ${e.id}):\nTitle: ${e.title}\nDescription: ${(e.description || '').slice(0, 300)}\nCategory: ${e.category}\nPrice: ${e.price || 'unknown'}`
    )
    .join('\n\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `For each event below return a JSON array. ONLY valid JSON, no markdown.
Schema: [{"id":"string","tags":["string"],"vibe":["string"],"price_tier":"free|low|medium|premium|unknown"}]

tags: 3–5 descriptors e.g. ["date-night","outdoor","21+","beginner-friendly","limited-capacity"]
vibe: 1–3 from [adventurous, relaxing, social, educational, family-friendly, romantic, creative, cultural]
price_tier: free=no cost, low=under $20, medium=$20–60, premium=over $60

${prompt}`,
      }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return new Map();

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch { parsed = JSON.parse(jsonrepair(match[0])); }

    const results = new Map();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item.id) continue;
        results.set(String(item.id), {
          tags:       Array.isArray(item.tags) ? item.tags : [],
          vibeTags:   Array.isArray(item.vibe) ? item.vibe : [],  // frontend field name
          price_tier: item.price_tier || 'unknown',
        });
      }
    }
    return results;
  } catch (err) {
    console.warn(`  ⚠️  [tagging] batch failed: ${err.message}`);
    return new Map();
  }
}

async function runTagging(events) {
  if (events.length === 0) return 0;

  // Chunk into batches of 10
  const batches = [];
  for (let i = 0; i < events.length; i += 10) batches.push(events.slice(i, i + 10));

  console.log(`\n🏷️  TAGGING: ${events.length} events in ${batches.length} batches...`);
  let tagged = 0;

  for (let i = 0; i < batches.length; i++) {
    const results = await tagBatch(batches[i]);

    for (const [id, data] of results.entries()) {
      // The event object IS the payload (stored as payload: event in upsertEvents),
      // so merging data into it builds the updated payload directly — no extra SELECT needed.
      const event = events.find(e => e.id === id);
      if (!event) continue;

      const { error } = await supabase
        .from('kickflip_events')
        .update({ payload: { ...event, ...data } })
        .eq('id', id);

      if (!error) tagged++;
    }

    if (i < batches.length - 1) await SLEEP(1000);
  }

  console.log(`  ✅ Tagged ${tagged}/${events.length} events`);
  return tagged;
}

// ─── Upsert with embeddings ───────────────────────────────────────────────────

async function upsertEvents(events, vectors, windowEnd) {
  const expiresAt = new Date(windowEnd);
  expiresAt.setDate(expiresAt.getDate() + 1);

  let stored = 0, skipped = 0, errors = 0;
  const storedTitles = [];
  let firstError = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (!event.id) {
      const slug = (event.title || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const dateSlug = (event.startDate || 'undated').replace(/-/g, '');
      event.id = `crawl-${slug}-${dateSlug}`;
    }

    const row = {
      id:           event.id,
      title:        event.title,
      category:     event.category,
      payload:      event,
      embedding:    vectors[i] ?? null,
      origin:       'crawl',
      is_active:    true,
      crawled_at:   new Date().toISOString(),
      source_url:   event.link || null,
      crawl_source: event.crawlSource || null,
      expires_at:   expiresAt.toISOString(),
    };

    const { error } = await supabase
      .from('kickflip_events')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      if (error.code === '23505') {
        skipped++;
      } else {
        if (!firstError) firstError = `${error.message} (code: ${error.code})`;
        console.error(`  ❌ "${event.title}": ${error.message}`);
        errors++;
      }
    } else {
      stored++;
      storedTitles.push(`  • ${event.title} (${event.startDate || 'undated'}) — ${event.category}`);
    }
  }

  return { stored, skipped, errors, storedTitles, firstError };
}

// ─── Main crawl ───────────────────────────────────────────────────────────────

/**
 * @param {object}  opts
 * @param {string}  [opts.batch]     — only run sources with this batch label
 * @param {boolean} [opts.skipGapFill] — skip Tier 3 AI gap-fill (for quick runs)
 */
export async function runCrawl({ batch: batchFilter, skipGapFill = false } = {}) {
  const startTime = Date.now();

  const config = loadConfig();
  const {
    date_window_days = 14,
    min_gap_fill     = 5,     // Run AI gap-fill if category has fewer than this many events
    max_html_sources = 15,    // Cap HTML sources (each costs ~1 Claude call)
    gap_fill_delay_ms = 35000, // 35s between gap-fill calls (rate limit safety)
  } = config.settings || {};

  const { windowStart, windowEnd } = getWindowBounds(date_window_days);
  const todayStr    = formatDatePretty(windowStart);
  const windowEndStr = formatDatePretty(windowEnd);

  const allSources = (config.sources || [])
    .filter(s => s.enabled !== false)
    .filter(s => !batchFilter || s.batch === batchFilter)
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));

  const rssSources  = allSources.filter(s => s.scrape_method === 'rss');
  const htmlSources = allSources.filter(s => s.scrape_method === 'html').slice(0, max_html_sources);

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║     Kickflip Crawler v2 — Tiered Pipeline     ║');
  console.log(`║  Window : ${toISO(windowStart)} → ${toISO(windowEnd)} (${date_window_days}d)     ║`);
  console.log(`║  Tier 1 : ${rssSources.length} RSS sources (free, zero Claude)       ║`);
  console.log(`║  Tier 2 : ${htmlSources.length} HTML sources (~2-4K tokens each)    ║`);
  console.log(`║  Tier 3 : AI gap-fill if category < ${min_gap_fill} events           ║`);
  console.log('╚════════════════════════════════════════════════╝');

  let allCandidates = [];

  // ── Tier 1: RSS (free) ────────────────────────────────────────────────────
  console.log(`\n📡 TIER 1: RSS feeds (${rssSources.length} sources, $0 cost)...`);
  for (const src of rssSources) {
    const events = await scrapeRss(src);
    allCandidates.push(...events);
  }
  const rssCount = allCandidates.length;
  console.log(`  → ${rssCount} candidates from RSS`);

  // ── Tier 2: HTML + Claude extract (cheap) ────────────────────────────────
  console.log(`\n🌐 TIER 2: HTML scrape + Claude extract (${htmlSources.length} sources)...`);
  for (let i = 0; i < htmlSources.length; i++) {
    const events = await scrapeHtml(htmlSources[i]);
    allCandidates.push(...events);
    if (events.length === 0) console.log(`  ⚠️  [html] ${htmlSources[i].name}: 0 events — may need Playwright or different URL`);
    // Small courtesy delay between HTML+Claude calls (~2-4K tokens each, well under limit)
    if (i < htmlSources.length - 1) await SLEEP(1500);
  }
  const htmlCount = allCandidates.length - rssCount;
  console.log(`  → ${htmlCount} from HTML, ${rssCount} from RSS, ${allCandidates.length} total`);

  // ── Normalize + Deduplicate (3 passes) ────────────────────────────────────
  console.log('\n🔄 NORMALIZE + DEDUPLICATE...');

  // Pass 1 — URL exact match (fastest, most reliable signal)
  const seenUrls = new Set();
  let urlDups = 0;
  const urlDeduped = allCandidates.filter(e => {
    if (!e.link) return true;
    if (seenUrls.has(e.link)) { urlDups++; return false; }
    seenUrls.add(e.link);
    return true;
  });

  // Pass 2 — Title+date hash (same title, same date = same event)
  // `seen` is kept in outer scope so gap-fill can also check against it
  const seen = new Map();
  let hashDups = 0;
  const hashDeduped = urlDeduped.filter(e => {
    const key = makeDedupKey(e);
    if (seen.has(key)) { hashDups++; return false; }
    seen.set(key, true);
    return true;
  });

  // Pass 3 — Fuzzy title match (Levenshtein ≤ 8 on same date)
  // Catches "John Mulaney Live" vs "John Mulaney – Live at Paramount" same night
  const accepted = [];
  let fuzzyDups = 0;
  for (const e of hashDeduped) {
    const titleA = (e.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const dateA  = e.startDate;
    let isDup = false;
    if (dateA && titleA.length >= 5) {
      for (const prev of accepted) {
        if (prev.startDate !== dateA) continue;
        const titleB = (prev.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (levenshtein(titleA, titleB) <= 8) { isDup = true; break; }
      }
    }
    if (!isDup) accepted.push(e);
    else fuzzyDups++;
  }
  const unique = accepted;

  console.log(`  → ${unique.length} unique (${urlDups} URL dups, ${hashDups} hash dups, ${fuzzyDups} fuzzy dups removed)`);

  // ── Quality gate ──────────────────────────────────────────────────────────
  console.log('\n✅ QUALITY GATE...');
  const valid = [];
  const rejected = [];
  for (const e of unique) {
    const { pass, reason } = qualityGate(e, windowStart, windowEnd);
    if (pass) valid.push(e);
    else rejected.push(`  ✗ "${e.title}" — ${reason}`);
  }
  // Tally rejection reasons for diagnostics
  const rejectReasons = {};
  for (const r of rejected) {
    const reason = r.match(/— (.+)$/)?.[1]?.split(' (')[0] ?? 'unknown';
    rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
  }
  console.log(`  → ${valid.length} pass, ${rejected.length} rejected`);
  if (rejected.length > 0) {
    console.log(`  Rejection breakdown: ${JSON.stringify(rejectReasons)}`);
    // Show first 5 examples
    rejected.slice(0, 5).forEach(r => console.log(r));
    if (rejected.length > 5) console.log(`  ... and ${rejected.length - 5} more`);
  }

  // ── Tier 3: AI gap-fill (targeted, single-turn) ───────────────────────────
  let gapFillRuns = 0;
  if (!skipGapFill) {
    const categoryCount = {};
    for (const e of valid) {
      const cat = e.category || 'other';
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    }

    const gapCategories = GAP_FILL_CATEGORIES.filter(
      c => (categoryCount[c.key] || 0) < min_gap_fill
    );

    if (gapCategories.length === 0) {
      console.log('\n🤖 TIER 3: All categories covered — skipping AI gap-fill');
    } else {
      console.log(`\n🤖 TIER 3: AI gap-fill for ${gapCategories.length} thin categories...`);
      console.log(`  Coverage: ${JSON.stringify(categoryCount)}`);

      for (let i = 0; i < gapCategories.length; i++) {
        if (i > 0) {
          console.log(`  ⏳ ${gap_fill_delay_ms / 1000}s cooldown between gap-fill calls...`);
          await SLEEP(gap_fill_delay_ms);
        }
        const { key, label } = gapCategories[i];
        const gapEvents = await aiGapFill(key, label, todayStr, windowEndStr);
        for (const e of gapEvents) {
          const { pass } = qualityGate(e, windowStart, windowEnd);
          if (pass && !seen.has(makeDedupKey(e))) {
            seen.set(makeDedupKey(e), true);
            valid.push(e);
          }
        }
        gapFillRuns++;
      }
      console.log(`  → ${valid.length} total events after gap-fill`);
    }
  }

  if (valid.length === 0) {
    console.log('\n⚠️  No valid events to store.');
    return {
      eventsFound: allCandidates.length, eventsStored: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Embeddings ────────────────────────────────────────────────────────────
  console.log(`\n🧠 EMBEDDINGS: ${valid.length} events...`);
  let vectors;
  try {
    vectors = await embedBatch(valid);
  } catch (embedErr) {
    console.warn(`  ⚠️  Embedding failed (${embedErr.message}) — storing without embeddings`);
    vectors = new Array(valid.length).fill(null);
  }

  // ── Upsert ────────────────────────────────────────────────────────────────
  console.log(`\n💾 UPSERT: ${valid.length} events to Supabase...`);
  const { stored, skipped, errors, storedTitles, firstError } =
    await upsertEvents(valid, vectors, windowEnd);

  // ── OG image enrichment (best-effort, $0 Claude cost) ────────────────────
  const imagesEnriched = await enrichImages(valid);

  // ── AI Tagging (best-effort, ~$0.002 per 10 events) ──────────────────────
  const eventsTagged = await runTagging(valid);

  // ── Cache cleanup ─────────────────────────────────────────────────────────
  console.log('\n🧹 Cache cleanup...');
  const { error: cacheErr } = await supabase.rpc('cleanup_expired_cache');
  if (cacheErr) console.warn('  ⚠️  Cache cleanup:', cacheErr.message);
  else console.log('  ✅ Cache cleaned');

  const durationMs = Date.now() - startTime;

  console.log('\n══════════════════════════════════════════════');
  console.log('✅ CRAWL COMPLETE');
  console.log(`   Tier 1 RSS     : ${rssSources.length} sources`);
  console.log(`   Tier 2 HTML    : ${htmlSources.length} sources`);
  console.log(`   Tier 3 gap-fill: ${gapFillRuns} categories`);
  console.log(`   Candidates     : ${allCandidates.length}`);
  console.log(`   After quality  : ${valid.length}`);
  console.log(`   Stored new     : ${stored}`);
  console.log(`   Skipped (dup)  : ${skipped}`);
  console.log(`   Errors         : ${errors}`);
  console.log(`   Images enriched: ${imagesEnriched}`);
  console.log(`   Events tagged  : ${eventsTagged}`);
  console.log(`   Duration       : ${(durationMs / 1000).toFixed(1)}s`);
  console.log('══════════════════════════════════════════════');

  if (storedTitles.length > 0) {
    console.log('\n📋 Events stored:');
    storedTitles.slice(0, 30).forEach(t => console.log(t));
    if (storedTitles.length > 30) console.log(`  ... and ${storedTitles.length - 30} more`);
  }

  return {
    eventsFound:     allCandidates.length,
    eventsUnique:    unique.length,
    eventsFiltered:  valid.length,
    eventsStored:    stored,
    eventsSkipped:   skipped,
    errors,
    firstError:      firstError || null,
    gapFillRuns,
    embeddingsGenerated: vectors.filter(Boolean).length,
    imagesEnriched,
    eventsTagged,
    durationMs,
  };
}

// Direct execution: node scripts/crawler.js
if (process.argv[1]?.includes('crawler.js')) {
  runCrawl().catch(err => {
    console.error('Crawl failed:', err);
    process.exit(1);
  });
}
