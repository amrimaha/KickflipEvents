
import { KickflipEvent } from "../types";
import { FEATURED_EVENTS, getVideoForEvent } from "../constants";

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const STREAM_DELIMITER = '\n\n[EVENTS_JSON]\n';

/**
 * Reads the streaming `/api/chat` response.
 * Calls `onChunk(partialText)` as vibe text arrives token by token.
 * Returns `{ text, events }` once the delimiter appears and stream ends.
 */
async function fetchChatStream(
  url: string,
  body: object,
  onChunk?: (partial: string) => void
): Promise<{ text: string; events: any[] }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // JSON fallback (e.g. 500 error returned before streaming started)
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    return { text: data.text || '', events: data.events || [] };
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += decoder.decode(value, { stream: true });

    // Fire onChunk with the vibe text portion as it streams in
    if (onChunk) {
      const delimIdx = accumulated.indexOf(STREAM_DELIMITER);
      const vibeText = delimIdx === -1 ? accumulated : accumulated.slice(0, delimIdx);
      onChunk(vibeText);
    }
  }

  const delimIdx = accumulated.indexOf(STREAM_DELIMITER);
  if (delimIdx === -1) return { text: accumulated.trim(), events: [] };

  const vibeText = accumulated.slice(0, delimIdx).trim();
  const eventsJson = accumulated.slice(delimIdx + STREAM_DELIMITER.length);
  let events: any[] = [];
  try { events = JSON.parse(eventsJson); } catch { events = []; }
  return { text: vibeText, events };
}

export const searchSeattleEvents = async (
  query: string,
  systemEvents: KickflipEvent[] = [],
  onChunk?: (partial: string) => void
): Promise<{ text: string; events: KickflipEvent[] }> => {
  try {
    const registrySource = systemEvents.length > 0 ? systemEvents : FEATURED_EVENTS;

    const data = await fetchChatStream(`${API_URL}/api/chat`, { query }, onChunk);

    const rawEvents: KickflipEvent[] = (data.events || []).map((e: any, index: number) => {
      const existingRecord = registrySource.find(r =>
        r.id === e.id ||
        (r.title && e.title && r.title.toLowerCase() === e.title.toLowerCase() && r.date === e.date)
      );
      if (existingRecord) return existingRecord;

      const eventId = `discovered-${Date.now()}-${index}`;
      const safeCategory = e.category || 'other';
      return {
        ...e,
        id: eventId,
        title: e.title || 'Untitled Event',
        locationName: e.location,
        location: e.location || 'Seattle',
        vibeDescription: e.description,
        description: e.description || '',
        category: safeCategory,
        vibeTags: e.vibeTags || [],
        startDate: e.startDate || null,
        startTime: e.startTime || null,
        date: e.date || 'Upcoming',
        videoUrl: e.videoUrl || getVideoForEvent(safeCategory, eventId),
        price: e.price || '',
        link: e.link || '#',
      };
    });

    return {
      text: data.text || 'Checking the local scene for you...',
      events: rawEvents,
    };
  } catch (error) {
    console.error('Discovery Engine Error:', error);
    return {
      text: 'Connection bumpy. The engine is resetting... try that again?',
      events: [],
    };
  }
};
