-- =============================================================================
-- Migration 002: Add source_url to saved_events and event_clicks
--
-- Why:
--   Events discovered via real-time AI search may not exist in kickflip_events.
--   To trace an event back to its source (e.g. Eventbrite, RA, live search),
--   we store source_url directly on both tables so the link is retrievable
--   without a JOIN to kickflip_events or JSONB extraction from event_payload.
--
-- Run in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS guards).
-- =============================================================================

-- ─── saved_events ─────────────────────────────────────────────────────────────

-- 1. Add source_url column for direct, indexed link access
ALTER TABLE saved_events
  ADD COLUMN IF NOT EXISTS source_url TEXT;

-- 2. Backfill from event_payload->>'link' for all existing rows
UPDATE saved_events
  SET source_url = event_payload->>'link'
  WHERE source_url IS NULL
    AND event_payload->>'link' IS NOT NULL
    AND event_payload->>'link' <> '';

-- 3. Partial index — only covers rows that have a link (keeps index small)
CREATE INDEX IF NOT EXISTS saved_events_source_url_idx
  ON saved_events (source_url)
  WHERE source_url IS NOT NULL;

-- ─── event_clicks ─────────────────────────────────────────────────────────────

-- 4. Add source_url to capture the event link at click time.
--    Critical for live-search / ephemeral events that are never persisted to
--    kickflip_events, so analytics can still surface their origin URL.
ALTER TABLE event_clicks
  ADD COLUMN IF NOT EXISTS source_url TEXT;

-- No index needed — source_url on event_clicks is a data-capture field, not
-- a filter. Use event_id + action indexes for all analytics queries.

-- =============================================================================
-- Verification queries (run to confirm):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'saved_events'   AND column_name = 'source_url';
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'event_clicks'   AND column_name = 'source_url';
-- =============================================================================
