"""
Lambda: GET /jobs/{job_id}/logs

Two-mode log endpoint:

  RUNNING job  → fetches live log lines from CloudWatch Logs using the ECS
                 task ID stored in kickflip_jobs.ecs_task_id.
                 Returns a JSON snapshot the client can poll every 2-3 s.

  COMPLETED / FAILED job → reads the JSONL file uploaded to S3 at job end.
                           Falls back to log_content DB column if S3 key absent.

Log line format
---------------
Each line in the response `lines` array is a dict:
  - Structured lines (from BoundLogger):
      {"timestamp": "...", "level": "INFO", "logger": "...", "message": "...",
       "source_name": "acm", "stage": "fetch", "url": "https://...", "elapsed_ms": 120}
  - Plain-text lines (from root logger or unstructured output):
      {"message": "2024-01-01 03:00:05 INFO kickflip.entrypoint: ...", "raw": true}

Query parameters:
  since_ms (int, default 0) — Unix ms timestamp. Only return CW events after this.

Response JSON:
  {
    "job_id":  "<uuid>",
    "status":  "running" | "completed" | "failed",
    "lines":   [{"timestamp":...,"level":...,"message":...}, ...],
    "next_ms": 1712345678901,
    "done":    false | true,
    "source":  "cloudwatch" | "s3" | "db"
  }

Environment variables required:
  DATABASE_URL      — Supabase transaction pooler connection string
  CRON_SECRET       — Bearer token for auth
  LOG_S3_BUCKET     — S3 bucket where entrypoint uploads JSONL logs
  CW_LOG_GROUP      — CloudWatch log group (e.g. /kickflip/crawler)
  CW_STREAM_PREFIX  — awslogs-stream-prefix in ECS task def
  CW_CONTAINER_NAME — Container name in ECS task def
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from urllib.parse import urlparse

import boto3
import pg8000.dbapi

DATABASE_URL      = os.environ["DATABASE_URL"]
CRON_SECRET       = os.environ.get("CRON_SECRET", "")
LOG_S3_BUCKET     = os.environ.get("LOG_S3_BUCKET", "")
CW_LOG_GROUP      = os.environ.get("CW_LOG_GROUP", "/kickflip/crawler")
CW_STREAM_PREFIX  = os.environ.get("CW_STREAM_PREFIX", "crawler")
CW_CONTAINER_NAME = os.environ.get("CW_CONTAINER_NAME", "kickflip-crawler")
AWS_REGION        = os.environ.get("AWS_REGION", "us-east-1")

# Reuse clients across warm Lambda invocations
_cw_client = None
_s3_client = None


def _get_cw_client():
    global _cw_client
    if _cw_client is None:
        _cw_client = boto3.client("logs", region_name=AWS_REGION)
    return _cw_client


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3", region_name=AWS_REGION)
    return _s3_client


# ── Auth ──────────────────────────────────────────────────────────────────────

def _check_auth(event: dict) -> bool:
    if not CRON_SECRET:
        return True
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    token = headers.get("authorization", "").removeprefix("Bearer ").strip()
    return token == CRON_SECRET


# ── DB ────────────────────────────────────────────────────────────────────────

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


def _get_job_row(job_id: str) -> dict | None:
    conn = _get_db_conn()
    cur  = conn.cursor()
    cur.execute(
        """
        SELECT job_id, status, ecs_task_id, log_content, log_s3_key, logs_expire_at
        FROM kickflip_jobs
        WHERE job_id = %s
        """,
        (job_id,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


# ── Log line parsing ──────────────────────────────────────────────────────────

def _parse_line(line: str) -> dict:
    """
    Try to parse line as JSON (structured BoundLogger output).
    Fall back to a plain-text wrapper so the UI always gets dicts.
    """
    stripped = line.strip()
    if not stripped:
        return None
    try:
        obj = json.loads(stripped)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass
    return {"message": stripped, "raw": True}


# ── S3 log reading ────────────────────────────────────────────────────────────

def _fetch_s3_logs(s3_key: str) -> list[dict]:
    """Download JSONL from S3 and return parsed log objects."""
    s3 = _get_s3_client()
    try:
        resp    = s3.get_object(Bucket=LOG_S3_BUCKET, Key=s3_key)
        content = resp["Body"].read().decode("utf-8")
        lines   = []
        for raw_line in content.splitlines():
            obj = _parse_line(raw_line)
            if obj:
                lines.append(obj)
        return lines
    except s3.exceptions.NoSuchKey:
        return []
    except Exception:
        return []


# ── CloudWatch log reading ────────────────────────────────────────────────────

def _cw_stream_name(ecs_task_id: str) -> str:
    task_id = ecs_task_id
    if ecs_task_id.startswith("arn:"):
        task_id = ecs_task_id.split("/")[-1]
    return f"{CW_STREAM_PREFIX}/{CW_CONTAINER_NAME}/{task_id}"


def _fetch_cw_logs(stream_name: str, since_ms: int) -> tuple[list[dict], int]:
    """
    Fetch CloudWatch log events since since_ms and return (parsed_lines, next_ms).
    Each line is parsed as JSON for structured output.
    """
    cw = _get_cw_client()
    lines:   list[dict] = []
    last_ms: int        = since_ms

    kwargs = {
        "logGroupName":  CW_LOG_GROUP,
        "logStreamName": stream_name,
        "startFromHead": True,
        "limit":         500,
    }
    if since_ms > 0:
        kwargs["startTime"] = since_ms + 1

    try:
        events = cw.get_log_events(**kwargs).get("events", [])
        for ev in events:
            raw_msg = ev.get("message", "").rstrip("\n")
            obj = _parse_line(raw_msg)
            if obj:
                # Attach CloudWatch timestamp if the structured log has none
                if "timestamp" not in obj:
                    obj["cw_timestamp_ms"] = ev.get("timestamp", 0)
                lines.append(obj)
            ts = ev.get("timestamp", 0)
            if ts > last_ms:
                last_ms = ts
    except Exception:
        pass

    return lines, last_ms


# ── Handler ───────────────────────────────────────────────────────────────────

def handler(event: dict, _context) -> dict:
    if not _check_auth(event):
        return {"statusCode": 401, "body": json.dumps({"detail": "Unauthorized"})}

    path_params = event.get("pathParameters") or {}
    job_id = path_params.get("job_id") or path_params.get("jobId", "")
    if not job_id:
        return {"statusCode": 400, "body": json.dumps({"detail": "Missing job_id"})}

    query_params = event.get("queryStringParameters") or {}
    try:
        since_ms = int(query_params.get("since_ms", 0))
    except (ValueError, TypeError):
        since_ms = 0

    try:
        row = _get_job_row(job_id)
    except Exception as exc:
        return {"statusCode": 503, "body": json.dumps({"detail": f"Database error: {exc}"})}

    if row is None:
        return {"statusCode": 404, "body": json.dumps({"detail": f"Job '{job_id}' not found."})}

    status      = row["status"]
    ecs_task_id = row.get("ecs_task_id")
    log_s3_key  = row.get("log_s3_key")
    log_content = row.get("log_content")
    logs_expire = row.get("logs_expire_at")
    is_done     = status in ("completed", "failed")

    # ── Expired logs ──────────────────────────────────────────────────────────
    if is_done and logs_expire:
        now = datetime.utcnow().replace(tzinfo=logs_expire.tzinfo)
        if now > logs_expire:
            return {
                "statusCode": 410,
                "body": json.dumps({
                    "detail":          "Logs have expired.",
                    "job_id":          job_id,
                    "status":          status,
                    "logs_expired_at": logs_expire.isoformat(),
                }),
            }

    # ── COMPLETED / FAILED ────────────────────────────────────────────────────
    if is_done:
        # Primary: S3 JSONL (full structured logs)
        if LOG_S3_BUCKET and log_s3_key:
            lines = _fetch_s3_logs(log_s3_key)
            if lines:
                return {
                    "statusCode": 200,
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps({
                        "job_id":  job_id,
                        "status":  status,
                        "lines":   lines,
                        "next_ms": since_ms,
                        "done":    True,
                        "source":  "s3",
                    }),
                }

        # Fallback: DB log_content (plain text)
        if log_content:
            lines = [
                obj for raw in log_content.splitlines()
                if (obj := _parse_line(raw))
            ]
            return {
                "statusCode": 200,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({
                    "job_id":  job_id,
                    "status":  status,
                    "lines":   lines,
                    "next_ms": since_ms,
                    "done":    True,
                    "source":  "db",
                }),
            }

        return {
            "statusCode": 503,
            "body": json.dumps({
                "detail": "Log content not available.",
                "job_id": job_id,
                "status": status,
            }),
        }

    # ── RUNNING / QUEUED: serve from CloudWatch ───────────────────────────────
    if not ecs_task_id:
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "job_id":  job_id,
                "status":  status,
                "lines":   [],
                "next_ms": since_ms,
                "done":    False,
                "source":  "cloudwatch",
                "hint":    "ECS task starting up — no logs yet. Poll again in a few seconds.",
            }),
        }

    stream_name        = _cw_stream_name(ecs_task_id)
    lines, next_ms_out = _fetch_cw_logs(stream_name, since_ms)

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "job_id":  job_id,
            "status":  status,
            "lines":   lines,
            "next_ms": next_ms_out,
            "done":    False,
            "source":  "cloudwatch",
        }),
    }
