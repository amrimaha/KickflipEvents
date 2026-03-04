-- =============================================================================
-- KickflipEvents — Complete Database Schema
-- Platform: Supabase (PostgreSQL 15 + pgvector extension)
-- Run this file once in the Supabase SQL editor to initialize all tables.
-- Re-running is safe: all statements use IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- TABLE: users
-- Stores authenticated user profiles. Populated on first Google OAuth login.
-- Includes provider (event creator) fields and admin flag.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,               -- Google OAuth `sub`
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  avatar            TEXT,                           -- Google profile picture URL
  profile_photo     TEXT,                           -- custom uploaded avatar (base64 or Storage URL)
  cover_url         TEXT,                           -- profile cover image/video URL
  cover_type        TEXT CHECK (cover_type IN ('image', 'video')),
  phone             TEXT,

  -- Provider (event creator) fields
  provider_name     TEXT,                           -- display name for their events
  provider_bio      TEXT,                           -- short bio shown on creator profile
  provider_website  TEXT,
  provider_instagram TEXT,
  is_provider       BOOLEAN DEFAULT FALSE,          -- true once they publish their first event

  -- Stripe Connect (for paid ticket events)
  stripe_account    TEXT,                           -- Stripe Connect account ID
  stripe_connected  BOOLEAN DEFAULT FALSE,

  -- Governance
  is_super_admin    BOOLEAN DEFAULT FALSE,          -- full admin panel access
  is_banned         BOOLEAN DEFAULT FALSE,
  ban_reason        TEXT,
  banned_at         TIMESTAMPTZ,

  -- Preferences
  notification_prefs JSONB DEFAULT '{
    "eventUpdates": true,
    "bookingConfirmations": true,
    "reminders": true,
    "productAnnouncements": false
  }'::jsonb,
  onboarding_prefs  JSONB,                          -- { vibes, location, timing, completed }

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx       ON users (email);
CREATE INDEX IF NOT EXISTS users_is_provider_idx ON users (is_provider) WHERE is_provider = TRUE;
CREATE INDEX IF NOT EXISTS users_is_admin_idx    ON users (is_super_admin) WHERE is_super_admin = TRUE;

-- =============================================================================
-- TABLE: kickflip_events
-- Core event store. Supports both crawled and user-created ("drop") events.
-- Includes pgvector embedding column for semantic AI search.
-- =============================================================================
CREATE TABLE IF NOT EXISTS kickflip_events (
  id              TEXT PRIMARY KEY,                 -- slug (user events) or UUID (crawled)
  title           TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN (
                    'music','food','art','outdoor','party',
                    'wellness','fashion','sports','comedy','other')),

  -- Full event object stored as JSONB (used by AI search and card rendering)
  payload         JSONB NOT NULL,

  -- Semantic search
  embedding       vector(1024),                     -- Voyage AI voyage-large-2

  -- Creator / ownership
  creator_id      TEXT REFERENCES users(id),        -- NULL for crawled events
  origin          TEXT DEFAULT 'crawl' CHECK (origin IN ('user', 'crawl')),
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'draft', 'completed')),

  -- Provider branding
  theme_color     TEXT,                             -- hex color for card
  vibemoji        JSONB,                            -- VibemojiConfig JSON

  -- Ticketing
  is_free         BOOLEAN DEFAULT TRUE,
  price_cents     INT,                              -- base price in cents (NULL for free)
  capacity        INT,                              -- max attendees (NULL = unlimited)

  -- Dates (denormalised from payload for fast range filtering)
  start_date      DATE,
  end_date        DATE,
  start_time      TEXT,                             -- HH:MM
  end_time        TEXT,

  -- Location (denormalised from payload)
  location_name   TEXT,
  address         TEXT,
  city            TEXT,

  -- Crawl metadata
  source_url      TEXT,                             -- original listing URL
  crawl_source    TEXT,                             -- e.g. "Eventbrite", "Do206"
  crawled_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,                      -- crawled events expire after 14 days

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- pgvector ANN index (build after first bulk insert for efficiency)
CREATE INDEX IF NOT EXISTS kickflip_events_embedding_idx
  ON kickflip_events USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS kickflip_events_category_idx   ON kickflip_events (category);
CREATE INDEX IF NOT EXISTS kickflip_events_start_date_idx ON kickflip_events (start_date);
CREATE INDEX IF NOT EXISTS kickflip_events_creator_idx    ON kickflip_events (creator_id);
CREATE INDEX IF NOT EXISTS kickflip_events_origin_idx     ON kickflip_events (origin);
CREATE INDEX IF NOT EXISTS kickflip_events_status_idx     ON kickflip_events (status);
CREATE INDEX IF NOT EXISTS kickflip_events_expires_idx    ON kickflip_events (expires_at);

-- =============================================================================
-- TABLE: event_media
-- Stores images/videos attached to user-created events.
-- Files live in Supabase Storage; this table holds metadata + display order.
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_media (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES kickflip_events(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('image', 'video')),
  storage_path    TEXT NOT NULL,                    -- Supabase Storage path
  public_url      TEXT NOT NULL,
  width           INT,
  height          INT,
  size_bytes      INT,
  duration_secs   FLOAT,                            -- video duration in seconds
  display_order   INT DEFAULT 0,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_media_event_idx ON event_media (event_id);

-- =============================================================================
-- TABLE: saved_events
-- Users can bookmark/save events. One row per (user, event) pair.
-- Full event snapshot stored at save time — profile page never re-fetches.
-- Past events are filtered out at query time.
-- =============================================================================
CREATE TABLE IF NOT EXISTS saved_events (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  event_payload   JSONB NOT NULL,                   -- full KickflipEvent snapshot
  saved_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS saved_events_user_idx  ON saved_events (user_id);
CREATE INDEX IF NOT EXISTS saved_events_event_idx ON saved_events (event_id);

-- =============================================================================
-- TABLE: event_bookings
-- Tracks ticket purchases / RSVPs for user-created (native) events.
-- Crawled / external events link out and do NOT have booking rows here.
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_bookings (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id                TEXT NOT NULL REFERENCES kickflip_events(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity                INT NOT NULL DEFAULT 1,
  unit_price_cents        INT,                      -- price per ticket in cents (NULL = free)
  total_price_cents       INT,                      -- quantity × unit_price_cents
  stripe_payment_intent   TEXT,                     -- Stripe PaymentIntent ID
  stripe_charge_id        TEXT,
  status                  TEXT DEFAULT 'confirmed' CHECK (
                            status IN ('pending','confirmed','cancelled','refunded')),
  cancelled_reason        TEXT,
  refunded_at             TIMESTAMPTZ,
  booked_at               TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, user_id)                        -- one booking record per (event, attendee)
);

CREATE INDEX IF NOT EXISTS event_bookings_event_idx  ON event_bookings (event_id);
CREATE INDEX IF NOT EXISTS event_bookings_user_idx   ON event_bookings (user_id);
CREATE INDEX IF NOT EXISTS event_bookings_status_idx ON event_bookings (status);

-- =============================================================================
-- TABLE: provider_payouts
-- Tracks Stripe Connect payouts to event creators.
-- One row per booking that generates revenue for a provider.
-- =============================================================================
CREATE TABLE IF NOT EXISTS provider_payouts (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id           TEXT NOT NULL REFERENCES users(id),
  event_id              TEXT NOT NULL REFERENCES kickflip_events(id),
  booking_id            UUID NOT NULL REFERENCES event_bookings(id),
  gross_amount_cents    INT NOT NULL,               -- booking total
  platform_fee_cents    INT NOT NULL,               -- Kickflip's cut (configurable %)
  net_amount_cents      INT NOT NULL,               -- gross - platform_fee
  stripe_transfer_id    TEXT,                       -- Stripe Transfer ID to provider's account
  stripe_account_id     TEXT,                       -- provider's Stripe Connect ID (snapshot)
  status                TEXT DEFAULT 'pending' CHECK (
                          status IN ('pending','transferred','failed','refunded')),
  transferred_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS provider_payouts_provider_idx ON provider_payouts (provider_id);
CREATE INDEX IF NOT EXISTS provider_payouts_event_idx    ON provider_payouts (event_id);
CREATE INDEX IF NOT EXISTS provider_payouts_status_idx   ON provider_payouts (status);

-- =============================================================================
-- TABLE: event_views
-- Lightweight analytics: records when a user opens an event detail page.
-- Used by the Creator Dashboard to show reach, source breakdown, and trends.
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_views (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES kickflip_events(id) ON DELETE CASCADE,
  viewer_id       TEXT REFERENCES users(id),        -- NULL for anonymous visitors
  viewed_at       TIMESTAMPTZ DEFAULT NOW(),
  source          TEXT                              -- 'search' | 'share' | 'direct' | 'profile'
);

CREATE INDEX IF NOT EXISTS event_views_event_idx  ON event_views (event_id);
CREATE INDEX IF NOT EXISTS event_views_viewer_idx ON event_views (viewer_id);
CREATE INDEX IF NOT EXISTS event_views_date_idx   ON event_views (viewed_at DESC);

-- =============================================================================
-- TABLE: query_cache
-- Caches AI search results (embedding + Claude response) to save API tokens.
-- TTL: 6 hours (expires_at). Stale rows cleaned by nightly cron.
-- =============================================================================
CREATE TABLE IF NOT EXISTS query_cache (
  query_hash      TEXT PRIMARY KEY,                 -- SHA-256 of normalised query string
  query_text      TEXT NOT NULL,
  event_ids       TEXT[],                           -- array of event IDs returned
  result_text     TEXT,                             -- Claude's short vibe text (≤12 words)
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
  status          TEXT DEFAULT 'queued' CHECK (
                    status IN ('queued','running','completed','failed')),
  events_found    INT DEFAULT 0,
  events_created  INT DEFAULT 0,
  events_updated  INT DEFAULT 0,
  events_failed   INT DEFAULT 0,
  logs            TEXT[],
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  error_message   TEXT,
  duration_ms     INT
);

CREATE INDEX IF NOT EXISTS crawl_jobs_status_idx     ON crawl_jobs (status);
CREATE INDEX IF NOT EXISTS crawl_jobs_started_at_idx ON crawl_jobs (started_at DESC);

-- =============================================================================
-- TABLE: admin_logs
-- Immutable audit trail for all admin actions. Append-only — never update.
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_logs (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id        TEXT NOT NULL REFERENCES users(id),
  admin_email     TEXT NOT NULL,
  action          TEXT NOT NULL,                    -- 'ban_user'|'delete_event'|'crawl_trigger' etc.
  target_id       TEXT,                             -- user_id or event_id acted upon
  target_type     TEXT CHECK (target_type IN ('user', 'event', 'crawl', 'system')),
  metadata        JSONB,                            -- extra context (reason, IP, payload diff)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_logs_admin_idx   ON admin_logs (admin_id);
CREATE INDEX IF NOT EXISTS admin_logs_action_idx  ON admin_logs (action);
CREATE INDEX IF NOT EXISTS admin_logs_target_idx  ON admin_logs (target_id);
CREATE INDEX IF NOT EXISTS admin_logs_created_idx ON admin_logs (created_at DESC);

-- =============================================================================
-- FUNCTION: search_events_by_embedding
-- Called by /api/chat for pgvector ANN similarity search.
-- Only returns active, non-expired events above the similarity threshold.
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
-- FUNCTION: get_provider_dashboard_stats
-- Returns aggregated stats for a creator's dashboard in a single round-trip.
-- =============================================================================
CREATE OR REPLACE FUNCTION get_provider_dashboard_stats(p_creator_id TEXT)
RETURNS JSONB
LANGUAGE SQL STABLE
AS $$
  SELECT jsonb_build_object(
    'total_events',        COUNT(DISTINCT e.id),
    'active_events',       COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'active'),
    'draft_events',        COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'draft'),
    'total_bookings',      COALESCE(SUM(b.quantity), 0),
    'total_revenue_cents', COALESCE(SUM(b.total_price_cents), 0),
    'total_views',         (
      SELECT COUNT(*) FROM event_views v
      WHERE v.event_id IN (SELECT id FROM kickflip_events WHERE creator_id = p_creator_id)
    )
  )
  FROM kickflip_events e
  LEFT JOIN event_bookings b
    ON b.event_id = e.id AND b.status = 'confirmed'
  WHERE e.creator_id = p_creator_id;
$$;

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- Service role key (backend) bypasses all policies automatically.
-- Anon / authenticated browser queries are restricted to own data.
-- =============================================================================
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_bookings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_views      ENABLE ROW LEVEL SECURITY;

-- Users: read / update own row only
CREATE POLICY "users: own row read"   ON users FOR SELECT USING (id = current_setting('app.user_id', TRUE));
CREATE POLICY "users: own row update" ON users FOR UPDATE USING (id = current_setting('app.user_id', TRUE));

-- Saved events: users access only their own rows
CREATE POLICY "saved_events: own rows" ON saved_events
  FOR ALL USING (user_id = current_setting('app.user_id', TRUE));

-- Bookings: attendee sees their bookings; provider sees bookings on their events
CREATE POLICY "bookings: own rows" ON event_bookings
  FOR SELECT USING (
    user_id = current_setting('app.user_id', TRUE)
    OR event_id IN (
      SELECT id FROM kickflip_events WHERE creator_id = current_setting('app.user_id', TRUE)
    )
  );

-- Payouts: providers see only their own payout rows
CREATE POLICY "payouts: own rows" ON provider_payouts
  FOR SELECT USING (provider_id = current_setting('app.user_id', TRUE));

-- Event views: users can insert their own view rows and read them
CREATE POLICY "event_views: insert own" ON event_views
  FOR INSERT WITH CHECK (viewer_id IS NULL OR viewer_id = current_setting('app.user_id', TRUE));
CREATE POLICY "event_views: read own" ON event_views
  FOR SELECT USING (viewer_id = current_setting('app.user_id', TRUE));

-- =============================================================================
-- TRIGGERS: updated_at auto-update
-- =============================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER events_updated_at
  BEFORE UPDATE ON kickflip_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- CLEANUP CRON (run via Supabase pg_cron or Railway cron at 3 AM PT = 11 AM UTC)
-- =============================================================================
-- SELECT cron.schedule('nightly-cleanup', '0 11 * * *', $$
--   DELETE FROM query_cache    WHERE expires_at < NOW();
--   DELETE FROM kickflip_events WHERE expires_at < NOW() AND origin = 'crawl';
--   DELETE FROM event_views    WHERE viewed_at < NOW() - INTERVAL '90 days';
-- $$);

-- =============================================================================
-- INITIAL SETUP: Promote your Google account to super-admin
-- Replace YOUR_GOOGLE_SUB with the `sub` value from your Google OAuth token.
-- =============================================================================
-- INSERT INTO users (id, name, email, is_super_admin)
-- VALUES ('YOUR_GOOGLE_SUB', 'Admin', 'admin@yourdomain.com', TRUE)
-- ON CONFLICT (id) DO UPDATE SET is_super_admin = TRUE;
