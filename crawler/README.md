# Kickflip Crawler — Python/FastAPI Service

Playwright-based event crawler that ingests 30+ named Seattle sources
using a 4-layer extraction pipeline (JSON-LD → microdata → site profile → heuristics).

This is Railway **Service B** in the KickflipEvents monorepo.
Service A (Node.js API) lives at the repo root.

## Local development

```bash
cd crawler

# Create a virtual env and install deps
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium

# Copy env file and fill in your values
cp .env.example .env

# Run the FastAPI server
python run.py --reload
# or:  uvicorn app.main:app --reload
```

Health check: http://localhost:8000/health

Trigger a crawl manually:
```bash
curl -X POST http://localhost:8000/run \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json"
```

## Required env vars (set on Railway Service B)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase Transaction Pooler URL (port 6543) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `SUPABASE_JWKS_URL` | Supabase JWKS endpoint for JWT auth |
| `LLM_API_KEY` | Google AI Studio key (for embeddings + optional LLM fallback) |
| `EMBEDDING_DIMENSIONS` | **Must be `1024`** to match shared Supabase VECTOR column |
| `ENABLE_PLAYWRIGHT` | `true` |
| `MAX_CONCURRENT_SOURCES` | `3` |
| `RESPECT_ROBOTS_TXT` | `true` |
| `CRON_SECRET` | Same value as Node.js service `CRON_SECRET` |

See `.env.example` for all options.

## Railway deployment

- **Root directory**: `crawler` (set in Railway service settings)
- **Build**: nixpacks auto-detects Python from `requirements.txt`
- **Start**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Cron**: runs daily at 3am UTC (staggered from Node.js crawl at 6am UTC)
- **Plan**: needs Railway Starter (~$5/mo) for Playwright memory (~512MB)

## How it connects to the Node.js service

Both services write to the **same Supabase `kickflip_events` table**.
No cross-service HTTP calls — the DB is the integration point.

| `origin` value | Set by |
|---------------|--------|
| `playwright_crawl` | This Python service |
| `crawl` | Node.js Claude web_search |
| `live_discovered` | Node.js live chat discovery |

Node.js `POST /api/chat` reads all origins transparently.

## Schema

Run `database/migrations/004_schema_align.sql` in Supabase **before first crawl**.
This adds the columns this crawler writes (`is_active`, `venue`, `address`,
`city`, `state`, `is_free`, `ticket_url`, `event_url`, `event_summary`)
and syncs `is_active` with `expires_at` via trigger.
