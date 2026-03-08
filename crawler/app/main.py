"""
Kickflip Event Parser — FastAPI application.

Endpoints:
  GET  /health                    → liveness + readiness probe
  POST /run                       → enqueue a background crawl (202 Accepted)
  GET  /jobs                      → list recent jobs, newest first
  GET  /jobs/{job_id}             → job status + summary (when done)
  GET  /jobs/{job_id}/logs        → live log stream (SSE, text/event-stream)
  GET  /jobs/{job_id}/logs/raw    → full plain-text log snapshot (download)
"""
from __future__ import annotations

import sys

# ── Windows: asyncio event loop fix for Playwright ───────────────────────────
# Playwright launches Chromium as a subprocess. On Windows, asyncio's
# SelectorEventLoop does NOT support subprocess transports.
# ProactorEventLoop is required and must be set before uvicorn creates its loop.
if sys.platform == "win32":
    import asyncio as _asyncio
    _asyncio.set_event_loop_policy(_asyncio.WindowsProactorEventLoopPolicy())
# ─────────────────────────────────────────────────────────────────────────────

import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from app.auth.dependencies import require_admin
from app.config import settings
import os
from app.crawlers.orchestrator import run_all_sources


# ── ECS task ID helper (for CloudWatch log streaming) ─────────────────────────

async def _get_ecs_task_id() -> Optional[str]:
    """
    Read ECS container metadata to get the short task ID.
    Returns None when not running on ECS (local dev / Railway).
    Used to populate kickflip_jobs.ecs_task_id so the log-streaming Lambda
    can locate the correct CloudWatch log stream for a running job.
    """
    meta_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
    if not meta_uri:
        return None
    try:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{meta_uri}/task", timeout=5.0)
            task_arn = resp.json().get("TaskARN", "")
            return task_arn.split("/")[-1] if task_arn else None
    except Exception:
        return None
from app.jobs.manager import JobState, JobStatus, job_manager
from app.models.run import RunSummary
from app.query.service import search as _search_events
from app.sources.loader import load_sources
from app.storage import database
from app.utils.logger import BoundLogger, current_job_id

# ── API routers (Priority 1-3 endpoints from BACKEND_API_CONTRACT.md) ─────────
from app.api.admin          import router as _admin_router
from app.api.events         import router as _provider_events_router
from app.api.profile        import router as _profile_router
from app.api.saved          import router as _saved_router
# ── API routers (new feature endpoints) ───────────────────────────────────────
from app.api.event_views    import router as _event_views_router
from app.api.chat_history   import router as _chat_history_router
from app.api.media          import router as _media_router
from app.api.dashboard      import router as _dashboard_router
from app.api.admin_extended import router as _admin_extended_router

log = BoundLogger("kickflip.api")


# ── Request / response models ─────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str


class ChatMessage(BaseModel):
    role: str    # "user" | "assistant"
    content: str


class ChatFilters(BaseModel):
    category: Optional[str] = None
    date: Optional[str] = None   # YYYY-MM-DD


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    filters: Optional[ChatFilters] = None


# ── Module-level state ────────────────────────────────────────────────────────

# Strong references prevent background tasks from being garbage-collected
# mid-run (recommended pattern per Python asyncio docs).
_background_tasks: set[asyncio.Task] = set()

# job_id of the most recently queued/running job — used for 409 gating.
_active_job_id: Optional[str] = None


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create DB pool on startup; close on shutdown."""
    log.info("Starting up — creating DB pool")
    try:
        app.state.db_pool = await database.create_pool()
        log.info("DB pool ready")
        orphaned = await database.orphan_stale_jobs(app.state.db_pool)
        if orphaned:
            log.warning(f"Marked {orphaned} orphaned job(s) as failed on startup")
    except Exception as exc:
        log.error(f"DB pool creation failed: {exc}")
        app.state.db_pool = None

    yield

    log.info("Shutting down — closing DB pool")
    await database.close_pool()


app = FastAPI(
    title="Kickflip Event Parser",
    description=(
        "Single-purpose backend service: crawls event websites, "
        "normalizes events, and stores them in Supabase. "
        "No chat, no user queries — data ingestion only."
    ),
    version="2.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Allow UI apps to call the API from the browser.
# Set CORS_ORIGINS=http://localhost:3000,https://myapp.com in .env to restrict.
_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API routers ────────────────────────────────────────────────────────────────
app.include_router(_admin_router)
app.include_router(_provider_events_router)
app.include_router(_profile_router)
app.include_router(_saved_router)
app.include_router(_event_views_router)
app.include_router(_chat_history_router)
app.include_router(_media_router)
app.include_router(_dashboard_router)
app.include_router(_admin_extended_router)


# ── Helpers ───────────────────────────────────────────────────────────────────

import base64 as _base64  # noqa: E402 — kept near usage for clarity


def _extract_user_id_from_token(request: Request) -> Optional[str]:
    """
    Best-effort: decode the Bearer JWT payload without signature verification.
    Used only for analytics (event-view recording) — never for auth.
    Returns the 'sub' claim (Supabase user UUID) or None.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:]
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        # Restore base64url padding
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        payload = json.loads(_base64.urlsafe_b64decode(payload_b64))
        return payload.get("sub")
    except Exception:
        return None


async def _record_event_views(
    db_pool,
    event_ids: list[str],
    viewer_id: Optional[str],
    source: str,
) -> None:
    """
    Fire-and-forget: insert rows into event_views for analytics.
    Swallows all errors so it never affects the main response.
    Logged-in users: deduped per event per hour via ON CONFLICT DO NOTHING.
    Anonymous users: always inserted (viewer_id = NULL).
    """
    if not event_ids or db_pool is None:
        return
    try:
        for event_id in event_ids:
            await db_pool.execute(
                """
                INSERT INTO public.event_views (event_id, viewer_id, source)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
                """,
                event_id,
                viewer_id,   # None for anonymous
                source,
            )
    except Exception:
        pass


def _serialize_val(v):
    """Coerce asyncpg/datetime values to JSON-safe types."""
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v


def _build_summary_dict(summary: RunSummary, sample: list[dict]) -> dict:
    return {
        "status":      summary.status,
        "started_at":  summary.started_at.isoformat() if summary.started_at else None,
        "finished_at": summary.finished_at.isoformat() if summary.finished_at else None,
        "duration_ms": summary.duration_ms,
        "totals": {
            "sources":              summary.total_sources,
            "urls_discovered":      summary.total_urls_discovered,
            "pages_fetched":        summary.total_pages_fetched,
            "events_parsed":        summary.total_events_parsed,
            "events_stored":        summary.total_events_stored,
            "events_filtered_past": summary.total_events_filtered_past,
            "events_deduped":       summary.total_events_deduped,
            "errors":               summary.total_errors,
        },
        "per_source": [
            {
                "source":               sr.source_name,
                "status":               sr.status,
                "urls_discovered":      sr.urls_discovered,
                "pages_fetched":        sr.pages_fetched,
                "events_stored":        sr.events_stored,
                "events_filtered_past": sr.events_filtered_past,
                "errors":               sr.errors[:5],
                "duration_ms":          sr.duration_ms,
            }
            for sr in summary.source_results
        ],
        "sample_events": [
            {k: _serialize_val(v) for k, v in row.items()}
            for row in sample
        ],
    }


def _job_to_dict(job: JobState, *, include_summary: bool = False) -> dict:
    duration_ms = None
    if job.started_at and job.finished_at:
        duration_ms = int((job.finished_at - job.started_at).total_seconds() * 1000)

    d: dict = {
        "job_id":         job.job_id,
        "status":         job.status.value,
        "created_at":     job.created_at.isoformat(),
        "started_at":     job.started_at.isoformat() if job.started_at else None,
        "finished_at":    job.finished_at.isoformat() if job.finished_at else None,
        "duration_ms":    duration_ms,
        "run_id":         job.run_id,
        "db_run_id":      job.db_run_id or None,
        "log_line_count": len(job.log_lines),
        "logs_url":       f"/jobs/{job.job_id}/logs",
        "logs_raw_url":   f"/jobs/{job.job_id}/logs/raw",
    }
    if include_summary and job.summary:
        d["summary"] = job.summary
    return d


def _db_row_to_job_dict(
    row: dict,
    *,
    include_summary: bool = False,
    live_job: Optional[JobState] = None,
) -> dict:
    """
    Build a job response dict from a ``kickflip_jobs`` DB row.

    If *live_job* is provided (job still in memory and active), its real-time
    ``log_line_count`` overrides the stored value so the list stays fresh while
    a crawl is running.
    """
    job_id = row["job_id"]
    log_count = (
        len(live_job.log_lines)
        if live_job and live_job.status in (JobStatus.queued, JobStatus.running)
        else row.get("log_line_count", 0)
    )
    d: dict = {
        "job_id":         job_id,
        "status":         row["status"],
        "created_at":     row["created_at"].isoformat() if row.get("created_at") else None,
        "started_at":     row["started_at"].isoformat() if row.get("started_at") else None,
        "finished_at":    row["finished_at"].isoformat() if row.get("finished_at") else None,
        "duration_ms":    row.get("duration_ms"),
        "run_id":         row.get("run_id"),
        "db_run_id":      row.get("db_run_id") or None,
        "log_line_count": log_count,
        "logs_url":       f"/jobs/{job_id}/logs",
        "logs_raw_url":   f"/jobs/{job_id}/logs/raw",
    }
    if include_summary and row.get("summary"):
        d["summary"] = row["summary"]
    return d


# ── Background crawl task ─────────────────────────────────────────────────────

async def _run_job_task(job: JobState, db_pool, force: bool) -> None:
    """
    Full crawl pipeline running as an independent asyncio.Task.

    Setting ``current_job_id`` here causes all log records emitted by this
    task AND every child task spawned by run_all_sources to be captured into
    job.log_lines (via JobLogHandler).  asyncio copies ContextVar state when
    create_task() is called, so children inherit the value automatically.
    """
    # Route all log records from this task tree to this job's buffer
    current_job_id.set(job.job_id)

    job.status     = JobStatus.running
    job.started_at = datetime.now(timezone.utc)

    run_id     = str(uuid.uuid4())
    job.run_id = run_id
    bound_log  = log.bind(run_id=run_id)
    bound_log.info("Run started", stage="source_start")

    started_at = job.started_at
    summary    = RunSummary(run_id=run_id, started_at=started_at)
    db_run_id  = 0

    try:
        # ── Persist running status ────────────────────────────────────────────
        try:
            await database.mark_job_running(job.job_id, job.started_at, db_pool)
        except Exception as exc:
            bound_log.warning(f"mark_job_running failed: {exc}")

        # ── Register ECS task ID for CloudWatch log streaming ─────────────────
        try:
            ecs_task_id = await _get_ecs_task_id()
            if ecs_task_id:
                await db_pool.execute(
                    "UPDATE kickflip_jobs SET ecs_task_id = $1 WHERE job_id = $2",
                    ecs_task_id,
                    job.job_id,
                )
                bound_log.info(f"Registered ECS task ID: {ecs_task_id}")
        except Exception as exc:
            bound_log.warning(f"Could not register ECS task ID: {exc}")

        # ── Batch lock ────────────────────────────────────────────────────────
        lock_acquired = False
        if force:
            bound_log.warning("force=true: skipping batch lock check")
            lock_acquired = True
        else:
            try:
                lock_acquired = await database.try_acquire_lock(run_id, db_pool)
            except Exception as exc:
                bound_log.warning(f"Could not check batch lock: {exc} — proceeding anyway")
                lock_acquired = True

        if not lock_acquired:
            bound_log.error("Batch lock already held by another process — aborting run")
            job.status  = JobStatus.failed
            job.summary = {"error": "Another run is already in progress (DB lock)."}
            return

        # ── Load sources ──────────────────────────────────────────────────────
        try:
            sources = load_sources(settings.sources_file)
        except FileNotFoundError as exc:
            await database.release_lock(run_id, "failed", db_pool)
            raise RuntimeError(str(exc)) from exc

        if not sources:
            await database.release_lock(run_id, "failed", db_pool)
            raise RuntimeError("No enabled sources found in sources.yaml.")

        # ── Persist run start ─────────────────────────────────────────────────
        try:
            db_run_id     = await database.create_batch_run(run_id, db_pool)
            job.db_run_id = db_run_id
        except Exception as exc:
            bound_log.warning(f"Could not create batch_run row: {exc}")

        t0 = time.monotonic()

        # ── Pipeline ──────────────────────────────────────────────────────────
        try:
            summary = await run_all_sources(
                sources=sources,
                run_id=run_id,
                summary=summary,
                db_pool=db_pool,
            )
            summary.status = "completed"
            job.status     = JobStatus.completed
        except Exception as exc:
            bound_log.error(f"Run pipeline failed: {exc}")
            summary.status = "failed"
            job.status     = JobStatus.failed

        # ── Finalize ──────────────────────────────────────────────────────────
        duration_ms         = int((time.monotonic() - t0) * 1000)
        summary.finished_at = datetime.now(timezone.utc)
        summary.duration_ms = duration_ms

        try:
            await database.mark_inactive_events(db_pool, settings.mark_inactive_after_days)
        except Exception as exc:
            bound_log.warning(f"mark_inactive_events failed: {exc}")

        # ── Post-crawl embedding backfill ─────────────────────────────────────
        try:
            embedded = await database.embed_pending_events(db_pool)
            if embedded:
                bound_log.info(f"Post-crawl embedding: {embedded} event(s) embedded")
        except Exception as exc:
            bound_log.warning(f"embed_pending_events failed: {exc}")

        sample: list[dict] = []
        try:
            sample = await database.fetch_sample_events(
                db_pool, limit=settings.sample_events_in_response
            )
        except Exception as exc:
            bound_log.warning(f"fetch_sample_events failed: {exc}")

        if db_run_id:
            try:
                await database.finish_batch_run(db_run_id, run_id, summary, db_pool)
            except Exception as exc:
                bound_log.warning(f"finish_batch_run failed: {exc}")

        lock_final = "completed" if summary.status == "completed" else "failed"
        try:
            await database.release_lock(run_id, lock_final, db_pool)
        except Exception as exc:
            bound_log.warning(f"release_lock failed: {exc}")

        bound_log.info(
            "Run complete",
            stage="source_done",
            elapsed_ms=duration_ms,
            extra={
                "status":   summary.status,
                "stored":   summary.total_events_stored,
                "filtered": summary.total_events_filtered_past,
                "errors":   summary.total_errors,
            },
        )

        job.summary = _build_summary_dict(summary, sample)

    except Exception as exc:
        bound_log.error(f"Job task failed unexpectedly: {exc}")
        job.status = JobStatus.failed
        if not job.summary:
            job.summary = {"error": str(exc)}

    finally:
        job.finished_at    = datetime.now(timezone.utc)
        job.logs_expire_at = job.finished_at + timedelta(hours=settings.log_retention_hours)

        fin_duration_ms = (
            int((job.finished_at - job.started_at).total_seconds() * 1000)
            if job.started_at else 0
        )
        try:
            await database.finish_job(
                job_id=job.job_id,
                status=job.status.value,
                finished_at=job.finished_at,
                duration_ms=fin_duration_ms,
                log_line_count=len(job.log_lines),
                logs_expire_at=job.logs_expire_at,
                summary=job.summary,
                run_id=job.run_id,
                db_run_id=job.db_run_id or 0,
                pool=db_pool,
                log_lines=job.log_lines,
            )
        except Exception as exc:
            bound_log.warning(f"finish_job DB write failed: {exc}")

        job_manager.mark_done(job)   # sends None sentinel to all SSE subscribers


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
async def health():
    """Liveness + readiness probe."""
    db_ok = getattr(app.state, "db_pool", None) is not None

    active = None
    if _active_job_id:
        j = job_manager.get(_active_job_id)
        if j and j.status in (JobStatus.queued, JobStatus.running):
            active = _active_job_id

    return {
        "status":               "ok" if db_ok else "degraded",
        "db_connected":         db_ok,
        "timezone":             settings.timezone,
        "llm_fallback_enabled": settings.enable_llm_fallback,
        "llm_provider":         settings.llm_provider if settings.enable_llm_fallback else None,
        "active_job":           active,
    }


# ── POST /run ─────────────────────────────────────────────────────────────────

async def _require_cron_or_admin(request: Request) -> None:
    """
    Accepts either:
      1. A plain CRON_SECRET bearer token  (Railway cron + manual curl)
      2. A valid Supabase admin JWT         (dashboard UI)
    """
    auth_header: str = request.headers.get("Authorization", "")
    token = auth_header.removeprefix("Bearer ").strip()
    cron_secret = os.environ.get("CRON_SECRET", "")
    if cron_secret and token == cron_secret:
        return
    await require_admin(request)


@app.post("/run", status_code=202, tags=["crawl"])
async def start_crawl(request: Request, force: bool = False, _=Depends(_require_cron_or_admin)):
    """
    Enqueue a background crawl over all enabled sources in sources.yaml.

    Returns **202 Accepted** immediately with a ``job_id``.  The crawl runs
    as a background asyncio task — the HTTP connection is not held open.

    Query params:
      ``force=true``  — override an existing running lock (use only when a
                        previous run is stuck and you are certain it has stopped).

    Track progress:
      - Poll ``GET /jobs/{job_id}`` for status and final summary.
      - Stream live logs from ``GET /jobs/{job_id}/logs`` (SSE).
    """
    global _active_job_id

    # ── Concurrent-run gate ───────────────────────────────────────────────────
    if not force and _active_job_id:
        active = job_manager.get(_active_job_id)
        if active and active.status in (JobStatus.queued, JobStatus.running):
            return JSONResponse(
                status_code=409,
                content={
                    "detail":        "A crawl is already in progress. "
                                     "Poll the active job or use ?force=true.",
                    "active_job_id": _active_job_id,
                    "status":        active.status.value,
                    "detail_url":    f"/jobs/{_active_job_id}",
                    "logs_url":      f"/jobs/{_active_job_id}/logs",
                },
            )

    db_pool = getattr(app.state, "db_pool", None)
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database pool not available.")

    job            = job_manager.create()
    _active_job_id = job.job_id

    try:
        await database.insert_job(job.job_id, job.created_at, db_pool)
    except Exception as exc:
        log.warning(f"insert_job failed (crawl will still run): {exc}")

    task = asyncio.create_task(_run_job_task(job, db_pool, force))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return JSONResponse(
        status_code=202,
        content={
            "job_id":       job.job_id,
            "status":       job.status.value,
            "detail_url":   f"/jobs/{job.job_id}",
            "logs_url":     f"/jobs/{job.job_id}/logs",
            "logs_raw_url": f"/jobs/{job.job_id}/logs/raw",
        },
    )


# ── GET /jobs ─────────────────────────────────────────────────────────────────

@app.get("/jobs", tags=["jobs"])
async def list_jobs(_: dict = Depends(_require_cron_or_admin)):
    """
    List all jobs newest-first from the persistent database (up to 200).

    For jobs that are still actively running in memory the ``log_line_count``
    is updated in real-time.  Fetch ``GET /jobs/{job_id}`` for the full
    per-source summary of a completed run.
    """
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool is None:
        # Graceful degradation: fall back to in-memory if DB is unavailable
        return [_job_to_dict(j) for j in job_manager.all()]

    rows = await database.list_jobs_db(db_pool)
    return [
        _db_row_to_job_dict(row, live_job=job_manager.get(row["job_id"]))
        for row in rows
    ]


# ── GET /jobs/{job_id} ────────────────────────────────────────────────────────

@app.get("/jobs/{job_id}", tags=["jobs"])
async def get_job(job_id: str, _: dict = Depends(_require_cron_or_admin)):
    """
    Return status, metadata, and (when completed) the full run summary
    including per-source results, event totals, and sample events.
    """
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool is None:
        job = job_manager.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
        return _job_to_dict(job, include_summary=True)

    row = await database.get_job_db(job_id, db_pool)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return _db_row_to_job_dict(
        row,
        include_summary=True,
        live_job=job_manager.get(job_id),
    )


# ── GET /jobs/{job_id}/logs  (SSE) ───────────────────────────────────────────

@app.get("/jobs/{job_id}/logs", tags=["jobs"])
async def stream_job_logs(job_id: str, request: Request, _: dict = Depends(_require_cron_or_admin)):
    """
    Stream job log output as **Server-Sent Events** (``text/event-stream``).

    Each SSE ``data`` field is a single JSON log line (same format as the
    file log).  A terminal event ``{"__done__": true, "status": "..."}``
    signals the end of the stream.

    Behaviour:
    - **Queued job**   → waits for the run to start, then streams live.
    - **Running job**  → replays buffered lines, then streams live with
                         15-second keepalive comments to prevent proxy timeouts.
    - **Finished job** → replays the full log immediately, then closes.

    Connect with::

        curl -N http://localhost:8000/jobs/{job_id}/logs
    """
    job = job_manager.get(job_id)
    if not job:
        # Job not in memory — check DB to determine why
        db_pool = getattr(app.state, "db_pool", None)
        if db_pool:
            row = await database.get_job_db(job_id, db_pool)
            if row is None:
                raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
            expire = row.get("logs_expire_at")
            if expire and datetime.now(timezone.utc) > expire:
                return JSONResponse(
                    status_code=410,
                    content={
                        "detail":          "Log stream has expired.",
                        "job_id":          job_id,
                        "status":          row["status"],
                        "logs_expired_at": expire.isoformat(),
                        "hint": (
                            f"Logs are retained for {settings.log_retention_hours} "
                            "hour(s) after job completion."
                        ),
                    },
                )
            # Job no longer in memory (container exited after crawl finished).
            # Replay the persisted log_content from DB as SSE if available.
            stored_log: str = row.get("log_content") or ""
            if not stored_log:
                return JSONResponse(
                    status_code=503,
                    content={
                        "detail": (
                            "Log stream unavailable — server restarted during job "
                            "execution and no log content was persisted."
                        ),
                        "job_id": job_id,
                        "status": row["status"],
                    },
                )

            async def replay_from_db():
                for line in stored_log.split("\n"):
                    if line.strip():
                        yield f"data: {line}\n\n"
                yield f"data: {json.dumps({'__done__': True, 'status': row['status']})}\n\n"

            return StreamingResponse(
                replay_from_db(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control":     "no-cache",
                    "X-Accel-Buffering": "no",
                    "Connection":        "keep-alive",
                },
            )
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    async def generate():
        still_active = job.status in (JobStatus.queued, JobStatus.running)

        # Subscribe BEFORE snapshotting existing lines.  Because asyncio is
        # cooperative (single-threaded), no append_log() can interleave between
        # subscribe() and the snapshot — so we get complete, gapless coverage:
        # existing lines come from the snapshot, new lines come from the queue.
        q            = job_manager.subscribe(job) if still_active else None
        replay_up_to = len(job.log_lines)

        try:
            # 1. Replay buffered history
            for line in job.log_lines[:replay_up_to]:
                yield f"data: {line}\n\n"

            # 2. Stream live (only for queued/running jobs)
            if q is not None:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        item = await asyncio.wait_for(q.get(), timeout=15.0)
                        if item is None:           # None sentinel = job finished
                            break
                        yield f"data: {item}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"   # SSE comment keeps connection alive

            # 3. Terminal event — client knows the stream is complete
            yield f"data: {json.dumps({'__done__': True, 'status': job.status.value})}\n\n"

        finally:
            if q is not None:
                job_manager.unsubscribe(job, q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",       # disable Nginx / proxy buffering
            "Connection":        "keep-alive",
        },
    )


# ── GET /jobs/{job_id}/logs/raw ───────────────────────────────────────────────

@app.get("/jobs/{job_id}/logs/raw", tags=["jobs"])
async def get_job_logs_raw(job_id: str, _: dict = Depends(_require_cron_or_admin)):
    """
    Return the full job log as **plain text** (one JSON line per log entry).

    This is a snapshot at the moment of the request — the file is not tailed.
    For live output use ``GET /jobs/{job_id}/logs`` (SSE).

    Useful for ``curl``, CI artefact storage, and offline analysis.
    """
    job = job_manager.get(job_id)
    if not job:
        # Job not in memory — check DB to determine why
        db_pool = getattr(app.state, "db_pool", None)
        if db_pool:
            row = await database.get_job_db(job_id, db_pool)
            if row is None:
                raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
            expire = row.get("logs_expire_at")
            if expire and datetime.now(timezone.utc) > expire:
                return JSONResponse(
                    status_code=410,
                    content={
                        "detail":          "Log snapshot has expired.",
                        "job_id":          job_id,
                        "status":          row["status"],
                        "logs_expired_at": expire.isoformat(),
                        "hint": (
                            f"Logs are retained for {settings.log_retention_hours} "
                            "hour(s) after job completion."
                        ),
                    },
                )
            # Job no longer in memory — serve persisted log_content from DB.
            stored_log: str = row.get("log_content") or ""
            if not stored_log:
                return JSONResponse(
                    status_code=503,
                    content={
                        "detail": (
                            "Log snapshot unavailable — server restarted during job "
                            "execution and no log content was persisted."
                        ),
                        "job_id": job_id,
                        "status": row["status"],
                    },
                )
            return PlainTextResponse(
                stored_log,
                headers={
                    "Content-Disposition": f'attachment; filename="kickflip-job-{job_id}.log"',
                },
            )
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    return PlainTextResponse(
        "\n".join(job.log_lines),
        headers={
            "Content-Disposition": f'attachment; filename="kickflip-job-{job_id}.log"',
        },
    )


# ── GET /events ───────────────────────────────────────────────────────────────

_ALLOWED_CATEGORIES = frozenset({
    "music", "food", "art", "outdoor", "party",
    "wellness", "fashion", "sports", "comedy", "other",
})
_RECOGNISED_EVENT_CATS = _ALLOWED_CATEGORIES - {"other"}


def _parse_categories(raw) -> list[str]:
    """Normalise the raw categories JSONB value to a list of lowercase strings."""
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = [raw]
    if not isinstance(raw, list):
        raw = [raw]
    return [str(c).lower().strip() for c in raw if c and str(c).strip()]


def _primary_category(cats: list[str]) -> str:
    """Return the first recognised category or 'other'."""
    for c in cats:
        if c in _RECOGNISED_EVENT_CATS:
            return c
    return "other"


def _vibe_tags(cats: list[str], is_free: bool) -> list[str]:
    tags = [f"#{c}" for c in cats if c]
    if is_free and "#free" not in tags:
        tags.append("#free")
    return tags


def _split_dt(dt) -> tuple[Optional[str], Optional[str]]:
    """Split a datetime into (YYYY-MM-DD, HH:MM) strings, both nullable."""
    if dt is None:
        return None, None
    if isinstance(dt, str):
        try:
            dt = datetime.fromisoformat(dt)
        except Exception:
            return None, None
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")


def _price_label(price: Optional[str], is_free: bool, ticket_url: Optional[str]) -> Optional[str]:
    if price:
        return price
    if is_free:
        return "Free"
    if ticket_url:
        return "Tickets Required"
    return None


def _fmt_public_event(row: dict) -> dict:
    cats      = _parse_categories(row.get("categories"))
    is_free   = bool(row.get("is_free") or False)
    start_d, start_t = _split_dt(row.get("start_time"))
    end_d,   end_t   = _split_dt(row.get("end_time"))

    desc = row.get("event_summary") or row.get("description") or ""
    if len(desc) > 200:
        desc = desc[:197].rstrip() + "…"

    return {
        "id":           str(row.get("id", "")),
        "title":        row.get("title") or "",
        "description":  desc,
        "category":     _primary_category(cats),
        "vibe_tags":    _vibe_tags(cats, is_free),
        "location":     row.get("venue") or row.get("city") or "",
        "address":      row.get("address"),
        "city":         row.get("city"),
        "start_date":   start_d,
        "start_time":   start_t,
        "end_date":     end_d,
        "end_time":     end_t,
        "price":        _price_label(row.get("price"), is_free, row.get("ticket_url")),
        "link":         row.get("ticket_url") or row.get("source_url") or "",
        "image_url":    row.get("image_url"),
        "organizer":    row.get("venue"),   # closest available proxy
        "crawl_source": row.get("source_name"),
    }


@app.get("/events", tags=["events"])
async def list_events(
    category:  Optional[str] = None,
    date_from: Optional[str] = None,
    date_to:   Optional[str] = None,
    limit:     int           = 100,
):
    """
    Public browse endpoint — returns upcoming active events.

    Query params (all optional):
    - **category**  — one of: music, food, art, outdoor, party, wellness,
                      fashion, sports, comedy, other
    - **date_from** — YYYY-MM-DD (default: today)
    - **date_to**   — YYYY-MM-DD (inclusive upper bound on start_date)
    - **limit**     — max results, 1–200 (default 100)

    Response is a flat JSON array, cached for 5 minutes by CDN/browser.
    Events with no start_date are included and sorted last.
    """
    # ── Validate category ─────────────────────────────────────────────────────
    if category and category not in _ALLOWED_CATEGORIES:
        return JSONResponse(
            status_code=422,
            content={
                "detail": (
                    f"Invalid category '{category}'. "
                    f"Must be one of: {', '.join(sorted(_ALLOWED_CATEGORIES))}"
                )
            },
        )

    # ── Clamp limit ───────────────────────────────────────────────────────────
    limit = max(1, min(limit, 200))

    # ── Parse date params → UTC datetimes ─────────────────────────────────────
    def _to_dt_start(s: str) -> Optional[datetime]:
        try:
            d = date.fromisoformat(s)
            return datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=timezone.utc)
        except Exception:
            return None

    def _to_dt_end(s: str) -> Optional[datetime]:
        try:
            d = date.fromisoformat(s)
            return datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc)
        except Exception:
            return None

    dt_from = _to_dt_start(date_from) if date_from else None
    dt_to   = _to_dt_end(date_to)     if date_to   else None

    # ── Fetch ─────────────────────────────────────────────────────────────────
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable.")

    # Fetch generously so Python category filter still yields enough results
    fetch_limit = max(limit * 4, 500)
    rows = await database.list_events_public(db_pool, dt_from, dt_to, fetch_limit)

    # ── Serialise + category filter ───────────────────────────────────────────
    events = [_fmt_public_event(r) for r in rows]
    if category:
        events = [e for e in events if e["category"] == category]

    return JSONResponse(
        content=events[:limit],
        headers={"Cache-Control": "public, max-age=300"},
    )


# ── POST /search ──────────────────────────────────────────────────────────────

@app.post("/search", tags=["search"])
async def search_events(req: SearchRequest, request: Request):
    """
    Natural-language event search backed by pgvector semantic retrieval.

    Query examples::

        {"query": "free jazz concerts this weekend"}
        {"query": "family-friendly events on Saturday"}
        {"query": "outdoor activities next week"}

    Pipeline: rule-based date/free parsing → OpenAI embedding → cosine
    similarity search against kickflip_events → LLM-formatted prose answer.

    When ``ENABLE_EMBEDDINGS=false`` (default), falls back to chronological
    ORDER BY start_time within the detected date window.
    When no ``LLM_API_KEY`` is set, returns a plain-text event list instead
    of an LLM-formatted answer.

    Response fields:
    - ``response``          — natural-language answer (LLM or plain-text)
    - ``events``            — matched events (up to ``SEARCH_RESULT_LIMIT``)
    - ``constraints``       — parsed date window, is_free flag, intent text
    - ``retrieval_method``  — ``semantic`` | ``semantic_nofree`` | ``chronological``
    - ``timing_ms``         — per-stage latency breakdown
    - ``total_candidates``  — events matched before slicing to result limit
    """
    db_pool = getattr(app.state, "db_pool", None)
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database pool not available.")

    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query must not be empty.")

    result = await _search_events(req.query.strip(), db_pool)

    # Fire-and-forget: record event views for analytics
    event_ids = [str(e["id"]) for e in result.events if e.get("id")]
    if event_ids:
        viewer_id = _extract_user_id_from_token(request)
        task = asyncio.create_task(
            _record_event_views(db_pool, event_ids, viewer_id, "search")
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

    return {
        "query":            result.query,
        "response":         result.response_text,
        "events":           result.events,
        "constraints":      result.constraints,
        "retrieval_method": result.retrieval_method,
        "timing_ms":        result.timing_ms,
        "total_candidates": result.total_candidates,
    }


# ── POST /chat ────────────────────────────────────────────────────────────────

@app.post("/chat", tags=["chat"])
async def chat_endpoint(req: ChatRequest, request: Request) -> StreamingResponse:
    """
    Conversational events assistant — streams SSE tokens.

    Accepts a message history and optional filters (category, date).
    Returns a ``text/event-stream`` with three typed event kinds:

    - ``{"type": "token", "text": "..."}``   — LLM text chunk (stream in real time)
    - ``{"type": "events", "events": [...]}`` — parsed EVENTS_JSON array for UI cards
    - ``{"type": "done"}``                    — stream complete

    Example request::

        {"messages": [{"role": "user", "content": "free jazz this weekend?"}]}

    No authentication required (public endpoint).
    """
    import re as _re

    db_pool = getattr(app.state, "db_pool", None)
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable.")

    api_key = settings.chat_api_key or settings.llm_api_key
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="No API key configured for chat. Set CHAT_API_KEY or LLM_API_KEY.",
        )

    # ── Resolve optional filters ──────────────────────────────────────────────
    category: Optional[str] = None
    date_from: Optional[datetime] = None
    if req.filters:
        category = req.filters.category
        if req.filters.date:
            try:
                d = date.fromisoformat(req.filters.date)
                date_from = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=timezone.utc)
            except Exception:
                pass

    # ── Fetch event catalog ───────────────────────────────────────────────────
    from app.lib.chat_prompt import build_system_prompt
    from app.utils.llm_client import LLMClient

    events = await database.fetch_upcoming_events_for_chat(
        db_pool, category=category, date_from=date_from
    )
    system_prompt = build_system_prompt(events)

    llm = LLMClient(
        provider=settings.chat_provider,
        model=settings.chat_model,
        api_key=api_key,
    )
    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    # Extract user_id before entering the generator (best-effort, for analytics)
    chat_viewer_id = _extract_user_id_from_token(request)

    async def generate():
        buffer: list[str] = []
        try:
            async for token in llm.stream(
                system=system_prompt,
                messages=messages,
                max_tokens=settings.chat_max_tokens,
            ):
                buffer.append(token)
                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"

                if await request.is_disconnected():
                    return

        except Exception as exc:
            log.warning(f"Chat stream error: {exc}")
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

        # Parse EVENTS_JSON from the accumulated response
        full_text = "".join(buffer)
        m = _re.search(r"EVENTS_JSON:\s*(\[.*?\])", full_text, _re.DOTALL)
        if m:
            try:
                parsed_events = json.loads(m.group(1))
                yield f"data: {json.dumps({'type': 'events', 'events': parsed_events})}\n\n"

                # Fire-and-forget: record event views for analytics
                chat_event_ids = [
                    str(e["id"]) for e in parsed_events
                    if isinstance(e, dict) and e.get("id")
                ]
                if chat_event_ids:
                    _task = asyncio.create_task(
                        _record_event_views(db_pool, chat_event_ids, chat_viewer_id, "chat")
                    )
                    _background_tasks.add(_task)
                    _task.add_done_callback(_background_tasks.discard)
            except Exception:
                pass

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )
