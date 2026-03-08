/**
 * seedEmbeddings.js
 * Backfills Voyage AI embeddings for any events in Supabase with embedding = NULL.
 *
 * Called automatically after each crawl (if any events landed without embeddings).
 * Also available on demand: POST /api/seed  Authorization: Bearer <CRON_SECRET>
 * Or directly: node scripts/seedEmbeddings.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { embedBatch } from '../services/embeddingService.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function runSeed() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Kickflip Embedding Seed Script     ║');
  console.log('╚══════════════════════════════════════╝\n');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('Missing VOYAGE_API_KEY env var');
  }

  const { data, error } = await supabase
    .from('kickflip_events')
    .select('id, title, category, payload')
    .is('embedding', null);

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);

  const events = (data || []).map(row => ({
    id: row.id,
    title: row.title,
    category: row.category,
    ...(row.payload || {}),
  }));

  if (events.length === 0) {
    console.log('✅ All events already have embeddings. Nothing to seed.');
    return { seeded: 0, errors: 0 };
  }

  console.log(`📦 Found ${events.length} events without embeddings.`);
  console.log('🚀 Generating embeddings via Voyage AI...\n');

  const vectors = await embedBatch(events);

  console.log('\n💾 Storing embeddings in Supabase...');

  let seeded = 0;
  let errors = 0;

  for (let i = 0; i < events.length; i++) {
    const { error: updateErr } = await supabase
      .from('kickflip_events')
      .update({ embedding: vectors[i] })
      .eq('id', events[i].id);

    if (updateErr) {
      console.error(`  ❌ Failed to update ${events[i].title}: ${updateErr.message}`);
      errors++;
    } else {
      seeded++;
      if (seeded % 10 === 0) console.log(`  ✅ ${seeded}/${events.length} stored...`);
    }
  }

  console.log('\n══════════════════════════════════════');
  console.log(`✅ Seed complete: ${seeded} embedded, ${errors} errors`);
  console.log('══════════════════════════════════════\n');

  return { seeded, errors };
}

// Direct execution: node scripts/seedEmbeddings.js
if (process.argv[1]?.includes('seedEmbeddings.js')) {
  runSeed().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
