"""
/api/event-views/* — Track and retrieve event view history.

POST /api/event-views        — record a view (optional auth; anonymous allowed)
GET  /api/event-views/me     — list distinct events viewed by the current user
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth.dependencies import require_auth
from app.api._util import err, row_to_dict
from fastapi import Depends

router = APIRouter(prefix="/api/event-views", tags=["api:event-views"])

_VALID_SOURCES = {"search", "chat", "direct", "profile"}


# ── Optional-auth helper ──────────────────────────────────────────────────────

async def _optional_auth(request: Request) -> Optional[dict]:
    """
    If an Authorization: Bearer header is present, verify it and return the
    auth dict.  If there is no header at all, return None (anonymous).
    If the token is present but invalid, return None (treat as anonymous).
    """
    if not request.headers.get("Authorization"):
        return None
    try:
        return await require_auth(request)
    except Exception:
        return None


# ── Request model ─────────────────────────────────────────────────────────────

class ViewBody(BaseModel):
    event_id: str
    source:   str


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/event-views
# ─────────────────────────────────────────────────────────────────────────────

@router.post("")
async def record_view(
    body:    ViewBody,
    request: Request,
):
    """
    Record an event view. Auth is optional:
    - Authenticated: viewer_id = user's UUID; deduped within the same hour.
    - Anonymous:     viewer_id = NULL; always inserted.
    """
    if body.source not in _VALID_SOURCES:
        return JSONResponse(
            status_code=400,
            content=err(
                f"Invalid source. Must be one of: {', '.join(sorted(_VALID_SOURCES))}",
                "INVALID_SOURCE",
            ),
        )

    auth = await _optional_auth(request)
    viewer_id: Optional[str] = auth["user_id"] if auth else None

    db_pool = request.app.state.db_pool
    try:
        if viewer_id:
            # Logged-in: ignore duplicate views from same viewer within same hour
            await db_pool.execute(
                """
                INSERT INTO public.event_views (event_id, viewer_id, source)
                VALUES ($1, $2::uuid, $3)
                ON CONFLICT DO NOTHING
                """,
                body.event_id,
                viewer_id,
                body.source,
            )
        else:
            # Anonymous: always insert
            await db_pool.execute(
                """
                INSERT INTO public.event_views (event_id, viewer_id, source)
                VALUES ($1, NULL, $2)
                """,
                body.event_id,
                body.source,
            )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to record view: {exc}"))

    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/event-views/me
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/me")
async def get_my_views(request: Request, auth: dict = Depends(require_auth)):
    """
    Return the 50 most recently viewed distinct events for the current user.
    Uses DISTINCT ON to collapse multiple views of the same event, keeping
    only the most recent view per event.
    """
    db_pool = request.app.state.db_pool
    try:
        # DISTINCT ON keeps the latest viewed_at per event_id,
        # then the outer ORDER BY sorts the result set by that viewed_at.
        rows = await db_pool.fetch(
            """
            SELECT event_id, source, viewed_at
            FROM (
                SELECT DISTINCT ON (event_id)
                    event_id, source, viewed_at
                FROM public.event_views
                WHERE viewer_id = $1::uuid
                ORDER BY event_id, viewed_at DESC
            ) AS distinct_views
            ORDER BY viewed_at DESC
            LIMIT 50
            """,
            auth["user_id"],
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch views: {exc}"))

    return {
        "views": [
            {
                "event_id":  row["event_id"],
                "source":    row["source"],
                "viewed_at": row["viewed_at"].isoformat() if row["viewed_at"] else None,
            }
            for row in rows
        ]
    }
