-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Add price column to kickflip_events
--
-- The Python crawler writes price as a plain text field (e.g. "Free", "$20").
-- This column was in Ravi's original schema but missing from Amrita's table.
--
-- Safe to run multiple times (IF NOT EXISTS guard).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS price TEXT NOT NULL DEFAULT 'Free';
