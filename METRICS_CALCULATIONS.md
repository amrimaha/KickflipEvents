# KickflipEvents — Platform Telemetry: Metric Definitions & Formulas

> **Schema file:** `database/analytics_schema.sql`
> **Backend endpoint:** `GET /api/admin/telemetry`
> **Snapshot function:** `compute_platform_metrics()` (called every 5 min)

All metrics are stored in `platform_metrics_snapshots`. The dashboard always reads the **most recent row** (`ORDER BY computed_at DESC LIMIT 1`).

---

## Table: `platform_metrics_snapshots`

| Column | Type | Formula |
|--------|------|---------|
| `mau` | INT | Count of distinct users with `last_seen_at > NOW() - 30 days` AND `is_banned = false` |
| `unique_users_total` | INT | `COUNT(*) FROM users WHERE is_banned = false` |
| `new_users_today` | INT | `COUNT(*) FROM users WHERE created_at >= midnight UTC today` |
| `avg_interaction_secs` | FLOAT | `AVG(duration_secs) FROM user_sessions WHERE session_end IS NOT NULL AND session_start > NOW()-30d AND duration_secs > 10` |
| `avg_response_time_ms` | FLOAT | `AVG(response_time_ms) FROM api_requests WHERE endpoint='/api/chat' AND status_code < 500 AND created_at > NOW()-7d` |
| `p95_response_time_ms` | FLOAT | `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) FROM api_requests ...same filter...` |
| `total_queries_today` | INT | `COUNT(*) FROM api_requests WHERE endpoint='/api/chat' AND created_at >= midnight UTC` |
| `cache_hit_rate_pct` | FLOAT | `COUNT(*) FILTER (WHERE source='cache') / COUNT(*) * 100 FROM api_requests today` |
| `total_events` | INT | `COUNT(*) FROM kickflip_events WHERE status='active' AND (expires_at IS NULL OR expires_at > NOW())` |
| `user_events` | INT | Same as above filtered by `origin='user'` |
| `crawl_events` | INT | Same as above filtered by `origin='crawl'` |
| `provider_pct` | FLOAT | `user_events / total_events * 100` (0 if total = 0) |
| `crawler_pct` | FLOAT | `crawl_events / total_events * 100` (0 if total = 0) |
| `crawl_sources_count` | INT | Count of registered crawl source URLs (passed in from server config at snapshot time) |
| `active_sessions_now` | INT | `COUNT(*) FROM user_sessions WHERE session_end IS NULL AND session_start > NOW()-1h` |
| `total_sessions_today` | INT | `COUNT(*) FROM user_sessions WHERE session_start >= midnight UTC` |
| `computed_at` | TIMESTAMPTZ | Timestamp of when this snapshot was computed |

---

## Table: `user_sessions`

One row per discrete user session (30-minute inactivity boundary = new session).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `user_id` | TEXT | FK → `users.id` (NULL for anonymous) |
| `session_start` | TIMESTAMPTZ | Timestamp of first action in this session |
| `session_end` | TIMESTAMPTZ | Timestamp of last action (NULL = session still open) |
| `query_count` | INT | Number of `/api/chat` calls during this session |
| `action_count` | INT | Total tracked API calls during this session |
| `duration_secs` | FLOAT | `EXTRACT(EPOCH FROM session_end - session_start)` — set when session is closed |

**Session lifecycle:**
1. User authenticates via `POST /api/auth/google` → new session row inserted
2. Any API call within 30 minutes → `session_end` and `action_count` updated
3. If >30 minutes since last call → next call creates a new session row

---

## Table: `api_requests`

One row per tracked API request. Used for response time and cache hit rate.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `endpoint` | TEXT | e.g. `'/api/chat'`, `'/api/auth/google'` |
| `method` | TEXT | HTTP method |
| `user_id` | TEXT | FK → `users.id` (NULL for unauthenticated) |
| `session_id` | UUID | FK → `user_sessions.id` |
| `response_time_ms` | INT | Wall-clock ms from request received to response sent |
| `status_code` | INT | HTTP response status |
| `source` | TEXT | For `/api/chat` only: `'cache'` \| `'embedding'` \| `'claude'` \| `'websearch'` |
| `created_at` | TIMESTAMPTZ | When the request was received |

**Tracked endpoints:** `/api/chat`, `/api/auth/google`, `/api/saved-events`

---

## Table: `users` additions

| Column | Type | Description |
|--------|------|-------------|
| `last_seen_at` | TIMESTAMPTZ | Updated on every authenticated API call — used for MAU calculation |

---

## Metric Formulas Explained

### Monthly Active Users (MAU)
```sql
SELECT COUNT(*)
FROM users
WHERE last_seen_at > NOW() - INTERVAL '30 days'
  AND is_banned = FALSE;
```
- **Window:** rolling 30-day lookback from NOW()
- **Excludes:** banned users, users who never authenticated since `last_seen_at` was added
- **Updates:** `last_seen_at` is set on every `POST /api/auth/google` and every `/api/chat` call where `user_id` is known

---

### Unique Users
```sql
SELECT COUNT(*) FROM users WHERE is_banned = FALSE;
```
- **Interpretation:** total lifetime registered user accounts (not just active)
- **Excludes:** banned accounts

---

### Interaction Time (avg session duration)
```sql
SELECT AVG(duration_secs)
FROM user_sessions
WHERE session_end IS NOT NULL
  AND session_start > NOW() - INTERVAL '30 days'
  AND duration_secs > 10;  -- exclude bounces < 10 seconds
```
- **Display format:** `Xm Ys` (e.g. `4m 12s`)
- **Formula:** `floor(avg_secs / 60)` minutes + `floor(avg_secs % 60)` seconds
- **10-second bounce filter:** sessions under 10s are likely page refreshes or bots
- **Session boundary:** 30-minute inactivity gap starts a new session

---

### Response Time (avg AI chat latency)
```sql
SELECT AVG(response_time_ms)
FROM api_requests
WHERE endpoint = '/api/chat'
  AND status_code < 500
  AND created_at > NOW() - INTERVAL '7 days';
```
- **Window:** last 7 days (balances recency vs sample size)
- **Excludes:** 5xx error responses (server crashes skew the metric)
- **Display format:** `Xms`
- **P95 also stored** in `p95_response_time_ms` for SLA monitoring

---

### Cache Hit Rate
```sql
SELECT
  COUNT(*) FILTER (WHERE source = 'cache') * 100.0 / COUNT(*)
FROM api_requests
WHERE endpoint = '/api/chat'
  AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC');
```
- **Window:** current UTC day (resets at midnight)
- **Source values:** `cache` (query_cache hit), `embedding` (vector search), `claude` (LLM formatting), `websearch` (live discovery)

---

### Supply Mix Distribution
```sql
SELECT
  COUNT(*)                              AS total_events,
  COUNT(*) FILTER (WHERE origin='user') AS user_events,
  COUNT(*) FILTER (WHERE origin='crawl') AS crawl_events
FROM kickflip_events
WHERE status = 'active'
  AND (expires_at IS NULL OR expires_at > NOW());
```
- **Provider %:** `user_events / total_events * 100`
- **Crawler %:** `crawl_events / total_events * 100`
- **Crawled events** expire after 14 days (set via `expires_at`) — expired rows don't count

---

## Dashboard Display Mapping

| Dashboard Card | Snapshot Column | Format |
|---------------|----------------|--------|
| MONTHLY ACTIVE | `mau` | `{n.toLocaleString()}` e.g. `12,842` |
| UNIQUE USERS | `unique_users_total` | `{n.toLocaleString()}` e.g. `8,921` |
| INTERACTION TIME | `avg_interaction_secs` | `{floor(s/60)}m {floor(s%60)}s` e.g. `4m 12s` |
| RESPONSE TIME | `avg_response_time_ms` | `{round(ms)}ms` e.g. `240ms` |
| PROVIDERS BAR | `provider_pct` | `{n}%` width on progress bar |
| CRAWLERS BAR | `crawler_pct` | `{n}%` width on progress bar |
| USER CREATED EVENTS | `user_events` | raw int |
| CRAWLED EVENTS | `crawl_events` | raw int |
| TOTAL IN REGISTRY | `total_events` | raw int |

---

## Data Retention Policy

| Table | Retention |
|-------|-----------|
| `api_requests` | 30 days (nightly cron deletes older rows) |
| `user_sessions` | 90 days |
| `platform_metrics_snapshots` | 90 days (enables 3-month trend charts) |

---

## Refresh Cadence

| Event | Action |
|-------|--------|
| Every 5 minutes | Railway cron calls `POST /api/admin/metrics/snapshot` → `compute_platform_metrics()` |
| Admin dashboard open | Fetches latest snapshot from `GET /api/admin/telemetry` |
| Admin dashboard auto-refresh | Polls `GET /api/admin/telemetry` every 30 seconds |
| Each `/api/chat` call | Writes 1 row to `api_requests`, updates `user_sessions`, updates `users.last_seen_at` |
| Each `POST /api/auth/google` | Writes/updates `user_sessions`, sets `users.last_seen_at = NOW()` |
