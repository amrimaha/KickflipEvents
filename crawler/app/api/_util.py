"""Shared helpers for the /api/* routers."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any


def _safe(v: Any) -> Any:
    """Convert asyncpg / Python types to plain JSON-safe values."""
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def row_to_dict(record) -> dict:
    """Convert an asyncpg Record to a plain JSON-serialisable dict."""
    return {k: _safe(v) for k, v in record.items()}


def err(msg: str, code: str | None = None) -> dict:
    """Return a dict matching the contract error shape {error, code?}."""
    d: dict = {"error": msg}
    if code:
        d["code"] = code
    return d


MAX_BODY_BYTES = 5 * 1024 * 1024  # 5 MB


def check_payload_size(request) -> dict | None:
    """Return a 413 error dict if Content-Length header exceeds 5 MB, else None."""
    cl = request.headers.get("content-length")
    if cl and int(cl) > MAX_BODY_BYTES:
        return err("Payload too large (max 5 MB)", "PAYLOAD_TOO_LARGE")
    return None
