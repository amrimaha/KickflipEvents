-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012: User Preferences — capture search intent for personalization
--
-- Table:
--   user_preferences — one row per (user, category), incremented on each search
--
-- Usage:
--   - After every /api/chat call, extract the inferred category from the
--     user's query (e.g., "sushi event" → category=food) and upsert here.
--   - At the start of /api/chat, load the user's top categories and inject
--     them into the Claude vibe prompt for personalized responses.
--
-- Privacy: user_id is a pseudonymized HMAC-SHA256 token, never raw Google sub.
-- Safe to run multiple times (CREATE ... IF NOT EXISTS).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_preferences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,
  category      TEXT        NOT NULL,   -- food | music | art | party | outdoor | wellness | comedy | sports | fashion | other
  search_count  INT         NOT NULL DEFAULT 1,
  keywords      TEXT[]      NOT NULL DEFAULT '{}',   -- ['sushi', 'ramen'] — raw search terms (deduped)
  last_searched TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, category)            -- one row per user+category, incremented on repeat
);

CREATE INDEX IF NOT EXISTS user_prefs_user_idx     ON user_preferences (user_id);
CREATE INDEX IF NOT EXISTS user_prefs_category_idx ON user_preferences (category);
CREATE INDEX IF NOT EXISTS user_prefs_searched_idx ON user_preferences (last_searched DESC);

-- ── Helper view: top category per user (useful for analytics) ─────────────────
CREATE OR REPLACE VIEW user_top_categories AS
SELECT
  user_id,
  category,
  search_count,
  keywords,
  last_searched,
  RANK() OVER (PARTITION BY user_id ORDER BY search_count DESC, last_searched DESC) AS rank
FROM user_preferences;
