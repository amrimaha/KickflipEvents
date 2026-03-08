"""
Lambda: GET /jobs/{job_id}

Returns job status + summary from kickflip_jobs table.
Mirrors the response shape of the existing FastAPI GET /jobs/{job_id} endpoint
so callers need no changes.

Environment variables required:
  DATABASE_URL   — Supabase transaction pooler connection string (port 6543)
  CRON_SECRET    — Bearer token used to authenticate the request

API Gateway event shape expected:
  pathParameters.job_id   — the UUID job identifier
  headers.Authorization   — "Bearer <CRON_SECRET>"
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from urllib.parse import urlparse

import pg8000.dbapi

DATABASE_URL = os.environ["DATABASE_URL"]
CRON_SECRET  = os.environ.get("CRON_SECRET", "")


# ── Auth ──────────────────────────────────────────────────────────────────────

def _check_auth(event: dict) -> bool:
    if not CRON_SECRET:
        return True
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    auth = headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    return token == CRON_SECRET


# ── DB helpers ────────────────────────────────────────────────────────────────

def _get_db_conn():
    url = urlparse(DATABASE_URL)
    return pg8000.dbapi.connect(
        host=url.hostname,
        database=(url.path or "/postgres").lstrip("/"),
        user=url.username,
        password=url.password,
        port=url.port or 5432,
        ssl_context=True,
    )


def _fetchone_dict(cursor) -> dict | None:
    """Fetch one row as a dict using cursor.description for column names."""
    row = cursor.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cursor.description]
    return dict(zip(cols, row))


def _serialize(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


# ── Handler ───────────────────────────────────────────────────────────────────

def handler(event: dict, _context) -> dict:
    if not _check_auth(event):
        return {"statusCode": 401, "body": json.dumps({"detail": "Unauthorized"})}

    path_params = event.get("pathParameters") or {}
    job_id = path_params.get("job_id") or path_params.get("jobId", "")
    if not job_id:
        return {"statusCode": 400, "body": json.dumps({"detail": "Missing job_id"})}

    try:
        conn = _get_db_conn()
        cur  = conn.cursor()
        cur.execute(
            """
            SELECT
                job_id, status,
                created_at, started_at, finished_at,
                duration_ms, run_id, db_run_id,
                log_line_count, logs_expire_at,
                ecs_task_id,
                summary
            FROM kickflip_jobs
            WHERE job_id = %s
            """,
            (job_id,),
        )
        row = _fetchone_dict(cur)
        cur.close()
        conn.close()
    except Exception as exc:
        return {
            "statusCode": 503,
            "body": json.dumps({"detail": f"Database error: {exc}"}),
        }

    if row is None:
        return {
            "statusCode": 404,
            "body": json.dumps({"detail": f"Job '{job_id}' not found."}),
        }

    summary = row.get("summary")
    if isinstance(summary, str):
        try:
            summary = json.loads(summary)
        except Exception:
            pass

    body = {
        "job_id":         row["job_id"],
        "status":         row["status"],
        "created_at":     row["created_at"].isoformat() if row.get("created_at") else None,
        "started_at":     row["started_at"].isoformat() if row.get("started_at") else None,
        "finished_at":    row["finished_at"].isoformat() if row.get("finished_at") else None,
        "duration_ms":    row.get("duration_ms"),
        "run_id":         row.get("run_id"),
        "db_run_id":      row.get("db_run_id") or None,
        "log_line_count": row.get("log_line_count", 0),
        "ecs_task_id":    row.get("ecs_task_id"),
        "logs_url":       f"/jobs/{job_id}/logs",
        "logs_raw_url":   f"/jobs/{job_id}/logs/raw",
        "summary":        summary,
    }

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=_serialize),
    }
