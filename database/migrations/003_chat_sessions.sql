-- =============================================================================
-- Migration 003: Chat session persistence
--
-- Data model:
--   chats           → one logical conversation thread per user
--   chat_sessions   → one "sitting" each time a user opens/resumes a chat
--   chat_messages   → individual turns (user + assistant) within a session
--
-- Privacy design:
--   user_pseudo_id  = HMAC-SHA256(real_user_id, PSEUDONYM_SECRET)
--   The raw user UUID is NEVER stored in these tables.
--   DB consumers (analysts, dashboard, read replicas) see only the HMAC token.
--   The Railway backend re-derives the token at query time to look up a user's chats.
--
-- Run in Supabase SQL Editor. Safe to re-run (CREATE TABLE IF NOT EXISTS guards).
-- =============================================================================

-- ─── chats ───────────────────────────────────────────────────────────────────
-- One row per logical conversation thread.
CREATE TABLE IF NOT EXISTS chats (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_pseudo_id TEXT,                         -- HMAC of real user_id, NULL for anon
  anon_id        TEXT,                         -- browser fingerprint for anon users
  title          TEXT        NOT NULL DEFAULT 'New Chat',  -- first message truncated
  is_archived    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chats_user_pseudo_id_idx
  ON chats (user_pseudo_id)
  WHERE user_pseudo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chats_updated_at_idx
  ON chats (updated_at DESC);

-- ─── chat_sessions ────────────────────────────────────────────────────────────
-- One row per "sitting". A user can resume an old chat, which opens a new session
-- tied to the same chat_id. session_num tracks which sitting this is (1, 2, 3…).
CREATE TABLE IF NOT EXISTS chat_sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id        UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_pseudo_id TEXT,
  anon_id        TEXT,
  session_num    INTEGER     NOT NULL DEFAULT 1,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ                           -- NULL = session still active
);

CREATE INDEX IF NOT EXISTS chat_sessions_chat_id_idx ON chat_sessions (chat_id);
CREATE INDEX IF NOT EXISTS chat_sessions_user_pseudo_id_idx
  ON chat_sessions (user_pseudo_id)
  WHERE user_pseudo_id IS NOT NULL;

-- ─── chat_messages ────────────────────────────────────────────────────────────
-- Individual turns. role = 'user' | 'assistant'.
-- content is stored as plaintext — user_pseudo_id breaks the identity link.
-- event_urls captures the external event links the assistant surfaced (important
-- for ephemeral / live-search events that are never persisted to kickflip_events).
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  session_id  UUID        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT        NOT NULL DEFAULT '',
  event_urls  TEXT[]      NOT NULL DEFAULT '{}',   -- URLs surfaced in this turn
  event_ids   TEXT[]      NOT NULL DEFAULT '{}',   -- kickflip_events IDs if matched
  seq         INTEGER     NOT NULL DEFAULT 0,       -- ordering within session
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_messages_chat_id_idx    ON chat_messages (chat_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages (session_id, seq);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
-- These tables are ONLY accessed via the Railway backend (service_role key).
-- The Supabase JS client (anon key) used by the React frontend never touches them.
-- Enabling RLS with no permissive policies blocks all client-side access while
-- allowing the service_role key to bypass RLS entirely.

ALTER TABLE chats         ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- No permissive policies → anon / authenticated roles have zero access.
-- Service role bypasses RLS automatically (Supabase default).

-- =============================================================================
-- Verification:
--   SELECT table_name FROM information_schema.tables
--     WHERE table_schema = 'public'
--     AND table_name IN ('chats','chat_sessions','chat_messages');
-- =============================================================================
