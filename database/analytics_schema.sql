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
-- =============================================================================
