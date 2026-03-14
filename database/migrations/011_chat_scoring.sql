-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011: Chat Scoring — save every /api/chat interaction + LLM scores
--
-- Tables:
--   chat_conversations  — one row per /api/chat call (query + response + events)
--   chat_scores         — LLM-auto or human scores per conversation
--
-- KPI view:
--   chat_helpfulness_kpi — daily helpfulness % by score_type
--
-- Safe to run multiple times (CREATE ... IF NOT EXISTS / CREATE OR REPLACE).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_conversations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT,                          -- pseudonymized HMAC token, never raw Google sub
  user_message     TEXT        NOT NULL,
  ai_response      TEXT        NOT NULL DEFAULT '',
  events_returned  JSONB,                         -- [{id, title, category}] — first 10 results
  source           TEXT,                          -- 'cache'|'semantic_fast'|'semantic'|'embedding'|'websearch'|'chronological'
  similarity_score FLOAT,                         -- top pgvector similarity score (null for websearch/cache)
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_conversations_created_idx ON chat_conversations (created_at DESC);
CREATE INDEX IF NOT EXISTS chat_conversations_user_idx    ON chat_conversations (user_id);

-- ── Scores ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_scores (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  score_type       TEXT        NOT NULL,   -- 'llm_auto' | 'user_feedback' | 'human_review'
  score            TEXT        NOT NULL CHECK (score IN ('helpful','somewhat_helpful','not_helpful')),
  score_reason     TEXT,
  scored_by        TEXT,                   -- null (user_feedback) | 'claude-haiku-4-5-20251001' | admin name
  scored_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (conversation_id, score_type)     -- one score per type per conversation
);

CREATE INDEX IF NOT EXISTS chat_scores_convo_idx  ON chat_scores (conversation_id);
CREATE INDEX IF NOT EXISTS chat_scores_scored_idx ON chat_scores (scored_at DESC);

-- ── KPI view ──────────────────────────────────────────────────────────────────
-- SELECT * FROM chat_helpfulness_kpi WHERE score_type = 'llm_auto' ORDER BY day DESC LIMIT 30;

CREATE OR REPLACE VIEW chat_helpfulness_kpi AS
SELECT
  DATE(scored_at)                                                              AS day,
  score_type,
  COUNT(*)                                                                     AS total,
  COUNT(*) FILTER (WHERE score = 'helpful')                                   AS helpful,
  COUNT(*) FILTER (WHERE score = 'somewhat_helpful')                          AS somewhat_helpful,
  COUNT(*) FILTER (WHERE score = 'not_helpful')                               AS not_helpful,
  ROUND(100.0 * COUNT(*) FILTER (WHERE score = 'helpful') / COUNT(*), 1)     AS helpfulness_pct
FROM chat_scores
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
