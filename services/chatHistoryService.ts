/**
 * chatHistoryService.ts
 *
 * Thin client for the chat session API on the Railway backend.
 * All calls are fire-and-forget friendly — callers should not block the UI
 * on these. Failures are silently swallowed (warnings in dev only).
 *
 * Privacy note:
 *   The backend never stores the raw user UUID in chat tables.
 *   It pseudonymizes it server-side with HMAC-SHA256.
 *   We pass user_id here only so the backend can derive the token.
 */

import { ChatMessage, ChatSession, KickflipEvent } from '../types';
import { getAnonId } from '../utils/anonId';

function apiBase(): string | undefined {
  return (import.meta as any).env?.VITE_API_URL;
}

const isDev = (import.meta as any).env?.DEV === true;

function warn(...args: unknown[]) {
  if (isDev) console.warn('[chatHistory]', ...args);
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a new chat thread + first session in one round-trip.
 * Returns { chatId, sessionId } or null if backend is unreachable.
 */
export async function apiCreateChat(
  userId: string,
  firstMessage: string,
): Promise<{ chatId: string; sessionId: string } | null> {
  const base = apiBase();
  if (!base) return null;

  try {
    const res = await fetch(`${base}/api/chats`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        user_id: userId,
        anon_id: getAnonId(),
        title:   firstMessage.trim().slice(0, 100),
      }),
    });
    if (!res.ok) { warn('createChat →', res.status); return null; }
    const data = await res.json();
    return { chatId: data.chat_id, sessionId: data.session_id };
  } catch (err) {
    warn('createChat error:', err);
    return null;
  }
}

/**
 * Start a new session on an existing chat (user resumed a past chat).
 * Returns sessionId or null.
 */
export async function apiStartSession(
  chatId: string,
  userId: string,
): Promise<{ sessionId: string; sessionNum: number } | null> {
  const base = apiBase();
  if (!base) return null;

  try {
    const res = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/sessions`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: userId }),
      },
    );
    if (!res.ok) { warn('startSession →', res.status); return null; }
    const data = await res.json();
    return { sessionId: data.session_id, sessionNum: data.session_num };
  } catch (err) {
    warn('startSession error:', err);
    return null;
  }
}

// ─── End session ──────────────────────────────────────────────────────────────

/**
 * Mark a session as ended. Safe to call on page unload via keepalive.
 */
export function apiEndSession(chatId: string, sessionId: string): void {
  const base = apiBase();
  if (!base) return;

  // keepalive:true ensures the request completes even on page unload
  fetch(
    `${base}/api/chats/${encodeURIComponent(chatId)}/sessions/${encodeURIComponent(sessionId)}/end`,
    { method: 'PUT', keepalive: true },
  ).catch(err => warn('endSession error:', err));
}

// ─── Store messages ───────────────────────────────────────────────────────────

/**
 * Persist a user + assistant turn to the backend. Fire-and-forget.
 * event_urls captures any external event links the assistant surfaced.
 */
export async function apiStoreMessages(
  chatId:      string,
  sessionId:   string,
  userText:    string,
  modelText:   string,
  events:      KickflipEvent[],
): Promise<void> {
  const base = apiBase();
  if (!base) return;

  const eventUrls = events.map(e => e.link).filter(Boolean);
  const eventIds  = events.map(e => e.id).filter(Boolean);

  try {
    await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          messages: [
            { role: 'user',      content: userText,  event_urls: [],        event_ids: []      },
            { role: 'assistant', content: modelText, event_urls: eventUrls, event_ids: eventIds },
          ],
        }),
      },
    );
  } catch (err) {
    warn('storeMessages error:', err);
  }
}

// ─── Load history ─────────────────────────────────────────────────────────────

/**
 * Fetch the chat list for a logged-in user.
 * Returns lightweight ChatSession[] (no messages loaded — loaded lazily on resume).
 */
export async function apiLoadChatHistory(userId: string): Promise<ChatSession[]> {
  const base = apiBase();
  if (!base) return [];

  try {
    const res = await fetch(`${base}/api/chats?user_id=${encodeURIComponent(userId)}`);
    if (!res.ok) { warn('loadHistory →', res.status); return []; }
    const data = await res.json();

    return (data.chats || []).map((c: {
      id: string;
      title: string;
      updated_at: string;
      last_session_id: string | null;
      session_count: number;
    }) => ({
      id:         c.last_session_id || c.id, // local id = most-recent session id
      chatId:     c.id,
      sessionId:  c.last_session_id,
      sessionNum: c.session_count,
      timestamp:  new Date(c.updated_at).getTime(),
      preview:    c.title,
      messages:   [],                         // loaded lazily on select
    } satisfies ChatSession));
  } catch (err) {
    warn('loadHistory error:', err);
    return [];
  }
}

/**
 * Fetch all messages for a chat (used when a user resumes a past chat).
 * Returns ChatMessage[] ordered chronologically.
 */
export async function apiLoadChatMessages(
  chatId: string,
  userId: string,
): Promise<ChatMessage[]> {
  const base = apiBase();
  if (!base) return [];

  try {
    const res = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatId)}?user_id=${encodeURIComponent(userId)}`,
    );
    if (!res.ok) { warn('loadMessages →', res.status); return []; }
    const data = await res.json();

    return (data.messages || []).map((m: {
      role:    string;
      content: string;
    }) => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: m.content,
      // We don't restore event card arrays from history — events may be stale.
      // The user can re-search if needed. event_urls are stored for analytics.
    } satisfies ChatMessage));
  } catch (err) {
    warn('loadMessages error:', err);
    return [];
  }
}
