/**
 * seedEmbeddings.js
 * One-time script: generates Voyage AI embeddings for all existing
 * FEATURED_EVENTS and any events already in Supabase, then stores them.
 *
 * Run via: POST /api/seed  (triggered once after deploy)
 * Or directly: node scripts/seedEmbeddings.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { embedBatch } from '../services/embeddingService.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Inline featured events (subset of constants.ts — kept as JS for Node compatibility)
// The full list lives in constants.ts; this seeds the critical baseline.
const FEATURED_EVENTS = await loadFeaturedEvents();

async function loadFeaturedEvents() {
  // Fetch all events already in Supabase that don't have embeddings yet
  const { data, error } = await supabase
    .from('kickflip_events')
    .select('id, title, category, payload')
    .is('embedding', null);

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);

  return (data || []).map(row => ({
    id: row.id,
    title: row.title,
    category: row.category,
    ...(row.payload || {}),
  }));
}

async function seed() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Kickflip Embedding Seed Script     ║');
  console.log('╚══════════════════════════════════════╝\n');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('Missing VOYAGE_API_KEY env var');
  }

  const events = await loadFeaturedEvents();

  if (events.length === 0) {
    console.log('✅ All events already have embeddings. Nothing to seed.');
    return;
  }

  console.log(`📦 Found ${events.length} events without embeddings.\n`);
  console.log('🚀 Generating embeddings via Voyage AI...\n');

  const vectors = await embedBatch(events);

  console.log('\n💾 Storing embeddings in Supabase...');

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const embedding = vectors[i];

    const { error } = await supabase
      .from('kickflip_events')
      .update({ embedding })
      .eq('id', event.id);

    if (error) {
      console.error(`  ❌ Failed to update ${event.title}: ${error.message}`);
      errorCount++;
    } else {
      successCount++;
      if (successCount % 10 === 0) {
        console.log(`  ✅ ${successCount}/${events.length} stored...`);
      }
    }
  }

  console.log('\n══════════════════════════════════════');
  console.log(`✅ Seed complete: ${successCount} embedded, ${errorCount} errors`);
  console.log('══════════════════════════════════════\n');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
