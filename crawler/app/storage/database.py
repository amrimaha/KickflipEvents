"""
Supabase / Postgres storage layer (asyncpg).

Tables:
  kickflip_events      — normalized events, upserted on id (PK)
  kickflip_batch_runs  — one row per /run invocation
  kickflip_batch_locks — prevents concurrent runs (per-day advisory lock)

Column mapping (our model → DB column):
  NormalizedEvent.id             → kickflip_events.id
  NormalizedEvent.title          → .title
  NormalizedEvent.start_datetime → .start_time
  NormalizedEvent.end_datetime   → .end_time
  NormalizedEvent.venue_name     → .venue
  NormalizedEvent.address        → .address
  NormalizedEvent.city           → .city
  NormalizedEvent.state          → .state
  NormalizedEvent.price_text     → .price
  NormalizedEvent.ticket_url     → .ticket_url
  NormalizedEvent.event_url      → .source_url  (the event detail page URL)
  NormalizedEvent.source_name    → .source_name
  NormalizedEvent.image_url      → .image_url
  NormalizedEvent.tags           → .categories  (JSONB array)
  NormalizedEvent.summary_short  → .event_summary
  NormalizedEvent.summary_long   → .description
  NormalizedEvent.confidence     → .confidence
  NormalizedEvent.extraction_method → .extraction_method
  NormalizedEvent.evidence_snippets → .evidence_snippets (text[])
  NormalizedEvent.raw_data       → .raw_data (JSONB)
  NormalizedEvent.last_seen_at   → .last_seen_at
  + fingerprint (content-based SHA-256 for fuzzy dedup)
  + source_domain (extracted from event_url)
  + organizer (surfaced from raw_data.organizer)
  + vibe_tags = [] (reserved for future enrichment pass)

Connection:
  DATABASE_URL env var → asyncpg pool with statement_cache_size=0
  Required for PgBouncer Transaction Pooler (Supabase port 6543).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

import asyncpg

from app.config import settings
from app.models.event import NormalizedEvent, make_fingerprint
from app.models.run import RunSummary
from app.utils.logger import BoundLogger
from app.utils.url_utils import extract_domain

log = BoundLogger("kickflip.db")

_pool: Optional[asyncpg.Pool] = None


# ── Pool lifecycle ────────────────────────────────────────────────────────────

async def create_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool

    dsn = settings.database_url
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL is not set. "
            "Set it to the Supabase Transaction Pooler connection string "
            "(Dashboard → Settings → Database → Connection string, port 6543)."
        )

    log.info("Creating asyncpg connection pool")
    _pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=2,
        max_size=10,
        command_timeout=30,
        # PgBouncer Transaction Pooler requires prepared statements to be OFF.
        statement_cache_size=0,
    )
    log.info("DB pool ready")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_json(val: Any) -> Optional[str]:
    if val is None:
        return None
    return json.dumps(val, default=str)


def _dt(val: Optional[datetime]) -> Optional[datetime]:
    """Ensure tz-aware (attach UTC if naive)."""
    if val is None:
        return None
    if val.tzinfo is None:
        return val.replace(tzinfo=timezone.utc)
    return val


# ── kickflip_events upsert ────────────────────────────────────────────────────

_UPSERT_SQL = """
INSERT INTO kickflip_events (
    id,          fingerprint,
    title,       start_time,   end_time,
    venue,       address,      city,         state,
    price,       ticket_url,
    source_url,  source_name,  source_domain,
    image_url,   organizer,
    event_summary,  description,
    categories,  vibe_tags,
    confidence,  extraction_method,  evidence_snippets,
    raw_data,
    is_active,   first_seen_at,  last_seen_at,  updated_at,
    expires_at
)
VALUES (
    $1,  $2,
    $3,  $4,  $5,
    $6,  $7,  $8,  $9,
    $10, $11,
    $12, $13, $14,
    $15, $16,
    $17, $18,
    $19::jsonb, $20::jsonb,
    $21, $22, $23,
    $24::jsonb,
    TRUE, NOW(), $25, NOW(),
    $26
)
ON CONFLICT (id) DO UPDATE SET
    title              = EXCLUDED.title,
    start_time         = EXCLUDED.start_time,
    end_time           = EXCLUDED.end_time,
    venue              = EXCLUDED.venue,
    address            = EXCLUDED.address,
    city               = EXCLUDED.city,
    state              = EXCLUDED.state,
    price              = EXCLUDED.price,
    ticket_url         = EXCLUDED.ticket_url,
    source_url         = EXCLUDED.source_url,
    image_url          = EXCLUDED.image_url,
    organizer          = EXCLUDED.organizer,
    event_summary      = EXCLUDED.event_summary,
    description        = EXCLUDED.description,
    categories         = EXCLUDED.categories,
    confidence         = EXCLUDED.confidence,
    extraction_method  = EXCLUDED.extraction_method,
    evidence_snippets  = EXCLUDED.evidence_snippets,
    raw_data           = EXCLUDED.raw_data,
    is_active          = (EXCLUDED.expires_at > NOW()),
    last_seen_at       = EXCLUDED.last_seen_at,
    updated_at         = NOW(),
    expires_at         = EXCLUDED.expires_at
RETURNING (xmax = 0) AS inserted
"""


async def upsert_event(event: NormalizedEvent, pool: asyncpg.Pool) -> bool:
    """
    Upsert a single event into kickflip_events.
    Returns True on success, False on DB error.
    """
    fingerprint = make_fingerprint(
        title=event.title,
        start_dt=event.start_datetime,
        venue=event.venue_name or "",
    )

    # Build final raw_data payload with source_base_url injected
    raw_data = dict(event.raw_data or {})
    raw_data["source_base_url"] = event.source_url  # the SourceConfig.base_url
    if event.image_source:
        raw_data["image_source"] = event.image_source

    organizer = str(raw_data.get("organizer", ""))
    categories_json = json.dumps(event.tags)
    vibe_tags_json = json.dumps([])  # reserved

    # ── expires_at: when the event is actually over ───────────────────────────
    # Priority: end_datetime (exact) → start_datetime (event begins = it's running)
    # → unknown date: keep for 30 days.
    # Both services (Python is_active and Node.js expires_at) use this value.
    now_utc = datetime.now(timezone.utc)
    if event.end_datetime:
        expires_at = _dt(event.end_datetime)
    elif event.start_datetime:
        expires_at = _dt(event.start_datetime)
    else:
        expires_at = now_utc + timedelta(days=30)

    # ── Skip past events entirely — never insert or update stale rows ────────
    # The normalizer already filters most past events; this is a DB-layer guard.
    if expires_at <= now_utc:
        log.info(
            "Skipping past event",
            stage="upsert_db",
            event_id=event.id,
            extra={"title": event.title[:60], "expires_at": expires_at.isoformat()},
        )
        return False

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                _UPSERT_SQL,
                event.id,         fingerprint,
                event.title,      _dt(event.start_datetime),  _dt(event.end_datetime),
                event.venue_name, event.address, event.city,  event.state,
                event.price_text or "Free",  event.ticket_url,
                event.event_url,  event.source_name,  extract_domain(event.event_url),
                event.image_url,  organizer,
                event.summary_short,  event.summary_long,
                categories_json,  vibe_tags_json,
                event.confidence, event.extraction_method.value,  event.evidence_snippets,
                _to_json(raw_data),
                _dt(event.last_seen_at),
                expires_at,
            )

        inserted = bool(row["inserted"]) if row else False
        log.info(
            "Upserted event",
            stage="upsert_db",
            event_id=event.id,
            extra={"title": event.title[:60], "action": "insert" if inserted else "update"},
        )
        return True

    except Exception as exc:
        log.error(
            f"Upsert failed: {exc}",
            stage="upsert_db",
            event_id=event.id,
            url=event.event_url,
        )
        return False


# ── kickflip_batch_runs ───────────────────────────────────────────────────────

async def create_batch_run(run_id: str, pool: asyncpg.Pool) -> int:
    """
    Insert a new row in kickflip_batch_runs (status=running).
    Returns the auto-increment integer id for the final UPDATE.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO kickflip_batch_runs
                (run_at, success, run_id,
                 discovered, fetched, normalized, upserted, expired,
                 errors, duration_ms, source_results)
            VALUES
                (NOW(), FALSE, $1,
                 0, 0, 0, 0, 0,
                 0, 0, '[]'::jsonb)
            RETURNING id
            """,
            run_id,
        )
    return int(row["id"]) if row else 0


async def finish_batch_run(
    db_run_id: int,
    run_id: str,
    summary: RunSummary,
    pool: asyncpg.Pool,
) -> None:
    """Update the kickflip_batch_runs row with final aggregated stats."""
    source_results_json = json.dumps(
        [sr.model_dump() for sr in summary.source_results], default=str
    )

    all_errors: list[str] = []
    for sr in summary.source_results:
        all_errors.extend(sr.errors[:3])
    error_msg = "; ".join(all_errors[:5])[:1000] if all_errors else None

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE kickflip_batch_runs SET
                success        = $2,
                error_msg      = $3,
                duration_ms    = $4,
                discovered     = $5,
                fetched        = $6,
                normalized     = $7,
                upserted       = $8,
                expired        = $9,
                errors         = $10,
                source_results = $11::jsonb
            WHERE id = $1
            """,
            db_run_id,
            summary.status == "completed",
            error_msg,
            summary.duration_ms,
            summary.total_urls_discovered,
            summary.total_pages_fetched,
            summary.total_events_parsed,
            summary.total_events_stored,
            summary.total_events_filtered_past,
            summary.total_errors,
            source_results_json,
        )


# ── kickflip_batch_locks ──────────────────────────────────────────────────────

async def try_acquire_lock(instance_id: str, pool: asyncpg.Pool) -> bool:
    """
    Try to acquire the batch lock for today.
    Returns True if acquired, False if a non-stale running lock already exists.

    Uses a serializable transaction + FOR UPDATE to avoid races.

    Stale-lock detection (two layers):
      1. Cross-check kickflip_jobs: if the job that owns the lock is already
         'completed' or 'failed', the lock was orphaned by a crash or OOM kill
         that prevented release_lock() from running.  Take it over immediately.
      2. Age fallback: if the owning job row is missing or still 'running' but
         the lock is older than batch_lock_stale_hours (default 6 h), treat it
         as stale and take it over.
    """
    stale_threshold = timedelta(hours=settings.batch_lock_stale_hours)

    async with pool.acquire() as conn:
        async with conn.transaction(isolation="serializable"):
            existing = await conn.fetchrow(
                """
                SELECT status, started_at, instance_id
                FROM kickflip_batch_locks
                WHERE run_date = CURRENT_DATE
                FOR UPDATE
                """
            )

            if existing is None:
                await conn.execute(
                    """
                    INSERT INTO kickflip_batch_locks
                        (run_date, status, instance_id, started_at)
                    VALUES (CURRENT_DATE, 'running', $1, NOW())
                    """,
                    instance_id,
                )
                log.info(f"Batch lock acquired by {instance_id}")
                return True

            status = existing["status"]
            started_at = existing["started_at"]
            if started_at.tzinfo is None:
                started_at = started_at.replace(tzinfo=timezone.utc)
            age = datetime.now(timezone.utc) - started_at

            if status == "running" and age < stale_threshold:
                # Cross-check: if the job that owns this lock has already
                # finished (completed/failed), it crashed without calling
                # release_lock().  Take over immediately instead of waiting
                # for the stale-hours timeout.
                owner_run_id = existing["instance_id"]
                owner_job = await conn.fetchrow(
                    "SELECT status FROM kickflip_jobs WHERE run_id = $1",
                    owner_run_id,
                )
                owner_alive = (
                    owner_job is not None
                    and owner_job["status"] in ("queued", "running")
                )
                if owner_alive:
                    log.warning(
                        f"Batch lock held by active job {owner_run_id!r} "
                        f"(age {int(age.total_seconds())}s) — rejecting run"
                    )
                    return False
                # Owner job is dead or missing — orphaned lock, fall through
                log.warning(
                    f"Batch lock held by dead/missing job {owner_run_id!r} "
                    f"(job status: {owner_job['status'] if owner_job else 'not found'}) "
                    "— taking over orphaned lock"
                )

            # Take over stale, completed, or orphaned lock
            await conn.execute(
                """
                UPDATE kickflip_batch_locks SET
                    status       = 'running',
                    instance_id  = $1,
                    started_at   = NOW(),
                    completed_at = NULL
                WHERE run_date = CURRENT_DATE
                """,
                instance_id,
            )
            log.info(f"Batch lock taken over (was {status!r}) by {instance_id}")
            return True


async def release_lock(instance_id: str, final_status: str, pool: asyncpg.Pool) -> None:
    """Mark the batch lock as 'completed' or 'failed'."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE kickflip_batch_locks SET
                status       = $2,
                completed_at = NOW()
            WHERE run_date = CURRENT_DATE AND instance_id = $1
            """,
            instance_id,
            final_status,
        )


# ── Inactivity marking ────────────────────────────────────────────────────────

async def mark_inactive_events(pool: asyncpg.Pool, days: int) -> int:
    """Mark events not seen in *days* days as inactive. Returns count updated."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE kickflip_events
            SET is_active = FALSE, updated_at = NOW()
            WHERE last_seen_at < $1 AND is_active = TRUE
            """,
            cutoff,
        )
    count = int(result.split()[-1]) if result else 0
    if count:
        log.info(f"Marked {count} events inactive (last_seen > {days}d ago)")
    return count


# ── Embedding backfill ────────────────────────────────────────────────────────

async def embed_pending_events(pool: asyncpg.Pool) -> int:
    """
    Embed kickflip_events rows that have no embedding yet, then write vectors
    back to the DB.  Also backfills is_free for any rows where it is NULL.

    Returns the count of events successfully embedded in this call.
    Does nothing (returns 0) when ENABLE_EMBEDDINGS is False or no API key.
    """
    from app.config import settings
    from app.utils.embedder import build_event_text, embed_texts

    if not settings.enable_embeddings:
        return 0

    api_key = settings.embedding_api_key or settings.llm_api_key
    if not api_key:
        log.warning("embed_pending_events: no EMBEDDING_API_KEY — skipping", stage="embed")
        return 0

    # ── Backfill is_free for unclassified rows (no API call needed) ───────────
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE kickflip_events
            SET is_free = (
                LOWER(COALESCE(price, '')) = ANY(ARRAY[
                    'free', '$0', '0', 'free admission', 'no charge',
                    'complimentary', 'free entry', 'free event',
                    'free ticket', 'free tickets', 'free with rsvp',
                    'free, rsvp required', 'free (rsvp)', 'free!'
                ])
                OR LOWER(COALESCE(price, '')) LIKE 'free%'
            )
            WHERE is_free IS NULL
            """
        )

    # ── Fetch events without an embedding ────────────────────────────────────
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, title, event_summary, description, venue, city, categories
            FROM kickflip_events
            WHERE embedding IS NULL AND is_active = TRUE
            ORDER BY last_seen_at DESC
            LIMIT 500
            """
        )

    if not rows:
        return 0

    events = [dict(r) for r in rows]
    ids    = [e["id"] for e in events]
    texts  = [build_event_text(e) for e in events]

    log.info(
        f"Embedding {len(texts)} event(s)",
        stage="embed",
        extra={"model": settings.embedding_model},
    )

    vectors = await embed_texts(
        texts,
        api_key=api_key,
        model=settings.embedding_model,
        provider=settings.embedding_provider,
        batch_size=settings.embedding_batch_size,
        task_type="RETRIEVAL_DOCUMENT",                      # indexing task type for Google
        output_dimensionality=settings.embedding_dimensions, # truncate to ≤2000 for HNSW
    )

    embedded = 0
    async with pool.acquire() as conn:
        for event_id, vec in zip(ids, vectors):
            if vec is None:
                continue
            # Inline as Postgres vector literal — safe because values are floats
            vec_str = "[" + ",".join(str(x) for x in vec) + "]"
            await conn.execute(
                "UPDATE kickflip_events "
                "SET embedding = $1::vector, updated_at = NOW() "
                "WHERE id = $2",
                vec_str,
                event_id,
            )
            embedded += 1

    log.info(f"Embedded {embedded}/{len(texts)} event(s)", stage="embed")
    return embedded


# ── Persistent job registry ───────────────────────────────────────────────────

async def insert_job(job_id: str, created_at: datetime, pool: asyncpg.Pool) -> None:
    """Insert a new job row with status='queued' on POST /run."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO kickflip_jobs (job_id, status, created_at, updated_at)
            VALUES ($1, 'queued', $2, NOW())
            ON CONFLICT (job_id) DO NOTHING
            """,
            job_id,
            created_at,
        )


async def mark_job_running(
    job_id: str, started_at: datetime, pool: asyncpg.Pool
) -> None:
    """Flip status to 'running' when the asyncio task begins."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE kickflip_jobs
            SET status = 'running', started_at = $2, updated_at = NOW()
            WHERE job_id = $1
            """,
            job_id,
            started_at,
        )


async def finish_job(
    job_id: str,
    status: str,
    finished_at: datetime,
    duration_ms: int,
    log_line_count: int,
    logs_expire_at: datetime,
    summary: Optional[dict],
    run_id: Optional[str],
    db_run_id: int,
    pool: asyncpg.Pool,
    log_lines: Optional[list[str]] = None,
) -> None:
    """
    Write the final state of a job including its full summary JSON and log content.

    log_lines are joined with newlines and stored in log_content TEXT so that
    GET /jobs/{id}/logs and /logs/raw can replay them after the crawler container
    exits (split-service architecture, scale-to-zero, or process crash recovery).
    """
    log_content = "\n".join(log_lines) if log_lines else None
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE kickflip_jobs
            SET status         = $2,
                finished_at    = $3,
                duration_ms    = $4,
                log_line_count = $5,
                logs_expire_at = $6,
                summary        = $7::jsonb,
                run_id         = $8,
                db_run_id      = $9,
                log_content    = $10,
                updated_at     = NOW()
            WHERE job_id = $1
            """,
            job_id,
            status,
            finished_at,
            duration_ms,
            log_line_count,
            logs_expire_at,
            _to_json(summary),
            run_id,
            db_run_id,
            log_content,
        )


async def orphan_stale_jobs(pool: asyncpg.Pool) -> int:
    """
    On server startup, mark any jobs still in 'queued' or 'running' state
    as 'failed' — they were killed by the previous process dying.

    Also releases any batch locks those jobs were holding so the next
    scheduled run can start immediately without waiting for the stale-hours
    timeout.

    Returns the number of jobs orphaned.
    """
    async with pool.acquire() as conn:
        # Collect run_ids of jobs we are about to orphan so we can release
        # their batch locks in the same connection.
        stale_rows = await conn.fetch(
            """
            SELECT run_id FROM kickflip_jobs
            WHERE status IN ('queued', 'running') AND run_id IS NOT NULL
            """
        )
        orphaned_run_ids = [r["run_id"] for r in stale_rows if r["run_id"]]

        result = await conn.execute(
            """
            UPDATE kickflip_jobs
            SET status      = 'failed',
                finished_at = NOW(),
                summary     = '{"error": "Server restarted during job execution"}'::jsonb,
                updated_at  = NOW()
            WHERE status IN ('queued', 'running')
            """
        )

        # Release any batch locks owned by the orphaned jobs so the next
        # POST /run does not have to wait for the stale-hours fallback.
        if orphaned_run_ids:
            await conn.execute(
                """
                UPDATE kickflip_batch_locks
                SET status       = 'failed',
                    completed_at = NOW()
                WHERE instance_id = ANY($1::text[]) AND status = 'running'
                """,
                orphaned_run_ids,
            )

    # asyncpg returns "UPDATE N" as a string
    try:
        return int(result.split()[-1])
    except Exception:
        return 0


async def list_jobs_db(pool: asyncpg.Pool, limit: int = 200) -> list[dict]:
    """Return all jobs newest-first. Does not include the summary JSONB."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT job_id, status, created_at, started_at, finished_at,
                   duration_ms, run_id, db_run_id, log_line_count, logs_expire_at
            FROM kickflip_jobs
            ORDER BY created_at DESC
            LIMIT $1
            """,
            limit,
        )
    return [dict(r) for r in rows]


async def get_job_db(job_id: str, pool: asyncpg.Pool) -> Optional[dict]:
    """Fetch one job including its summary JSONB and stored log_content."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT job_id, status, created_at, started_at, finished_at,
                   duration_ms, run_id, db_run_id, log_line_count, logs_expire_at,
                   summary, log_content
            FROM kickflip_jobs
            WHERE job_id = $1
            """,
            job_id,
        )
    if row is None:
        return None
    d = dict(row)
    # asyncpg may return JSONB as a str — parse it if so
    if isinstance(d.get("summary"), str):
        try:
            d["summary"] = json.loads(d["summary"])
        except Exception:
            pass
    return d


# ── Public event browse ───────────────────────────────────────────────────────

async def list_events_public(
    pool: asyncpg.Pool,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    fetch_limit: int = 500,
) -> list[dict]:
    """
    Return active upcoming events for the public GET /events endpoint.

    Events with NULL start_time satisfy all date filters and sort last.
    *fetch_limit* is intentionally larger than the caller's display limit so
    that Python-side category filtering still yields the requested number.
    """
    conditions: list[str] = ["is_active = TRUE"]
    params: list[Any] = []

    # Lower bound — default: start of today UTC
    lower = date_from if date_from is not None else datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    params.append(_dt(lower))
    conditions.append(f"(start_time IS NULL OR start_time >= ${len(params)})")

    # Upper bound
    if date_to is not None:
        params.append(_dt(date_to))
        conditions.append(f"(start_time IS NULL OR start_time <= ${len(params)})")

    params.append(fetch_limit)
    where = " AND ".join(conditions)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                id, title, event_summary, description, categories,
                venue, address, city, state,
                start_time, end_time,
                price, is_free, ticket_url, source_url, source_name, image_url
            FROM kickflip_events
            WHERE {where}
            ORDER BY start_time ASC NULLS LAST, id DESC
            LIMIT ${len(params)}
            """,
            *params,
        )
    return [dict(r) for r in rows]


# ── Semantic event search ─────────────────────────────────────────────────────

async def search_events_semantic(
    pool: asyncpg.Pool,
    query_embedding: list[float],
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    is_free: Optional[bool] = None,
    limit: int = 20,
) -> list[dict]:
    """
    Return events ranked by cosine similarity to *query_embedding*.

    Hard constraints (date window, is_free) are applied in SQL WHERE so the
    HNSW index works efficiently.  The embedding column is never SELECTed —
    only the computed distance float is returned as ``similarity``.

    The vector is inlined as a Postgres literal (safe: OpenAI vectors are
    pure floats — no user-supplied content ever appears here).
    """
    conditions: list[str] = ["is_active = TRUE", "embedding IS NOT NULL"]
    params: list[Any] = []

    # Date lower bound
    if date_from is not None:
        params.append(_dt(date_from))
        conditions.append(f"start_time >= ${len(params)}")
    else:
        params.append(_dt(datetime.now(timezone.utc)))
        conditions.append(f"start_time >= ${len(params)}")

    # Date upper bound
    if date_to is not None:
        params.append(_dt(date_to))
        conditions.append(f"start_time <= ${len(params)}")

    # Free filter
    if is_free is not None:
        params.append(is_free)
        conditions.append(f"is_free = ${len(params)}")

    params.append(limit)
    limit_ph = f"${len(params)}"

    where = " AND ".join(conditions)
    vec_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    sql = f"""
    SELECT
        id, title, start_time, end_time,
        venue, address, city, state,
        price, is_free,
        ticket_url, source_url, source_name, image_url,
        event_summary, description, categories,
        (embedding <=> '{vec_str}'::vector) AS similarity
    FROM kickflip_events
    WHERE {where}
    ORDER BY embedding <=> '{vec_str}'::vector
    LIMIT {limit_ph}
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)

    return [dict(r) for r in rows]


# ── Sample events ─────────────────────────────────────────────────────────────

async def fetch_upcoming_events_for_chat(
    pool: asyncpg.Pool,
    limit: int = 200,
    category: Optional[str] = None,
    date_from: Optional[datetime] = None,
) -> list[dict]:
    """
    Return upcoming active events for the /chat LLM system prompt catalog.
    Optionally filtered by category (Python-side, same pattern as list_events_public).
    """
    lower = date_from if date_from is not None else datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, title, event_summary, description, categories,
                   venue, address, city, state,
                   start_time, end_time,
                   price, is_free, ticket_url, source_url, image_url
            FROM kickflip_events
            WHERE is_active = TRUE AND start_time >= $1
            ORDER BY start_time ASC
            LIMIT $2
            """,
            _dt(lower),
            limit * 3 if category else limit,  # over-fetch for Python filter
        )

    events = [dict(r) for r in rows]

    if category:
        import json as _json
        cat_lower = category.lower()
        filtered = []
        for e in events:
            cats_raw = e.get("categories")
            try:
                cats = _json.loads(cats_raw) if isinstance(cats_raw, str) else (cats_raw or [])
            except Exception:
                cats = []
            if any(str(c).lower() == cat_lower for c in cats):
                filtered.append(e)
        events = filtered[:limit]
    else:
        events = events[:limit]

    return events


# ── Sample events ─────────────────────────────────────────────────────────────

async def fetch_sample_events(pool: asyncpg.Pool, limit: int = 3) -> list[dict]:
    """Return a small sample of recently stored future events for the /run response."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, title, start_time, venue, city, state,
                   price, source_url, categories, event_summary,
                   source_name, extraction_method, confidence
            FROM kickflip_events
            WHERE is_active = TRUE AND start_time > NOW()
            ORDER BY last_seen_at DESC, start_time ASC
            LIMIT $1
            """,
            limit,
        )
    return [dict(r) for r in rows]
