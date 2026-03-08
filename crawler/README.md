# Kickflip Crawler — Python/FastAPI Service

Playwright-based event crawler that ingests 30+ named Seattle sources
using a 4-layer extraction pipeline (JSON-LD → microdata → site profile → heuristics).

> **Deployment status:** Migrated from Railway to **AWS ECS Fargate** (ephemeral run-once containers).
> The crawler no longer runs as an always-on server — it starts on demand, runs the full crawl, and exits.

---

## Architecture (AWS)

```
UI / cron
   │
   ▼
API Gateway (HTTP)  ──► POST /api/crawl         ──► Lambda: kickflip-crawl-trigger
https://bol57k4dtb.execute-api.us-east-1.amazonaws.com
   │                ──► POST /crawl/trigger      ──► Lambda: kickflip-crawl-trigger
   │                ──► GET  /jobs/{job_id}      ──► Lambda: kickflip-get-job-status
   │                ──► GET  /jobs/{job_id}/logs ──► Lambda: kickflip-get-job-logs
   │
   ▼
ECS Fargate (ephemeral)
   │  Runs app/entrypoint.py  (one-shot crawl)
   │  Writes stdout → CloudWatch Logs  (live, during run)
   │  Uploads JSONL log → S3            (on completion)
   │  Writes results → Supabase DB
   ▼
Supabase PostgreSQL
   kickflip_events   — crawled events
   kickflip_jobs     — job status + metadata
```

**EventBridge Scheduler** triggers a daily crawl at 3:00 AM UTC automatically.

---

## API Endpoints

**Base URL:** `https://bol57k4dtb.execute-api.us-east-1.amazonaws.com`

All protected endpoints require:
```
Authorization: Bearer <CRON_SECRET>
```

---

### POST `/api/crawl`
> UI-compatible alias for the crawl trigger. Used by `AdminDashboardView.tsx`.

**Request**
```http
POST /api/crawl
Authorization: Bearer <CRON_SECRET>
Content-Type: application/json

{ "sources": ["https://example.com/events"] }
```
> Note: `sources` is accepted but ignored — the crawler uses `sources.yaml` baked into the Docker image.

**Response `202`**
```json
{
  "job_id":   "550e8400-e29b-41d4-a716-446655440000",
  "task_arn": "arn:aws:ecs:us-east-1:...:task/kickflip/abc123",
  "task_id":  "abc123",
  "status":   "queued",
  "detail":   "ECS task started"
}
```
> `eventsCreated` is absent — the UI uses `data.eventsCreated ?? 0` so it shows `0` until the async crawl finishes.

---

### POST `/crawl/trigger`
> Direct trigger endpoint. Returns the same shape as `/api/crawl`.

```http
POST /crawl/trigger
Authorization: Bearer <CRON_SECRET>
```

**Response `202`** — same as `/api/crawl` above.

---

### GET `/jobs/{job_id}`
> Poll job status. Returns immediately.

```http
GET /jobs/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <CRON_SECRET>
```

**Response `200`**
```json
{
  "job_id":         "550e8400-e29b-41d4-a716-446655440000",
  "status":         "running",
  "created_at":     "2024-01-01T03:00:00Z",
  "started_at":     "2024-01-01T03:00:45Z",
  "finished_at":    null,
  "duration_ms":    null,
  "ecs_task_id":    "4f3ecca4...",
  "log_line_count": 0,
  "logs_url":       "/jobs/550e8400-.../logs",
  "summary":        null
}
```

**`status` values:** `queued` → `running` → `completed` | `failed`

**`summary` when completed:**
```json
{
  "status": "completed",
  "totals": {
    "sources":              12,
    "urls_discovered":      148,
    "pages_fetched":        148,
    "events_parsed":        93,
    "events_stored":        41,
    "events_filtered_past": 52,
    "errors":               3
  },
  "duration_ms": 187432
}
```

---

### GET `/jobs/{job_id}/logs`
> Fetch structured log lines. Poll this endpoint every 3 seconds during a running job.

```http
GET /jobs/550e8400-.../logs?since_ms=0
Authorization: Bearer <CRON_SECRET>
```

**Query params**

| Param | Default | Description |
|-------|---------|-------------|
| `since_ms` | `0` | Unix ms timestamp — returns only events after this time. Pass `next_ms` from previous response. |

**Response `200`**
```json
{
  "job_id":  "550e8400-...",
  "status":  "running",
  "lines": [
    {
      "timestamp":   "2024-01-01 03:00:45,123",
      "level":       "INFO",
      "logger":      "kickflip.crawler.dynamic",
      "message":     "fetch",
      "source_name": "acm-events",
      "stage":       "fetch",
      "url":         "https://acm.org/events/seattle",
      "elapsed_ms":  312
    },
    {
      "timestamp": "2024-01-01 03:00:46,456",
      "level":     "ERROR",
      "logger":    "kickflip.crawler.static",
      "message":   "parse failed",
      "source_name": "some-source",
      "exception": ["Traceback ...", "..."]
    }
  ],
  "next_ms": 1704074406456,
  "done":    false,
  "source":  "cloudwatch"
}
```

| Field | Description |
|-------|-------------|
| `lines` | Structured log objects. Each has at minimum `message`. BoundLogger lines include `source_name`, `stage`, `url`, `elapsed_ms`. |
| `next_ms` | Pass as `since_ms` on the next poll to get only new lines. |
| `done` | `true` when job is `completed` or `failed` — stop polling. |
| `source` | `cloudwatch` (running) → `s3` (completed, full structured log) → `db` (fallback) |

---

## UI Integration Guide

### Current integration (AdminDashboardView)

The admin panel's **"Sync Supply"** button already calls `/api/crawl` and works without changes.
It shows `✓ Crawl triggered — 0 new events ingested.` (async — results available after crawl finishes).

### Adding live job monitoring (optional enhancement)

```typescript
const API_BASE  = import.meta.env.VITE_API_URL;   // https://bol57k4dtb...
const API_TOKEN = import.meta.env.VITE_CRON_SECRET;

const headers = { Authorization: `Bearer ${API_TOKEN}` };

// 1. Trigger crawl → get job_id immediately
async function triggerCrawl() {
  const res  = await fetch(`${API_BASE}/api/crawl`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: [] }),
  });
  const { job_id } = await res.json();
  return job_id;
}

// 2. Poll status until done
async function waitForJob(job_id: string) {
  while (true) {
    const res  = await fetch(`${API_BASE}/jobs/${job_id}`, { headers });
    const data = await res.json();
    if (data.status === 'completed' || data.status === 'failed') return data;
    await new Promise(r => setTimeout(r, 5000));
  }
}

// 3. Stream logs while running (poll every 3s)
async function* streamLogs(job_id: string) {
  let nextMs = 0;
  while (true) {
    const res  = await fetch(`${API_BASE}/jobs/${job_id}/logs?since_ms=${nextMs}`, { headers });
    const data = await res.json();

    for (const line of data.lines) yield line;   // { timestamp, level, message, source_name, ... }

    if (data.done) break;
    nextMs = data.next_ms;
    await new Promise(r => setTimeout(r, 3000));
  }
}

// Usage
const job_id = await triggerCrawl();

for await (const line of streamLogs(job_id)) {
  const color = line.level === 'ERROR' ? 'red' : 'green';
  console.log(`[${line.level}] ${line.source_name ?? ''} ${line.message}`);
}

const result = await waitForJob(job_id);
console.log(`Done: ${result.summary?.totals?.events_stored} events stored`);
```

---

## Recent Changes

### Migrated from Railway → AWS ECS Fargate

| Before (Railway) | After (AWS) |
|-----------------|-------------|
| Always-on FastAPI server (`uvicorn`) | Ephemeral ECS Fargate container (exits after crawl) |
| `POST /run` triggers synchronous crawl | `POST /api/crawl` starts async ECS task, returns immediately |
| Logs in Railway dashboard | Logs in CloudWatch + S3 JSONL file |
| Daily cron via `railway.toml` | EventBridge Scheduler (`cron(0 3 * * ? *)`) |
| Response: `{ eventsCreated: N }` (blocking) | Response: `{ job_id, status: "queued" }` (non-blocking) |

### New files added

| File | Purpose |
|------|---------|
| `app/entrypoint.py` | Run-once ECS entrypoint — replaces uvicorn server mode for AWS |
| `Dockerfile` | Two-stage build: Python deps + Playwright Chromium |
| `aws/deploy.sh` | One-shot full deployment script (ECR → ECS → Lambda → EventBridge) |
| `aws/add-api-triggers.sh` | Wire Lambda functions to existing API Gateway |
| `aws/setup-log-s3.sh` | Create S3 log bucket + IAM permissions |
| `aws/lambdas/get_job_status/handler.py` | Lambda: `GET /jobs/{job_id}` |
| `aws/lambdas/get_job_logs/handler.py` | Lambda: `GET /jobs/{job_id}/logs` |
| `aws/migrations/001_add_ecs_task_id.sql` | Add `ecs_task_id` column to `kickflip_jobs` |
| `aws/migrations/002_add_log_s3_key.sql` | Add `log_s3_key` column to `kickflip_jobs` |

### Key entrypoint changes (`app/entrypoint.py`)

- **Stdout tee**: Captures ALL log output (including structured `BoundLogger` fields: `source_name`, `stage`, `url`, `elapsed_ms`) before any app imports
- **S3 upload**: At job completion, uploads full JSONL log to `s3://kickflip-crawler-logs-<account>/logs/{job_id}.jsonl`
- **Pre-generated `JOB_ID`**: Trigger Lambda passes `JOB_ID` env override so DB row exists before container starts — eliminates 404 race condition
- **Structured log format**: Every log line is a JSON object with full context; the logs Lambda parses and returns these as structured objects

### DB migrations required

Run in Supabase SQL Editor:

```sql
-- Migration 001
ALTER TABLE kickflip_jobs ADD COLUMN IF NOT EXISTS ecs_task_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_kickflip_jobs_ecs_task_id ON kickflip_jobs(ecs_task_id);

-- Migration 002
ALTER TABLE kickflip_jobs ADD COLUMN IF NOT EXISTS log_s3_key TEXT DEFAULT NULL;
```

---

## Local Development

```bash
cd crawler

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium

cp .env.example .env
# Fill in DATABASE_URL, LLM_API_KEY, CRON_SECRET, SUPABASE_* vars

# Run the FastAPI server (server mode — not used on AWS but works locally)
python run.py --reload

# Or run the ECS entrypoint locally (one-shot crawl)
python -m app.entrypoint
```

**Local health check:** http://localhost:8000/health

**Trigger crawl locally (server mode):**
```bash
curl -X POST http://localhost:8000/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## AWS Deployment

### Prerequisites

- AWS CLI configured (`aws configure`)
- Docker Desktop running
- Git Bash (Windows) or bash (Mac/Linux)

### First-time deploy

```bash
cd KickflipEvents/crawler

# 1. Run full deployment (ECR + Docker + Secrets + IAM + ECS + Lambda + EventBridge)
bash aws/deploy.sh

# 2. Wire Lambda functions to API Gateway
bash aws/add-api-triggers.sh <your-api-gateway-id>

# 3. Set up S3 log storage
bash aws/setup-log-s3.sh

# 4. Run DB migrations in Supabase SQL Editor
#    aws/migrations/001_add_ecs_task_id.sql
#    aws/migrations/002_add_log_s3_key.sql
```

### Re-deploy after code changes

```bash
# Code change in app/ → rebuild Docker image
ECR_URI="<account>.dkr.ecr.us-east-1.amazonaws.com/kickflip-crawler"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${ECR_URI}
docker build --platform linux/amd64 -t kickflip-crawler:latest .
docker tag kickflip-crawler:latest ${ECR_URI}:latest
docker push ${ECR_URI}:latest

# Lambda code change → redeploy only affected Lambda
# (see aws/deploy.sh Step 8 for packaging commands)
```

### Manual crawl trigger

```bash
aws ecs run-task \
  --cluster kickflip \
  --task-definition kickflip-crawler \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<subnet-id>],securityGroups=[<sg-id>],assignPublicIp=ENABLED}' \
  --region us-east-1
```

### Watch live logs

```bash
aws logs tail /kickflip/crawler --follow --region us-east-1
```

---

## Environment Variables

### ECS Task (via AWS Secrets Manager `kickflip/crawler/prod`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase Transaction Pooler URL (port 6543) |
| `LLM_API_KEY` | Google AI Studio key (embeddings + LLM fallback) |
| `CRON_SECRET` | Bearer token for Lambda auth |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `SUPABASE_JWKS_URL` | Supabase JWKS endpoint |

### ECS Task (plain environment)

| Variable | Value |
|----------|-------|
| `LOG_S3_BUCKET` | `kickflip-crawler-logs-<account-id>` |
| `ENABLE_PLAYWRIGHT` | `true` |
| `LOG_LEVEL` | `INFO` |

### Lambda functions

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Same Supabase pooler URL |
| `CRON_SECRET` | Same bearer token |
| `LOG_S3_BUCKET` | S3 bucket for log reads |
| `CW_LOG_GROUP` | `/kickflip/crawler` |
| `CW_STREAM_PREFIX` | `crawler` |
| `CW_CONTAINER_NAME` | `kickflip-crawler` |
