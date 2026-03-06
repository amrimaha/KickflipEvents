"""
In-memory job registry for background crawl runs.

Each POST /run creates a JobState entry here.  Log lines emitted during the
crawl are buffered in job.log_lines (for replay) and pushed to per-subscriber
asyncio.Queue objects (for live SSE streaming).

The registry is bounded to MAX_JOBS entries — oldest are evicted when full.
Jobs survive only for the lifetime of the process; the canonical persistent
record lives in kickflip_batch_runs (Postgres).
"""
from __future__ import annotations

import asyncio
import collections
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class JobStatus(str, Enum):
    queued    = "queued"
    running   = "running"
    completed = "completed"
    failed    = "failed"


@dataclass
class JobState:
    job_id:      str
    status:      JobStatus = JobStatus.queued
    created_at:  datetime  = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at:  Optional[datetime] = None
    finished_at: Optional[datetime] = None
    run_id:      Optional[str] = None
    db_run_id:   int = 0

    # Set on job finish: datetime after which in-memory logs are expired.
    # GET /jobs/{id}/logs returns 410 Gone once this time has passed.
    logs_expire_at: Optional[datetime] = None

    # Serialisable summary dict; populated when the job finishes
    summary: Optional[dict] = None

    # Append-only log buffer — replayed for late-joining SSE subscribers
    log_lines: list = field(default_factory=list)

    # Active SSE subscribers: each Queue receives every new line + the done
    # sentinel (None).  Use maxsize to drop a slow consumer rather than
    # blocking the crawler.
    _subscribers: list = field(default_factory=list, repr=False)


class JobManager:
    """Asyncio-safe (single-threaded event loop) in-memory job store."""

    MAX_JOBS = 50

    def __init__(self) -> None:
        self._jobs: collections.OrderedDict[str, JobState] = collections.OrderedDict()

    # ── CRUD ──────────────────────────────────────────────────────────────────

    def create(self) -> JobState:
        job_id = str(uuid.uuid4())
        job = JobState(job_id=job_id)
        self._jobs[job_id] = job
        if len(self._jobs) > self.MAX_JOBS:
            self._jobs.popitem(last=False)   # evict oldest
        return job

    def get(self, job_id: str) -> Optional[JobState]:
        return self._jobs.get(job_id)

    def all(self) -> list:
        """Return all jobs, newest first."""
        return list(reversed(list(self._jobs.values())))

    # ── Log capture ───────────────────────────────────────────────────────────

    def append_log(self, job: JobState, line: str) -> None:
        """Append a formatted log line and push to every live subscriber."""
        job.log_lines.append(line)
        dead = []
        for q in job._subscribers:
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                dead.append(q)   # slow consumer — evict
        for q in dead:
            self.unsubscribe(job, q)

    def subscribe(self, job: JobState) -> asyncio.Queue:
        """Register a new SSE subscriber; returns a Queue to drain."""
        q: asyncio.Queue = asyncio.Queue(maxsize=1024)
        job._subscribers.append(q)
        return q

    def unsubscribe(self, job: JobState, q: asyncio.Queue) -> None:
        try:
            job._subscribers.remove(q)
        except ValueError:
            pass

    def mark_done(self, job: JobState) -> None:
        """Send the None sentinel to every subscriber so SSE streams close."""
        for q in list(job._subscribers):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass


# Process-level singleton
job_manager = JobManager()
