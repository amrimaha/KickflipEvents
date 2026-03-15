-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014: Soften chat_scores.conversation_id FK for user feedback
--
-- Problem: chat_scores had a HARD FK to chat_conversations(id) NOT NULL.
-- When a user clicks thumbs up/down immediately, saveConversation (fire-and-
-- forget) may not have committed yet → FK violation → feedback lost.
--
-- Fix: Drop the FK constraint, make conversation_id nullable (soft reference).
-- The join still works: SELECT * FROM chat_scores s JOIN chat_conversations c
-- ON c.id = s.conversation_id WHERE s.conversation_id IS NOT NULL;
--
-- Safe to run multiple times (DROP IF EXISTS, ADD COLUMN IF NOT EXISTS).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop the hard FK + NOT NULL constraint on conversation_id
ALTER TABLE chat_scores
  DROP CONSTRAINT IF EXISTS chat_scores_conversation_id_fkey;

ALTER TABLE chat_scores
  ALTER COLUMN conversation_id DROP NOT NULL;

-- 2. Add score_source column to distinguish user_feedback from llm_auto
ALTER TABLE chat_scores
  ADD COLUMN IF NOT EXISTS user_id TEXT;   -- pseudonymized, for dedup

-- 3. Index for quick lookup by conversation
CREATE INDEX IF NOT EXISTS chat_scores_convid_idx ON chat_scores (conversation_id)
  WHERE conversation_id IS NOT NULL;
