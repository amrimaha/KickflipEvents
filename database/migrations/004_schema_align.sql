-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004: Schema alignment for monorepo
--
-- Adds columns written by Ravi's Python Playwright crawler so both services
-- (Node.js API + Python crawler) share one kickflip_events table cleanly.
--
-- Safe to run multiple times (all statements use IF NOT EXISTS / OR REPLACE).
--
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- ── New columns for Ravi's crawler output ─────────────────────────────────────

ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS is_active      BOOLEAN   NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS event_url      TEXT,           -- canonical event page URL
  ADD COLUMN IF NOT EXISTS venue          TEXT,           -- venue name (flat string)
  ADD COLUMN IF NOT EXISTS address        TEXT,           -- street address
  ADD COLUMN IF NOT EXISTS city           TEXT DEFAULT 'Seattle',
  ADD COLUMN IF NOT EXISTS state          TEXT DEFAULT 'WA',
  ADD COLUMN IF NOT EXISTS is_free        BOOLEAN,        -- true | false | null (unknown)
  ADD COLUMN IF NOT EXISTS ticket_url     TEXT,           -- buy tickets link
  ADD COLUMN IF NOT EXISTS event_summary  TEXT,           -- AI-generated 1-2 sentence summary
  ADD COLUMN IF NOT EXISTS crawl_method   TEXT;           -- 'playwright_crawl' | 'claude_websearch' | 'live_discovered'

-- ── Index for Ravi's query pipeline (filters by is_active + start_time) ───────

CREATE INDEX IF NOT EXISTS idx_kickflip_events_is_active_start
  ON kickflip_events (is_active, start_time)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_kickflip_events_is_free
  ON kickflip_events (is_free)
  WHERE is_free IS NOT NULL;

-- ── Trigger: sync is_active from expires_at ───────────────────────────────────
-- Ravi's queries filter by is_active = TRUE.
-- Amrita's events use expires_at for TTL.
-- This trigger keeps them in sync so both approaches work on the same table.

CREATE OR REPLACE FUNCTION sync_is_active_from_expires()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- If expires_at is set and already passed, mark inactive
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at < NOW() THEN
    NEW.is_active := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_is_active ON kickflip_events;
CREATE TRIGGER trg_sync_is_active
  BEFORE INSERT OR UPDATE ON kickflip_events
  FOR EACH ROW EXECUTE FUNCTION sync_is_active_from_expires();

-- ── Scheduled cleanup: mark expired events inactive ───────────────────────────
-- Run this as a Supabase cron job (pg_cron) or call it from Railway cron.
-- Optional: create as an RPC so Node.js can call it after crawl.

CREATE OR REPLACE FUNCTION expire_old_events()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE kickflip_events
  SET    is_active = FALSE
  WHERE  expires_at IS NOT NULL
    AND  expires_at < NOW()
    AND  is_active = TRUE;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- ── Backfill: sync is_active for all existing rows ────────────────────────────
-- Marks any already-expired rows as inactive on first run.

UPDATE kickflip_events
SET    is_active = FALSE
WHERE  expires_at IS NOT NULL
  AND  expires_at < NOW()
  AND  is_active = TRUE;

-- ── RPC: date + is_free filtered semantic search ──────────────────────────────
-- Replaces the existing search_events_by_embedding RPC.
-- Adds optional date_from, date_to, and is_free filter params
-- so the Node.js /api/chat can pass query constraints from parsed user intent.

CREATE OR REPLACE FUNCTION search_events_by_embedding(
  query_embedding   VECTOR(1024),
  match_threshold   FLOAT     DEFAULT 0.72,
  match_count       INT       DEFAULT 10,
  date_from         TIMESTAMPTZ DEFAULT NULL,
  date_to           TIMESTAMPTZ DEFAULT NULL,
  filter_is_free    BOOLEAN   DEFAULT NULL
)
RETURNS TABLE (
  id          TEXT,
  similarity  FLOAT,
  payload     JSONB
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity,
    e.payload
  FROM kickflip_events e
  WHERE
    (e.expires_at IS NULL OR e.expires_at > NOW())
    AND (date_from IS NULL    OR COALESCE((e.payload->>'startDate')::DATE, NOW()::DATE) >= date_from::DATE)
    AND (date_to   IS NULL    OR COALESCE((e.payload->>'startDate')::DATE, NOW()::DATE) <= date_to::DATE)
    AND (filter_is_free IS NULL OR e.is_free = filter_is_free)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- ── RPC: chronological fallback (no embedding required) ───────────────────────
-- Used by Node.js when embedding API is unavailable or query returns 0 results.

CREATE OR REPLACE FUNCTION search_events_chronological(
  result_limit  INT         DEFAULT 10,
  date_from     TIMESTAMPTZ DEFAULT NULL,
  date_to       TIMESTAMPTZ DEFAULT NULL,
  filter_is_free BOOLEAN    DEFAULT NULL
)
RETURNS TABLE (
  id      TEXT,
  payload JSONB
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.payload
  FROM kickflip_events e
  WHERE
    (e.expires_at IS NULL OR e.expires_at > NOW())
    AND COALESCE((e.payload->>'startDate')::DATE, NOW()::DATE) >= COALESCE(date_from::DATE, NOW()::DATE)
    AND (date_to IS NULL OR COALESCE((e.payload->>'startDate')::DATE, NOW()::DATE) <= date_to::DATE)
    AND (filter_is_free IS NULL OR e.is_free = filter_is_free)
  ORDER BY (e.payload->>'startDate') ASC NULLS LAST
  LIMIT result_limit;
END;
$$;
