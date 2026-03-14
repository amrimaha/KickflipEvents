"""
Run-once entrypoint for ECS Fargate ephemeral tasks.

Used as the default CMD in the Dockerfile:
    CMD ["python", "-m", "app.entrypoint"]

Lifecycle:
  1. Install stdout tee (captures all log output for S3 upload)
  2. Connect to DB, orphan any stale jobs (crash recovery)
  3. Read ECS container metadata → extract short task ID
  4. Create job row in kickflip_jobs (status=queued)
  5. Store ecs_task_id so the log-streaming Lambda can find the CloudWatch stream
  6. Run the full crawl pipeline (same logic as _run_job_task in main.py)
  7. Upload full structured JSONL log to S3 → store log_s3_key in DB
  8. Exit 0 on success, 1 on failure

Log capture strategy
--------------------
All loggers (root logger via basicConfig AND BoundLoggers via _build_handler)
write to sys.stdout.  We install a _StdoutTee at the very start of run_once(),
BEFORE lazy app imports, so:
  - Root logger handler is redirected to write through the tee
  - BoundLogger StreamHandlers are created with sys.stdout = tee
  - Every line — including structured JSON fields like source_name, stage,
    url, elapsed_ms — is captured in tee.lines
At job completion tee.lines is uploaded to S3 as a JSONL file.
The get_job_logs Lambda reads from S3 (completed) or CloudWatch (running).

Environment variables used:
  DATABASE_URL            — Supabase transaction pooler
  LOG_S3_BUCKET           — S3 bucket for JSONL log upload (e.g. kickflip-crawler-logs)
  ECS_CONTAINER_METADATA_URI_V4  — injected automatically by ECS Fargate
  JOB_ID                  — pre-generated job_id from trigger Lambda (optional)
  All app.config.Settings vars   — same as the FastAPI server
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional


# ── Logging setup (before any app imports) ────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)

log = logging.getLogger("kickflip.entrypoint")


# ── Stdout tee ────────────────────────────────────────────────────────────────

class _StdoutTee:
    """
    Writes every character to the real stdout AND buffers complete lines.

    Install with:
        sys.stdout = _StdoutTee(sys.stdout)

    After the run:
        lines = tee.lines   # list of captured log line strings
        sys.stdout = tee._real
    """

    def __init__(self, real: Any) -> None:
        self._real = real
        self._buf  = ""
        self.lines: list[str] = []

    def write(self, text: str) -> int:
        self._real.write(text)
        self._buf += text
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line:
                self.lines.append(line)
        return len(text)

    def flush(self) -> None:
        self._real.flush()

    def fileno(self) -> int:
        return self._real.fileno()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


# ── ECS metadata ──────────────────────────────────────────────────────────────

async def _get_ecs_task_id() -> Optional[str]:
    """
    Read the ECS container metadata endpoint to get the task ARN.
    Returns the short task ID (last segment of ARN) or None if not on ECS.
    """
    meta_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
    if not meta_uri:
        log.info("ECS_CONTAINER_METADATA_URI_V4 not set — running outside ECS, skipping task ID registration")
        return None

    try:
        import httpx
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{meta_uri}/task", timeout=5.0)
            resp.raise_for_status()
            task_arn = resp.json().get("TaskARN", "")
            if not task_arn:
                return None
            task_id = task_arn.split("/")[-1]
            log.info(f"ECS task ID: {task_id}  (ARN: {task_arn})")
            return task_id
    except Exception as exc:
        log.warning(f"Could not read ECS task metadata: {exc} — continuing without task ID")
        return None


# ── Main pipeline ─────────────────────────────────────────────────────────────

async def run_once() -> int:
    """
    Full crawl pipeline. Returns exit code: 0 = success, 1 = failure.
    """

    # ── Install stdout tee BEFORE lazy app imports ────────────────────────────
    # Installed here so that BoundLogger StreamHandlers (created during import)
    # use sys.stdout = tee.  Also redirect the existing root handler to the tee.
    _real_stdout = sys.stdout
    _tee = _StdoutTee(_real_stdout)
    sys.stdout = _tee
    for _h in logging.getLogger().handlers:
        if isinstance(_h, logging.StreamHandler):
            _h.stream = _tee

    # ── Lazy app imports (after tee so BoundLoggers write through it) ─────────
    from app.config import settings
    from app.crawlers.orchestrator import run_all_sources
    from app.models.run import RunSummary
    from app.sources.loader import load_sources
    from app.storage import database
    from app.utils.logger import current_job_id

    # ── DB pool ───────────────────────────────────────────────────────────────
    log.info("Connecting to database...")
    try:
        db_pool = await database.create_pool()
        log.info("DB pool ready")
    except Exception as exc:
        log.error(f"Failed to create DB pool: {exc}")
        return 1

    # Orphan any jobs that were left in queued/running state (crash recovery)
    try:
        orphaned = await database.orphan_stale_jobs(db_pool)
        if orphaned:
            log.warning(f"Orphaned {orphaned} stale job(s) from previous run")
    except Exception as exc:
        log.warning(f"orphan_stale_jobs failed: {exc}")

    # ── Create job row ────────────────────────────────────────────────────────
    # Use pre-generated job_id from trigger Lambda if provided (so the UI
    # already has the job_id before the container starts).
    job_id     = os.environ.get("JOB_ID") or str(uuid.uuid4())
    created_at = datetime.now(timezone.utc)

    # Signal the job_id immediately so callers can track it
    print(json.dumps({"event": "job_created", "job_id": job_id}), flush=True)
    log.info(f"Job created: {job_id}")

    try:
        await database.insert_job(job_id, created_at, db_pool)
    except Exception as exc:
        log.warning(f"insert_job failed: {exc}")

    # Route log records to this job (for in-server-mode JobLogHandler compat)
    current_job_id.set(job_id)

    # ── Register ECS task ID for live log streaming ───────────────────────────
    ecs_task_id = await _get_ecs_task_id()
    if ecs_task_id:
        try:
            await db_pool.execute(
                "UPDATE kickflip_jobs SET ecs_task_id = $1 WHERE job_id = $2",
                ecs_task_id,
                job_id,
            )
            log.info(f"Registered ECS task ID in DB: {ecs_task_id}")
        except Exception as exc:
            log.warning(f"Could not store ecs_task_id: {exc}")

    # ── Mark running ──────────────────────────────────────────────────────────
    started_at = datetime.now(timezone.utc)
    try:
        await database.mark_job_running(job_id, started_at, db_pool)
    except Exception as exc:
        log.warning(f"mark_job_running failed: {exc}")

    run_id       = str(uuid.uuid4())
    summary      = RunSummary(run_id=run_id, started_at=started_at)
    db_run_id    = 0
    final_status = "failed"
    job_summary  = None

    t0 = time.monotonic()

    try:
        # ── Batch lock ────────────────────────────────────────────────────────
        try:
            lock_acquired = await database.try_acquire_lock(run_id, db_pool)
        except Exception as exc:
            log.warning(f"try_acquire_lock failed: {exc} — proceeding anyway")
            lock_acquired = True

        if not lock_acquired:
            log.error("Batch lock already held — aborting run")
            job_summary = {"error": "Another run is already in progress (DB lock)."}
            return 1

        # ── Load sources ──────────────────────────────────────────────────────
        try:
            sources = load_sources(settings.sources_file)
        except FileNotFoundError as exc:
            await database.release_lock(run_id, "failed", db_pool)
            log.error(f"sources.yaml not found: {exc}")
            return 1

        if not sources:
            await database.release_lock(run_id, "failed", db_pool)
            log.error("No enabled sources found in sources.yaml")
            return 1

        log.info(f"Loaded {len(sources)} source(s)")

        # ── Persist run start ─────────────────────────────────────────────────
        try:
            db_run_id = await database.create_batch_run(run_id, db_pool)
        except Exception as exc:
            log.warning(f"create_batch_run failed: {exc}")

        # ── Run the full crawl pipeline ───────────────────────────────────────
        log.info("Starting crawl pipeline...")
        try:
            summary = await run_all_sources(
                sources=sources,
                run_id=run_id,
                summary=summary,
                db_pool=db_pool,
            )
            summary.status = "completed"
            final_status = "completed"
            log.info(
                f"Crawl completed: {summary.total_events_stored} stored, "
                f"{summary.total_events_filtered_past} filtered, "
                f"{summary.total_errors} errors"
            )
        except Exception as exc:
            log.error(f"Crawl pipeline failed: {exc}")
            summary.status = "failed"
            final_status = "failed"

        # ── Finalize ──────────────────────────────────────────────────────────
        duration_ms         = int((time.monotonic() - t0) * 1000)
        summary.finished_at = datetime.now(timezone.utc)
        summary.duration_ms = duration_ms

        try:
            await database.mark_inactive_events(db_pool, settings.mark_inactive_after_days)
        except Exception as exc:
            log.warning(f"mark_inactive_events failed: {exc}")

        try:
            embedded = await database.embed_pending_events(db_pool)
            if embedded:
                log.info(f"Post-crawl embedding: {embedded} event(s) embedded")
        except Exception as exc:
            log.warning(f"embed_pending_events failed: {exc}")

        try:
            from app.parsers.tagger import tag_pending_events
            tagged = await tag_pending_events(db_pool)
            if tagged:
                log.info(f"Post-crawl tagging: {tagged} event(s) tagged with vibe_tags")
        except Exception as exc:
            log.warning(f"tag_pending_events failed: {exc}")

        if db_run_id:
            try:
                await database.finish_batch_run(db_run_id, run_id, summary, db_pool)
            except Exception as exc:
                log.warning(f"finish_batch_run failed: {exc}")

        lock_final = "completed" if final_status == "completed" else "failed"
        try:
            await database.release_lock(run_id, lock_final, db_pool)
        except Exception as exc:
            log.warning(f"release_lock failed: {exc}")

        job_summary = {
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
                "errors":               summary.total_errors,
            },
        }

    except Exception as exc:
        log.error(f"Entrypoint pipeline failed unexpectedly: {exc}")
        final_status = "failed"
        job_summary  = {"error": str(exc)}

    finally:
        # ── Restore stdout ────────────────────────────────────────────────────
        # Flush any remaining partial line in the tee buffer
        if _tee._buf:
            _tee.lines.append(_tee._buf)
        sys.stdout = _real_stdout
        for _h in logging.getLogger().handlers:
            if isinstance(_h, logging.StreamHandler):
                _h.stream = _real_stdout

        log_lines = _tee.lines

        # ── Upload JSONL log to S3 ────────────────────────────────────────────
        # Each line is either structured JSON (from BoundLogger) or plain text
        # (from root logger).  The get_job_logs Lambda parses them accordingly.
        log_s3_key  = None
        log_bucket  = os.environ.get("LOG_S3_BUCKET", "")
        if log_bucket and log_lines:
            try:
                import boto3
                s3 = boto3.client("s3")
                log_s3_key = f"logs/{job_id}.jsonl"
                s3.put_object(
                    Bucket=log_bucket,
                    Key=log_s3_key,
                    Body="\n".join(log_lines).encode("utf-8"),
                    ContentType="application/x-ndjson",
                )
                log.info(f"Logs uploaded to s3://{log_bucket}/{log_s3_key}")
            except Exception as exc:
                log.warning(f"S3 log upload failed (logs still in DB): {exc}")

        # Store S3 key in DB so get_job_logs Lambda knows where to find logs
        if log_s3_key:
            try:
                await db_pool.execute(
                    "UPDATE kickflip_jobs SET log_s3_key = $1 WHERE job_id = $2",
                    log_s3_key,
                    job_id,
                )
            except Exception as exc:
                log.warning(f"Could not store log_s3_key in DB: {exc}")

        finished_at    = datetime.now(timezone.utc)
        duration_ms    = int((finished_at - started_at).total_seconds() * 1000)
        logs_expire_at = finished_at + timedelta(hours=settings.log_retention_hours)

        try:
            await database.finish_job(
                job_id=job_id,
                status=final_status,
                finished_at=finished_at,
                duration_ms=duration_ms,
                log_line_count=len(log_lines),
                logs_expire_at=logs_expire_at,
                summary=job_summary,
                run_id=run_id,
                db_run_id=db_run_id,
                pool=db_pool,
                log_lines=log_lines,   # DB fallback if S3 not configured
            )
            log.info(f"Job {job_id} persisted to DB with status={final_status}")
        except Exception as exc:
            log.warning(f"finish_job DB write failed: {exc}")

        await database.close_pool()
        print(
            json.dumps({"event": "job_finished", "job_id": job_id, "status": final_status}),
            flush=True,
        )

    return 0 if final_status == "completed" else 1


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    exit_code = asyncio.run(run_once())
    sys.exit(exit_code)
