
import { KickflipEvent } from "../types";
import { FEATURED_EVENTS, getVideoForEvent } from "../constants";

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function fetchWithRetry(url: string, body: object, retries = 3): Promise<any> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error: any) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 800));
      return fetchWithRetry(url, body, retries - 1);
    }
    throw error;
  }
}

export const searchSeattleEvents = async (
  query: string,
  systemEvents: KickflipEvent[] = []
): Promise<{ text: string; events: KickflipEvent[] }> => {
  try {
    const registrySource = systemEvents.length > 0 ? systemEvents : FEATURED_EVENTS;

    const data = await fetchWithRetry(`${API_URL}/api/chat`, {
      query,
      events: registrySource,
    });

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
