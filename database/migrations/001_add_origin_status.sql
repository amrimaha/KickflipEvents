-- =============================================================================
-- Migration 001: Add origin + status columns to kickflip_events
--
-- Run this in Supabase SQL Editor ONCE if your kickflip_events table was
-- created before schema.sql was updated to include these columns.
-- Safe to re-run (all statements use IF NOT EXISTS / WHERE IS NULL guards).
-- =============================================================================

-- 1. Add origin column (crawl | user) — defaults to 'crawl' for existing rows
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'crawl'
  CHECK (origin IN ('user', 'crawl'));

-- 2. Add status column (active | draft | completed) — defaults to 'active'
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'draft', 'completed'));

-- 3. Add creator_id for provider-created events
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS creator_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- 4. Add source_url if missing (crawled events only)
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS source_url TEXT;

-- 5. Add crawl_source label (e.g. "Do206", "RA")
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS crawl_source TEXT;

-- 6. Add expires_at (crawled events expire after 14 days)
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 7. Add updated_at if missing
ALTER TABLE kickflip_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- =============================================================================
-- Backfill: fix any existing rows with NULL origin or status
-- Assumes any event with a creator_id was user-created, otherwise crawled.
-- =============================================================================
UPDATE kickflip_events
  SET origin = 'user'
  WHERE origin IS NULL AND creator_id IS NOT NULL;

UPDATE kickflip_events
  SET origin = 'crawl'
  WHERE origin IS NULL;

UPDATE kickflip_events
  SET status = 'active'
  WHERE status IS NULL;

-- =============================================================================
-- Indexes (safe to re-run with IF NOT EXISTS)
-- =============================================================================
CREATE INDEX IF NOT EXISTS kickflip_events_origin_idx  ON kickflip_events (origin);
CREATE INDEX IF NOT EXISTS kickflip_events_status_idx  ON kickflip_events (status);
CREATE INDEX IF NOT EXISTS kickflip_events_creator_idx ON kickflip_events (creator_id);
CREATE INDEX IF NOT EXISTS kickflip_events_expires_idx ON kickflip_events (expires_at);
