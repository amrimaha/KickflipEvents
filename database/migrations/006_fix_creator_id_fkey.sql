-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: Fix creator_id foreign key on kickflip_events
--
-- Problem:
--   creator_id TEXT REFERENCES users(id) was pointing at public.users,
--   but Supabase Auth stores users in auth.users.  Any provider publishing
--   an event gets:
--     "insert or update on table kickflip_events violates foreign key
--      constraint kickflip_events_creator_id_fkey"
--
-- Fix:
--   Drop the broken FK constraint.  creator_id still stores the Supabase
--   auth UID (auth.users.id) — we just stop enforcing referential integrity
--   at the DB level, which is correct since auth.users is in a different
--   schema and not accessible for FK references in Supabase's setup.
--
-- Safe to run multiple times (uses IF EXISTS guard).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE kickflip_events
    DROP CONSTRAINT IF EXISTS kickflip_events_creator_id_fkey;
