"""
Structured JSON logger.

Every log line is a single JSON object with these common fields:
  timestamp, level, message, logger,
  run_id, source_name, stage, url, event_id, elapsed_ms  (when bound)

Stages (for reference):
  source_start | discover_urls | fetch | render | parse |
  normalize | validate | filter_future | upsert_db | source_done

Per-job log capture
-------------------
Set ``current_job_id`` in any asyncio Task before starting a crawl.  All log
records emitted from that task — and from any child tasks it spawns — will be
routed to the corresponding JobState via ``JobLogHandler``.  Child tasks
inherit the ContextVar value automatically (asyncio copies context on
create_task).

Usage::

    from app.utils.logger import current_job_id
    current_job_id.set(job.job_id)   # inside the background task
    # … all subsequent log calls in this task + children go to that job
"""
from __future__ import annotations

import json
import logging
import sys
import traceback
from contextvars import ContextVar
from typing import Any, Optional


# ── Context var ───────────────────────────────────────────────────────────────

# Set this to the active job_id at the start of a background crawl task.
# Inherited by all asyncio child tasks spawned from there.
current_job_id: ContextVar[Optional[str]] = ContextVar("current_job_id", default=None)


# ── JSON formatter ────────────────────────────────────────────────────────────

class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level":     record.levelname,
            "logger":    record.name,
            "message":   record.getMessage(),
        }
        # Propagate bound context fields
        for key in (
            "run_id", "source_name", "stage", "url",
            "event_id", "elapsed_ms", "extra",
        ):
            val = getattr(record, key, None)
            if val is not None:
                entry[key] = val

        if record.exc_info:
            entry["exception"] = traceback.format_exception(*record.exc_info)

        return json.dumps(entry, default=str)


# Module-level formatter instance reused by JobLogHandler (avoids re-instantiation per record)
_json_fmt = _JSONFormatter()


# ── Per-job capture handler ───────────────────────────────────────────────────

class JobLogHandler(logging.Handler):
    """
    Routes every formatted log line to the active job's in-memory buffer.

    Looks up the job via the ``current_job_id`` ContextVar.  Lazy-imports
    ``job_manager`` to avoid circular-import issues at module load time
    (logger is imported very early; jobs.manager is defined later).
    """

    def emit(self, record: logging.LogRecord) -> None:
        job_id = current_job_id.get()
        if not job_id:
            return
        try:
            # Intentional lazy import — avoids circular deps at module load time
            from app.jobs.manager import job_manager  # noqa: PLC0415
            job = job_manager.get(job_id)
            if job is None:
                return
            line = _json_fmt.format(record)
            job_manager.append_log(job, line)
        except Exception:
            pass   # never let log capture crash the crawler


# ── Logger factory ────────────────────────────────────────────────────────────

def _build_handler() -> logging.StreamHandler:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(_JSONFormatter())
    return h


def get_logger(name: str = "kickflip") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.addHandler(_build_handler())      # stdout JSON (existing)
        logger.addHandler(JobLogHandler())        # per-job in-memory capture (new)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
    return logger


# ── BoundLogger ───────────────────────────────────────────────────────────────

class BoundLogger:
    """
    Thin wrapper that carries context (run_id, source_name, etc.) and
    attaches it to every log record automatically.

    Usage::

        log = BoundLogger("kickflip", run_id="abc", source_name="acm")
        log.info("fetch", stage="fetch", url="https://…", elapsed_ms=120)
        child = log.bind(event_id="xyz")
    """

    def __init__(self, name: str = "kickflip", **ctx: Any) -> None:
        self._logger = get_logger(name)
        self._ctx = ctx

    def bind(self, **kwargs: Any) -> "BoundLogger":
        child = BoundLogger(self._logger.name)
        child._logger = self._logger
        child._ctx = {**self._ctx, **kwargs}
        return child

    def _emit(self, level: int, msg: str, **kwargs: Any) -> None:
        extra = {**self._ctx, **kwargs}
        record = self._logger.makeRecord(
            self._logger.name,
            level,
            fn="",
            lno=0,
            msg=msg,
            args=(),
            exc_info=kwargs.pop("exc_info", None),
        )
        for k, v in extra.items():
            setattr(record, k, v)
        self._logger.handle(record)

    def debug(self, msg: str, **kw: Any) -> None:
        self._emit(logging.DEBUG, msg, **kw)

    def info(self, msg: str, **kw: Any) -> None:
        self._emit(logging.INFO, msg, **kw)

    def warning(self, msg: str, **kw: Any) -> None:
        self._emit(logging.WARNING, msg, **kw)

    def error(self, msg: str, **kw: Any) -> None:
        self._emit(logging.ERROR, msg, **kw)

    def exception(self, msg: str, **kw: Any) -> None:
        import sys as _sys
        kw.setdefault("exc_info", _sys.exc_info())
        self._emit(logging.ERROR, msg, **kw)


# Root logger for the service
log = BoundLogger("kickflip")
