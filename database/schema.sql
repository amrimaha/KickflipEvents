-- =============================================================================
-- KickflipEvents — Complete Database Schema
-- Platform: Supabase (PostgreSQL 15 + pgvector extension)
-- Run this file once in the Supabase SQL editor to initialize all tables.
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- TABLE: users
-- Stores authenticated user profiles. Populated on first Google OAuth login.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,               -- Google OAuth `sub` (e.g. "1089234...")
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  avatar          TEXT,                           -- Google profile picture URL
  profile_photo   TEXT,                           -- custom uploaded avatar (base64 or Storage URL)
  cover_url       TEXT,                           -- profile cover image/video URL
  cover_type      TEXT CHECK (cover_type IN ('image', 'video')),
  phone           TEXT,
  stripe_account  TEXT,                           -- Stripe Connect account ID
  stripe_connected BOOLEAN DEFAULT FALSE,
  is_banned       BOOLEAN DEFAULT FALSE,
  notification_prefs JSONB DEFAULT '{
    "eventUpdates": true,
    "bookingConfirmations": true,
    "reminders": true,
    "productAnnouncements": false
  }'::jsonb,
  onboarding_prefs JSONB,                         -- { vibes, location, timing, completed }
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- TABLE: kickflip_events
-- Core event store. Supports both crawled and user-created events.
-- Includes pgvector embedding column for semantic search.
-- =============================================================================
CREATE TABLE IF NOT EXISTS kickflip_events (
  id              TEXT PRIMARY KEY,               -- slug or UUID
  title           TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN (
                    'music','food','art','outdoor','party',
                    'wellness','fashion','sports','comedy','other')),
  payload         JSONB NOT NULL,                 -- full KickflipEvent object
  embedding       vector(1024),                  -- Voyage AI voyage-large-2 embedding
  source_url      TEXT,                           -- original listing URL (crawled events)
  creator_id      TEXT REFERENCES users(id),      -- NULL for crawled events
  origin          TEXT DEFAULT 'crawl' CHECK (origin IN ('user', 'crawl')),
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'draft', 'completed')),
  start_date      DATE,                           -- parsed event start date for expiry filtering
  expires_at      TIMESTAMPTZ,                    -- crawled events expire after 14 days
  crawled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast pgvector ANN search
CREATE INDEX IF NOT EXISTS kickflip_events_embedding_idx
  ON kickflip_events USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index for category + date filtering
CREATE INDEX IF NOT EXISTS kickflip_events_category_idx ON kickflip_events (category);
CREATE INDEX IF NOT EXISTS kickflip_events_start_date_idx ON kickflip_events (start_date);
CREATE INDEX IF NOT EXISTS kickflip_events_creator_idx ON kickflip_events (creator_id);

-- =============================================================================
-- TABLE: saved_events
-- Users can bookmark/save events. One row per (user, event) pair.
-- Events past their start date are excluded from active queries.
-- =============================================================================
CREATE TABLE IF NOT EXISTS saved_events (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  event_payload   JSONB NOT NULL,                 -- snapshot of event data at save time
  saved_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS saved_events_user_idx ON saved_events (user_id);
CREATE INDEX IF NOT EXISTS saved_events_event_idx ON saved_events (event_id);

-- =============================================================================
-- TABLE: query_cache
-- Caches AI search results (embedding + Claude response) to save tokens.
-- TTL: 6 hours (enforced by expires_at; stale rows cleaned by cron).
-- =============================================================================
CREATE TABLE IF NOT EXISTS query_cache (
  query_hash      TEXT PRIMARY KEY,               -- SHA-256 of normalised query string
  query_text      TEXT NOT NULL,
  event_ids       TEXT[],                         -- array of event IDs returned
  result_text     TEXT,                           -- Claude's short vibe text
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS query_cache_expires_idx ON query_cache (expires_at);

-- =============================================================================
-- TABLE: crawl_jobs
-- Tracks each batch crawl run triggered by Railway cron or on-demand.
-- =============================================================================
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  target_url      TEXT,
  status          TEXT DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  events_found    INT DEFAULT 0,
  events_created  INT DEFAULT 0,
  logs            TEXT[],
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  error_message   TEXT
);

-- =============================================================================
-- TABLE: admin_logs
-- Audit trail for all admin actions (ban user, delete event, trigger crawl, etc.)
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_logs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_email     TEXT NOT NULL,
  action          TEXT NOT NULL,                  -- e.g. 'ban_user', 'delete_event', 'crawl_trigger'
  target_id       TEXT,                           -- user_id or event_id acted upon
  metadata        JSONB,                          -- extra context (IP, payload diff, etc.)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- TABLE: event_media
-- Stores media files (images/videos) attached to user-created events.
-- In production, files live in Supabase Storage; this table holds metadata.
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_media (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES kickflip_events(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('image', 'video')),
  storage_path    TEXT NOT NULL,                  -- Supabase Storage path
  public_url      TEXT NOT NULL,
  width           INT,
  height          INT,
  size_bytes      INT,
  display_order   INT DEFAULT 0,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- TABLE: event_bookings
-- Tracks ticket purchases / RSVPs for user-created events.
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_bookings (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES kickflip_events(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity        INT NOT NULL DEFAULT 1,
  total_price_cents INT,                          -- NULL for free events
  stripe_payment_intent TEXT,
  status          TEXT DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','cancelled','refunded')),
  booked_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_bookings_event_idx ON event_bookings (event_id);
CREATE INDEX IF NOT EXISTS event_bookings_user_idx  ON event_bookings (user_id);

-- =============================================================================
-- FUNCTION: search_events_by_embedding
-- Used by pgvector similarity search in server.js.
-- =============================================================================
CREATE OR REPLACE FUNCTION search_events_by_embedding(
  query_embedding vector(1024),
  match_threshold FLOAT,
  match_count     INT
)
RETURNS TABLE (
  id          TEXT,
  similarity  FLOAT,
  payload     JSONB
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    id,
    1 - (embedding <=> query_embedding) AS similarity,
    payload
  FROM kickflip_events
  WHERE
    (expires_at IS NULL OR expires_at > NOW())
    AND status = 'active'
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- Enable RLS on user-sensitive tables. Service role key bypasses all policies.
-- =============================================================================
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_bookings ENABLE ROW LEVEL SECURITY;

-- Users can read/update their own row
CREATE POLICY "users: own row" ON users
  FOR ALL USING (id = current_setting('app.user_id', TRUE));

-- Users can read/write their own saved events
CREATE POLICY "saved_events: own rows" ON saved_events
  FOR ALL USING (user_id = current_setting('app.user_id', TRUE));

-- Users can read their own bookings
CREATE POLICY "bookings: own rows" ON event_bookings
  FOR ALL USING (user_id = current_setting('app.user_id', TRUE));

-- =============================================================================
-- TRIGGERS: updated_at auto-update
-- =============================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER events_updated_at
  BEFORE UPDATE ON kickflip_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- CLEANUP CRON HINT (run in Supabase pg_cron or via Railway cron)
-- Deletes expired cache rows and old crawled events nightly.
-- SELECT cron.schedule('nightly-cleanup', '0 3 * * *', $$
--   DELETE FROM query_cache WHERE expires_at < NOW();
--   DELETE FROM kickflip_events WHERE expires_at < NOW() AND origin = 'crawl';
-- $$);
-- =============================================================================
