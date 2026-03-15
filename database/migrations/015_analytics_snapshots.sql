-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015: Analytics Snapshots — daily batch job results
--
-- Stores pre-computed analytics for the provider dashboard Business Health tab:
--   neighborhoods     — top 5 event-dense neighborhoods (from kickflip_events)
--   avg_ticket_price  — average ticket price from non-free events
--   category_trends   — top 3 + bottom 3 categories from clickstream data
--
-- Batch job: POST /api/analytics/refresh (runs nightly, Railway cron 3am)
-- Ad hoc run: same endpoint, triggered from the dashboard UI
--
-- Safe to run multiple times (CREATE ... IF NOT EXISTS).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_type TEXT        NOT NULL,   -- 'neighborhoods' | 'avg_ticket_price' | 'category_trends'
  data          JSONB       NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast query: get latest snapshot per type ordered by computed_at
CREATE INDEX IF NOT EXISTS analytics_snapshots_type_computed_idx
  ON analytics_snapshots (snapshot_type, computed_at DESC);

-- Add created_at to event_clicks if missing (for 30-day trend window)
ALTER TABLE event_clicks
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Index for date-windowed clickstream queries
CREATE INDEX IF NOT EXISTS event_clicks_created_idx ON event_clicks (created_at DESC);
