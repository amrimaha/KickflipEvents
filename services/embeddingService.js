/**
 * embeddingService.js
 * Voyage AI wrapper for generating and querying event embeddings.
 * Model: voyage-3-lite (1024 dimensions, optimized for retrieval)
 */

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite';

/**
 * Core fetch wrapper for Voyage AI API
 */
async function callVoyage(inputs, inputType = 'document') {
  if (!VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is not set');

  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: inputs,
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage AI error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data.map(item => item.embedding);
}

/**
 * Embed a single user query string.
 * Uses input_type: 'query' — optimized for similarity search against documents.
 * @param {string} queryText
 * @returns {Promise<number[]>} 1024-dimension vector
 */
export async function embedQuery(queryText) {
  const vectors = await callVoyage([queryText], 'query');
  return vectors[0];
}

/**
 * Embed a single event object into a searchable document vector.
 * Builds a rich text representation so similarity search matches
 * on title, category, description, tags, location, and organizer.
 * @param {object} event  KickflipEvent
 * @returns {Promise<number[]>} 1024-dimension vector
 */
export async function embedEvent(event) {
  const text = buildEventText(event);
  const vectors = await callVoyage([text], 'document');
  return vectors[0];
}

/**
 * Embed a batch of events in one API call (cheaper + faster than one-by-one).
 * Voyage AI supports up to 128 inputs per request.
 * @param {object[]} events  array of KickflipEvent
 * @returns {Promise<number[][]>} array of 1024-dimension vectors
 */
export async function embedBatch(events) {
  const BATCH_SIZE = 100; // stay safely under Voyage's 128 limit
  const allVectors = [];

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const texts = batch.map(buildEventText);
    const vectors = await callVoyage(texts, 'document');
    allVectors.push(...vectors);
    console.log(`  Embedded batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(events.length / BATCH_SIZE)} (${allVectors.length}/${events.length} events)`);
  }

  return allVectors;
}

/**
 * Build a rich plain-text representation of an event for embedding.
 * More descriptive text = better semantic search results.
 */
function buildEventText(event) {
  const parts = [
    event.title,
    event.category ? `Category: ${event.category}` : '',
    event.description || event.vibeDescription || '',
    event.location || event.locationName || '',
    event.organizer ? `Organizer: ${event.organizer}` : '',
    Array.isArray(event.vibeTags) ? event.vibeTags.join(' ') : '',
    event.date ? `Date: ${event.date}` : '',
    event.price ? `Price: ${event.price}` : '',
    event.city ? `City: ${event.city}` : 'Seattle',
  ];
  return parts.filter(Boolean).join(' | ');
}
