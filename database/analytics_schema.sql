-- =============================================================================
-- KickflipEvents — Analytics Schema
-- Addendum to schema.sql — run AFTER the main schema is applied.
-- All formulas used here are documented in METRICS_CALCULATIONS.md
-- =============================================================================

-- =============================================================================
-- COLUMN ADDITION: users.last_seen_at
-- Updated on every authenticated API call.
-- Used for Monthly Active Users (MAU) computation.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen_at DESC);

-- =============================================================================
-- TABLE: user_sessions
-- One row per discrete user session. A session is a continuous period of
-- activity; a new session begins if the user is inactive for ≥30 minutes.
--
-- Used to compute: Interaction Time (avg session duration)
--
-- Columns:
--   session_start   — timestamp of first action in this session
--   session_end     — timestamp of last action (NULL = session still open)
--   query_count     — number of /api/chat calls during this session
--   action_count    — total API calls during this session
--   duration_secs   — computed from (session_end - session_start) in seconds
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_sessions (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL = anonymous
  session_start   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_end     TIMESTAMPTZ,
  query_count     INT DEFAULT 0,         -- /api/chat calls
  action_count    INT DEFAULT 0,         -- total tracked API calls
  duration_secs   FLOAT,                 -- filled when session_end is set
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx   ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_start_idx  ON user_sessions (session_start DESC);
CREATE INDEX IF NOT EXISTS user_sessions_end_idx    ON user_sessions (session_end DESC);

-- =============================================================================
-- TABLE: api_requests
-- One row per inbound API request. Stores latency for every tracked endpoint.
--
-- Used to compute: Response Time (avg /api/chat latency over last 7 days)
--
-- Columns:
--   endpoint        — e.g. '/api/chat', '/api/auth/google'
--   method          — 'GET' | 'POST' | 'DELETE' | 'PATCH'
--   user_id         — NULL for unauthenticated calls
--   session_id      — FK to user_sessions (NULL if no session context)
--   response_time_ms — wall-clock time from req received to res sent
--   status_code     — HTTP response status
--   source          — 'cache' | 'embedding' | 'claude' | 'websearch' (chat only)
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_requests (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint          TEXT NOT NULL,
  method            TEXT NOT NULL DEFAULT 'POST',
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id        UUID REFERENCES user_sessions(id) ON DELETE SET NULL,
  response_time_ms  INT NOT NULL,
  status_code       INT NOT NULL,
  source            TEXT,                -- 'cache' | 'embedding' | 'claude' | 'websearch'
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_requests_endpoint_idx    ON api_requests (endpoint);
CREATE INDEX IF NOT EXISTS api_requests_user_idx        ON api_requests (user_id);
CREATE INDEX IF NOT EXISTS api_requests_created_idx     ON api_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS api_requests_status_idx      ON api_requests (status_code);

-- =============================================================================
-- TABLE: platform_metrics_snapshots
-- A computed row saved every 5 minutes by the /api/admin/metrics/snapshot
-- endpoint (called by Railway cron or on-demand). The telemetry dashboard
-- reads the most recent row; historical rows enable trend charts.
--
-- All column formulas are documented in METRICS_CALCULATIONS.md.
-- =============================================================================
CREATE TABLE IF NOT EXISTS platform_metrics_snapshots (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- User metrics
  mau                   INT NOT NULL DEFAULT 0,  -- Monthly Active Users (30-day window)
  unique_users_total    INT NOT NULL DEFAULT 0,  -- COUNT(*) from users (lifetime)
  new_users_today       INT NOT NULL DEFAULT 0,  -- users created since midnight UTC

  -- Engagement metrics
  avg_interaction_secs  FLOAT,                   -- AVG(duration_secs) from user_sessions, last 30d
  avg_response_time_ms  FLOAT,                   -- AVG(response_time_ms) from api_requests where endpoint='/api/chat', last 7d
  p95_response_time_ms  FLOAT,                   -- 95th percentile of chat response times, last 7d
  total_queries_today   INT NOT NULL DEFAULT 0,  -- /api/chat calls since midnight UTC
  cache_hit_rate_pct    FLOAT,                   -- % of queries served from cache today

  -- Supply metrics
  total_events          INT NOT NULL DEFAULT 0,  -- COUNT(*) from kickflip_events where status='active'
  user_events           INT NOT NULL DEFAULT 0,  -- COUNT(*) where origin='user'
  crawl_events          INT NOT NULL DEFAULT 0,  -- COUNT(*) where origin='crawl'
  provider_pct          FLOAT,                   -- user_events / total_events * 100
  crawler_pct           FLOAT,                   -- crawl_events / total_events * 100
  crawl_sources_count   INT NOT NULL DEFAULT 0,  -- number of registered crawl source URLs (config)

  -- Session metrics
  active_sessions_now   INT NOT NULL DEFAULT 0,  -- user_sessions where session_end IS NULL and session_start > NOW()-1h
  total_sessions_today  INT NOT NULL DEFAULT 0,  -- user_sessions started since midnight UTC

  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metrics_snapshots_computed_idx ON platform_metrics_snapshots (computed_at DESC);

-- =============================================================================
-- FUNCTION: compute_platform_metrics()
-- Computes all telemetry metrics and inserts a new snapshot row.
-- Call this via /api/admin/metrics/snapshot or pg_cron every 5 minutes.
--
-- Formula reference: see METRICS_CALCULATIONS.md
-- =============================================================================
CREATE OR REPLACE FUNCTION compute_platform_metrics(p_crawl_sources_count INT DEFAULT 0)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id                  UUID;
  v_mau                 INT;
  v_unique_users        INT;
  v_new_users_today     INT;
  v_avg_interaction     FLOAT;
  v_avg_response        FLOAT;
  v_p95_response        FLOAT;
  v_total_queries_today INT;
  v_cache_hit_rate      FLOAT;
  v_total_events        INT;
  v_user_events         INT;
  v_crawl_events        INT;
  v_provider_pct        FLOAT;
  v_crawler_pct         FLOAT;
  v_active_sessions     INT;
  v_total_sessions      INT;
  v_today_start         TIMESTAMPTZ;
BEGIN
  v_today_start := DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC');

  -- MAU: distinct users with last_seen_at in last 30 days
  SELECT COUNT(*) INTO v_mau
  FROM users
  WHERE last_seen_at > NOW() - INTERVAL '30 days'
    AND is_banned = FALSE;

  -- Unique users total (non-banned)
  SELECT COUNT(*) INTO v_unique_users FROM users WHERE is_banned = FALSE;

  -- New users today (UTC midnight boundary)
  SELECT COUNT(*) INTO v_new_users_today
  FROM users WHERE created_at >= v_today_start;

  -- Avg interaction time: mean session duration (sessions completed in last 30d)
  SELECT AVG(duration_secs) INTO v_avg_interaction
  FROM user_sessions
  WHERE session_end IS NOT NULL
    AND session_start > NOW() - INTERVAL '30 days'
    AND duration_secs > 10;  -- exclude sub-10s micro-sessions (bounces)

  -- Avg /api/chat response time (last 7 days)
  SELECT AVG(response_time_ms) INTO v_avg_response
  FROM api_requests
  WHERE endpoint = '/api/chat'
    AND status_code < 500
    AND created_at > NOW() - INTERVAL '7 days';

  -- P95 /api/chat response time (last 7 days)
  SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) INTO v_p95_response
  FROM api_requests
  WHERE endpoint = '/api/chat'
    AND status_code < 500
    AND created_at > NOW() - INTERVAL '7 days';

  -- Total chat queries today
  SELECT COUNT(*) INTO v_total_queries_today
  FROM api_requests
  WHERE endpoint = '/api/chat'
    AND created_at >= v_today_start;

  -- Cache hit rate today (% of chat queries served from cache)
  SELECT
    CASE WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(COUNT(*) FILTER (WHERE source = 'cache') * 100.0 / COUNT(*), 1)
    END INTO v_cache_hit_rate
  FROM api_requests
  WHERE endpoint = '/api/chat'
    AND created_at >= v_today_start;

  -- Supply metrics
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE origin = 'user'),
    COUNT(*) FILTER (WHERE origin = 'crawl')
  INTO v_total_events, v_user_events, v_crawl_events
  FROM kickflip_events
  WHERE status = 'active'
    AND (expires_at IS NULL OR expires_at > NOW());

  v_provider_pct := CASE WHEN v_total_events = 0 THEN 0
                         ELSE ROUND(v_user_events * 100.0 / v_total_events, 1) END;
  v_crawler_pct  := CASE WHEN v_total_events = 0 THEN 0
                         ELSE ROUND(v_crawl_events * 100.0 / v_total_events, 1) END;

  -- Active sessions (open sessions in last 1 hour)
  SELECT COUNT(*) INTO v_active_sessions
  FROM user_sessions
  WHERE session_end IS NULL
    AND session_start > NOW() - INTERVAL '1 hour';

  -- Total sessions started today
  SELECT COUNT(*) INTO v_total_sessions
  FROM user_sessions
  WHERE session_start >= v_today_start;

  -- Insert snapshot
  INSERT INTO platform_metrics_snapshots (
    mau, unique_users_total, new_users_today,
    avg_interaction_secs, avg_response_time_ms, p95_response_time_ms,
    total_queries_today, cache_hit_rate_pct,
    total_events, user_events, crawl_events, provider_pct, crawler_pct,
    crawl_sources_count, active_sessions_now, total_sessions_today
  ) VALUES (
    COALESCE(v_mau, 0),
    COALESCE(v_unique_users, 0),
    COALESCE(v_new_users_today, 0),
    v_avg_interaction,
    v_avg_response,
    v_p95_response,
    COALESCE(v_total_queries_today, 0),
    COALESCE(v_cache_hit_rate, 0),
    COALESCE(v_total_events, 0),
    COALESCE(v_user_events, 0),
    COALESCE(v_crawl_events, 0),
    COALESCE(v_provider_pct, 0),
    COALESCE(v_crawler_pct, 0),
    p_crawl_sources_count,
    COALESCE(v_active_sessions, 0),
    COALESCE(v_total_sessions, 0)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- =============================================================================
-- CRON: compute metrics every 5 minutes (enable via Supabase pg_cron)
-- =============================================================================
-- SELECT cron.schedule('metrics-snapshot', '*/5 * * * *', $$
--   SELECT compute_platform_metrics(0);
-- $$);

-- =============================================================================
-- CLEANUP: keep only 30 days of api_requests rows; keep snapshots for 90 days
-- Add to nightly-cleanup cron:
--   DELETE FROM api_requests WHERE created_at < NOW() - INTERVAL '30 days';
--   DELETE FROM platform_metrics_snapshots WHERE computed_at < NOW() - INTERVAL '90 days';
--   DELETE FROM event_clicks WHERE created_at < NOW() - INTERVAL '30 days';
-- =============================================================================

-- =============================================================================
-- CLICKSTREAM SCHEMA
--
-- Design rationale (senior engineering decisions):
--
-- 1. FLAT NORMALIZED TABLE (not pure JSONB)
--    Core fields (event_id, action, user_id, anon_id) are top-level columns with
--    B-tree indexes. This enables efficient GROUP BY, ORDER BY, and range scans
--    without GIN indexes, which are expensive on write-heavy tables.
--
-- 2. JSONB USED NARROWLY (extras column only)
--    Variable, rarely-queried metadata (cta_label, referrer, scroll_depth) goes in
--    a single JSONB `extras` column. This avoids a schema migration every time we
--    want to capture a new signal, while keeping the hot columns typed + indexed.
--
-- 3. ANON_ID ALWAYS PRESENT
--    A UUID stored in localStorage (key: kf_anon_id) is set on first page load.
--    It bridges anonymous → authenticated journeys: when a user signs in we can
--    link their pre-login clicks to their new user_id via shared anon_id.
--
-- 4. TWO-TIER STORAGE (hot + cold)
--    event_clicks      — raw, 30-day TTL (nightly cron deletes old rows)
--    event_click_daily — pre-aggregated daily rollup, lives forever
--    Nightly cron runs rollup_event_clicks_daily() before deleting raw rows.
--    This keeps storage costs low while preserving long-term trend data.
-- =============================================================================

-- =============================================================================
-- TABLE: event_clicks
-- Raw clickstream. One row per user action on an event card.
--
-- Actions:
--   view_detail    — card clicked → detail modal opened
--   cta_click      — primary CTA button pressed (Book Now / Get Tickets / etc.)
--   save           — event saved (bookmark on)
--   unsave         — event unsaved (bookmark off)
--   share          — share button pressed
--   checkout_start — CheckoutModal opened (native events only)
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_clicks (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id    TEXT        NOT NULL,                          -- kickflip_events.id
  action      TEXT        NOT NULL,                          -- see Actions above
  user_id     TEXT        REFERENCES users(id) ON DELETE SET NULL,  -- NULL = anonymous
  anon_id     TEXT        NOT NULL,                          -- localStorage UUID, always set
  session_id  UUID        REFERENCES user_sessions(id) ON DELETE SET NULL,
  source      TEXT,                                          -- 'browse' | 'search' | 'saved'
  extras      JSONB,                                         -- cta_label, referrer, etc.
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes covering the most common query patterns:
--   "How many views/clicks did event X get this week?"
CREATE INDEX IF NOT EXISTS event_clicks_event_action_idx ON event_clicks (event_id, action, created_at DESC);
--   "What did user Y interact with?"
CREATE INDEX IF NOT EXISTS event_clicks_user_idx         ON event_clicks (user_id, created_at DESC) WHERE user_id IS NOT NULL;
--   "Trace anonymous user's journey"
CREATE INDEX IF NOT EXISTS event_clicks_anon_idx         ON event_clicks (anon_id, created_at DESC);
--   "Funnel across all events in a time window"
CREATE INDEX IF NOT EXISTS event_clicks_action_time_idx  ON event_clicks (action, created_at DESC);

-- =============================================================================
-- TABLE: event_click_daily
-- Pre-aggregated daily rollup. One row per (event_id, action, date).
-- Populated nightly by rollup_event_clicks_daily(). Lives forever.
-- Enables long-term trend charts without querying the 30-day hot table.
-- =============================================================================
CREATE TABLE IF NOT EXISTS event_click_daily (
  event_id    TEXT  NOT NULL,
  action      TEXT  NOT NULL,
  date        DATE  NOT NULL,
  click_count INT   NOT NULL DEFAULT 0,
  uniq_count  INT   NOT NULL DEFAULT 0,  -- COUNT(DISTINCT COALESCE(user_id, anon_id))
  PRIMARY KEY (event_id, action, date)
);

CREATE INDEX IF NOT EXISTS event_click_daily_event_idx ON event_click_daily (event_id, date DESC);
CREATE INDEX IF NOT EXISTS event_click_daily_date_idx  ON event_click_daily (date DESC);

-- =============================================================================
-- FUNCTION: rollup_event_clicks_daily()
-- Aggregates yesterday's raw event_clicks into event_click_daily.
-- Designed to run nightly before the raw-row cleanup cron deletes rows older than 30d.
-- Safe to call multiple times (INSERT ... ON CONFLICT DO UPDATE).
-- =============================================================================
CREATE OR REPLACE FUNCTION rollup_event_clicks_daily()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_yesterday DATE := (NOW() AT TIME ZONE 'UTC')::DATE - 1;
BEGIN
  INSERT INTO event_click_daily (event_id, action, date, click_count, uniq_count)
  SELECT
    event_id,
    action,
    v_yesterday                                            AS date,
    COUNT(*)                                               AS click_count,
    COUNT(DISTINCT COALESCE(user_id, anon_id))             AS uniq_count
  FROM event_clicks
  WHERE created_at >= v_yesterday
    AND created_at <  v_yesterday + INTERVAL '1 day'
  GROUP BY event_id, action
  ON CONFLICT (event_id, action, date)
  DO UPDATE SET
    click_count = EXCLUDED.click_count,
    uniq_count  = EXCLUDED.uniq_count;
END;
$$;

-- =============================================================================
-- NIGHTLY CRON ORDER (run these in sequence):
--   1. SELECT rollup_event_clicks_daily();          -- aggregate yesterday
--   2. DELETE FROM event_clicks WHERE created_at < NOW() - INTERVAL '30 days';
-- =============================================================================
