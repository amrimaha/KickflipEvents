# Kickflip Crawler — Python/FastAPI Service

Playwright-based event crawler that ingests 30+ named Seattle sources
using a 4-layer extraction pipeline (JSON-LD → microdata → site profile → heuristics).

## Setup (for Ravi)

This directory is the root for the Railway Python crawler service.
Copy your `kp-backend` code here:

```bash
# From the repo root:
cp -r /path/to/kp-backend/app        crawler/app
cp    /path/to/kp-backend/sources.yaml  crawler/sources.yaml
cp    /path/to/kp-backend/requirements.txt crawler/requirements.txt
cp    /path/to/kp-backend/pyproject.toml  crawler/pyproject.toml  # if exists
```

Then update the DB connection in `app/config.py` (or `.env`) to point at the
shared Supabase project — use the same `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
as the Node.js service.

## Required env vars (set on Railway Service B)

| Variable | Source |
|----------|--------|
| `SUPABASE_URL` | Same as Node.js service |
| `SUPABASE_SERVICE_ROLE_KEY` | Same as Node.js service |
| `ANTHROPIC_API_KEY` | Same as Node.js service |
| `VOYAGE_API_KEY` | Same as Node.js service |
| `CRON_SECRET` | Same as Node.js service |
| `ENABLE_PLAYWRIGHT` | `true` |
| `MAX_CONCURRENT_SOURCES` | `3` |
| `RESPECT_ROBOTS_TXT` | `true` |
| `ENABLE_LLM_FALLBACK` | `false` (enable per-source when needed) |
| `PLAYWRIGHT_BROWSERS_PATH` | `/ms-playwright` |

## Railway deployment

- **Root directory**: `crawler` (set in Railway service settings)
- **Build**: nixpacks auto-detects Python from `requirements.txt`
- **Start**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Cron**: runs daily at 3am UTC (staggered from Node.js crawl at 6am UTC)

## How it connects to the Node.js service

Both services write to the **same Supabase `kickflip_events` table**.
No cross-service HTTP calls. The DB is the integration point.

- Playwright crawl sets `origin = 'playwright_crawl'`
- Claude web_search crawl sets `origin = 'crawl'`
- Live discovered events set `origin = 'live_discovered'`

The Node.js `POST /api/chat` reads all origins transparently.

## Schema

Run `database/migrations/004_schema_align.sql` in Supabase before first crawl.
This adds the columns Ravi's crawler writes (`is_active`, `venue`, `address`,
`city`, `state`, `is_free`, `ticket_url`, `event_url`, `event_summary`)
and a trigger that syncs `is_active` with `expires_at`.
