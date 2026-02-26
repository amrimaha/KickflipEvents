
import { GoogleGenAI } from "@google/genai";
import { KickflipEvent } from "../types";
import { DEFAULT_SYSTEM_INSTRUCTION, FEATURED_EVENTS, getVideoForEvent } from "../constants";

// Lazy initialization pattern to avoid top-level crashes if environment is not yet ready
const getAI = () => {
  // Safely retrieve API Key, handling potentially missing process
  let key = '';
  try {
    // Avoid direct access to `process` which might be statically replaced or missing
    // @ts-ignore
    if (typeof process !== 'undefined' && process.env) {
      // @ts-ignore
      key = process.env.API_KEY || '';
    }
  } catch (e) {}
  
  // Fallback for Vite/meta env if process is missing
  if (!key) {
    try {
      // @ts-ignore
      key = import.meta.env.API_KEY || '';
    } catch (e) {}
  }

  return new GoogleGenAI({ apiKey: key });
};

async function generateWithRetry(model: any, params: any, retries = 3): Promise<any> {
  try {
    return await model.generateContent(params);
  } catch (error: any) {
    const isNetworkError = error.message && (
        error.message.includes('Rpc failed') || 
        error.message.includes('xhr error') || 
        error.message.includes('fetch failed')
    );
    if (retries > 0 && isNetworkError) {
      await new Promise(resolve => setTimeout(resolve, 800));
      return generateWithRetry(model, params, retries - 1);
    }
    throw error;
  }
}

export const searchSeattleEvents = async (
    query: string, 
    systemEvents: KickflipEvent[] = []
): Promise<{ text: string; events: KickflipEvent[] }> => {
  try {
    const ai = getAI();
    const now = new Date();
    const currentDateTime = now.toLocaleString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric', 
      hour: 'numeric', 
      minute: 'numeric',
      timeZone: 'America/Los_Angeles'
    });
    
    // Use the passed system events (which includes user-created ones from Supabase) or fallback to static list
    const registrySource = systemEvents.length > 0 ? systemEvents : FEATURED_EVENTS;

    // Create a lightweight snapshot to save tokens but keep critical matching info
    const registrySnapshot = registrySource.map(e => ({ 
      id: e.id,
      title: e.title, 
      date: e.date, // Human readable
      startDate: e.startDate, // ISO
      location: e.locationName || e.location, // Prefer precise name
      description: e.vibeDescription || e.description, // Prefer vibe
      category: e.category,
      vibeTags: e.vibeTags,
      organizer: e.organizer
    }));

    const prompt = `
    INTERNAL SYSTEM RECORDS (OFFICIAL DATABASE - SOURCE OF TRUTH):
    ${JSON.stringify(registrySnapshot)}

    CURRENT DATE/TIME: ${currentDateTime} (Seattle Time)
    USER INPUT: "${query}"

    OPERATIONAL PROTOCOL:
    1. PRIORITY INDEXING:
       - The "INTERNAL SYSTEM RECORDS" list above contains real-time, user-published events.
       - YOU MUST SCAN THIS LIST FIRST.
       - If an Internal Record is relevant to the user's query (vibe, time, or category), it MUST be included in the results.
       - DO NOT hallucinate that these events are "past" or "fake". Trust the data provided.
    
    2. SEARCH STRATEGY: 
       - Broad Match: If the user says "fun", "music", or "anything", return a diverse mix of Internal Records.
       - Specific Match: If the user asks for a specific venue or artist in the list, return that exact record.
       - Web Fallback: Only use Google Search if the Internal Records are completely insufficient for the specific request.

    3. RESPONSE FORMAT:
       - Return valid JSON matching the schema.
       - "text": Conversational summary (EXTREMELY BRIEF. MAX 12 WORDS).
       - "events": Array of event objects.
    `;

    const response = await generateWithRetry(ai.models, {
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingBudget: 0 }
      },
    });

    const fullText = response.text || "";
    
    // Strict JSON extraction
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    let events: KickflipEvent[] = [];
    let conversationalText = "Checking the local scene for you...";

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.events) {
          events = parsed.events.map((e: any, index: number) => {
            // Check if this is an existing Internal Record by ID or Title match
            const existingRecord = registrySource.find(r => 
                r.id === e.id || 
                (r.title && e.title && r.title.toLowerCase() === e.title.toLowerCase() && r.date === e.date)
            );

            if (existingRecord) {
                return existingRecord; // Return the full, rich object from our system
            }

            // Otherwise, it's a new web discovery
            const eventId = `discovered-${Date.now()}-${index}`;
            // Ensure category is safe
            const safeCategory = e.category || 'other';
            const categoryVideo = getVideoForEvent(safeCategory, eventId);
            
            // Return safe object structure to prevent render crashes
            return {
                ...e,
                id: eventId,
                title: e.title || "Untitled Event",
                locationName: e.location, // Prefer unified field
                location: e.location || "Seattle",
                vibeDescription: e.description, // Prefer unified field
                description: e.description || "",
                category: safeCategory,
                vibeTags: e.vibeTags || [], // Strict array default
                startDate: e.startDate || null,
                startTime: e.startTime || null,
                date: e.date || "Upcoming",
                videoUrl: e.videoUrl || categoryVideo,
                price: e.price || "",
                link: e.link || "#"
            };
          });
        }
        if (parsed.text) {
          conversationalText = parsed.text;
        }
      } catch (e) {
        console.error("Discovery Engine JSON Parse Failure:", e);
      }
    } else {
        conversationalText = fullText.trim();
    }

    // Grounding Enrichment for Web Results Only
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks && events.length > 0) {
      events = events.map(evt => {
         // Don't overwrite links for internal records that already have them
         if (registrySource.some(r => r.id === evt.id)) return evt;

         const matchingChunk = chunks.find((c: any) => 
            (c.web?.title && evt.title && c.web.title.toLowerCase().includes(evt.title.toLowerCase())) || 
            (evt.organizer && c.web?.title && c.web.title.toLowerCase().includes(evt.organizer.toLowerCase()))
         );
         if (matchingChunk && matchingChunk.web?.uri) {
           return { ...evt, link: matchingChunk.web.uri };
         }
         return evt;
      });
    }

    return {
      text: conversationalText,
      events
    };

  } catch (error) {
    console.error("Discovery Engine Critical Error:", error);
    return {
      text: "Connection bumpy. The engine is resetting... try that again?",
      events: []
    };
  }
};
