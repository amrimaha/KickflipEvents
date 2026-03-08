import boto3
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import pg8000.dbapi

ECS_CLUSTER     = os.environ["ECS_CLUSTER"]
TASK_DEFINITION = os.environ["TASK_DEFINITION"]
SUBNET_ID       = os.environ["SUBNET_ID"]
SECURITY_GROUP  = os.environ["SECURITY_GROUP"]
CONTAINER_NAME  = os.environ.get("CONTAINER_NAME", "kickflip-crawler")
REGION          = os.environ.get("AWS_REGION", "us-east-1")
CRON_SECRET     = os.environ.get("CRON_SECRET", "")
DATABASE_URL    = os.environ.get("DATABASE_URL", "")


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


def _create_job_row(job_id: str, created_at: datetime) -> None:
    """
    Insert job row with status='queued' before ECS starts.
    ON CONFLICT DO NOTHING — safe if entrypoint also tries to insert.
    """
    conn = _get_db_conn()
    cur  = conn.cursor()
    cur.execute(
        """
        INSERT INTO kickflip_jobs (job_id, status, created_at, updated_at)
        VALUES (%s, 'queued', %s, NOW())
        ON CONFLICT (job_id) DO NOTHING
        """,
        (job_id, created_at),
    )
    conn.commit()
    cur.close()
    conn.close()


def handler(event, _context):
    # ── Auth ──────────────────────────────────────────────────────────────────
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    token   = headers.get("authorization", "").removeprefix("Bearer ").strip()
    if CRON_SECRET and token != CRON_SECRET:
        return {"statusCode": 401, "body": json.dumps({"detail": "Unauthorized"})}

    # ── Pre-generate job_id and create DB row ─────────────────────────────────
    # Create the row NOW so the UI can poll GET /jobs/{job_id} immediately,
    # without waiting 30-60s for the ECS container to start and insert it.
    job_id     = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc)

    if DATABASE_URL:
        try:
            _create_job_row(job_id, created_at)
        except Exception as exc:
            # Non-fatal — entrypoint will insert on startup
            print(f"Warning: could not pre-create job row: {exc}")

    # ── Start ECS task ────────────────────────────────────────────────────────
    ecs  = boto3.client("ecs", region_name=REGION)
    resp = ecs.run_task(
        cluster=ECS_CLUSTER,
        taskDefinition=TASK_DEFINITION,
        launchType="FARGATE",
        networkConfiguration={
            "awsvpcConfiguration": {
                "subnets":        [SUBNET_ID],
                "securityGroups": [SECURITY_GROUP],
                "assignPublicIp": "ENABLED",
            }
        },
        overrides={
            "containerOverrides": [{
                "name": CONTAINER_NAME,
                "environment": [
                    {"name": "JOB_ID", "value": job_id}
                ],
            }]
        },
    )

    failures = resp.get("failures", [])
    if failures:
        return {
            "statusCode": 500,
            "body": json.dumps({"detail": failures[0].get("reason")}),
        }

    task_arn = resp["tasks"][0]["taskArn"]
    task_id  = task_arn.split("/")[-1]

    return {
        "statusCode": 202,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "job_id":   job_id,
            "task_arn": task_arn,
            "task_id":  task_id,
            "status":   "queued",
            "detail":   "ECS task started",
        }),
    }
