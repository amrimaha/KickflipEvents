-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010: Drop user_id foreign key on event_clicks
--
-- Problem:
--   user_id TEXT REFERENCES users(id) was pointing at public.users,
--   but Supabase Auth stores users in auth.users.  Any click from a
--   logged-in user gets:
--     "insert or update on table event_clicks violates foreign key
--      constraint event_clicks_user_id_fkey"
--
-- Fix:
--   Drop the broken FK constraint.  user_id still stores the Supabase
--   auth UID (auth.users.id) for analytics — we just stop enforcing
--   referential integrity at the DB level, which is correct since
--   auth.users is in a different schema and not FK-referenceable in
--   Supabase's setup.
--
--   Anonymous clicks already pass user_id=NULL, so those were fine.
--   Only logged-in users hit this error.
--
-- Safe to run multiple times (uses IF EXISTS guard).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE event_clicks
    DROP CONSTRAINT IF EXISTS event_clicks_user_id_fkey;
