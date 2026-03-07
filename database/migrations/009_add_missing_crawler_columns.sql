-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009: Add missing columns written by the Python Playwright crawler
--
-- The Python crawler's upsert SQL references columns that don't exist yet
-- in the kickflip_events table.  All additions are safe to run multiple times
-- (IF NOT EXISTS guard).
--
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS image_url    TEXT,
    ADD COLUMN IF NOT EXISTS event_url    TEXT,
    ADD COLUMN IF NOT EXISTS ticket_url   TEXT,
    ADD COLUMN IF NOT EXISTS venue        TEXT,
    ADD COLUMN IF NOT EXISTS address      TEXT,
    ADD COLUMN IF NOT EXISTS city         TEXT DEFAULT 'Seattle',
    ADD COLUMN IF NOT EXISTS state        TEXT DEFAULT 'WA',
    ADD COLUMN IF NOT EXISTS organizer    TEXT,
    ADD COLUMN IF NOT EXISTS is_free      BOOLEAN,
    ADD COLUMN IF NOT EXISTS crawl_method TEXT,
    ADD COLUMN IF NOT EXISTS event_summary TEXT;
