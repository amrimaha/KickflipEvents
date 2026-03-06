"""
/api/me/saved-events — Saved events for the authenticated user.

GET  /api/me/saved-events  — list saved events
POST /api/me/saved-events  — save or unsave an event (idempotent)
"""
from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth.dependencies import require_auth
from app.api._util import err

router = APIRouter(prefix="/api/me/saved-events", tags=["api:saved"])


# ── Request model ─────────────────────────────────────────────────────────────

class SaveRequest(BaseModel):
    event_id:      str
    is_saving:     bool = True
    event_payload: Optional[dict[str, Any]] = None   # full KickflipEvent object


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/me/saved-events
# ─────────────────────────────────────────────────────────────────────────────

@router.get("")
async def list_saved_events(request: Request, auth: dict = Depends(require_auth)):
    """Return all events saved by the authenticated user, newest first."""
    db_pool = request.app.state.db_pool
    try:
        rows = await db_pool.fetch(
            """
            SELECT event_id, event_payload, saved_at
              FROM public.kickflip_saved_events
             WHERE user_id = $1
             ORDER BY saved_at DESC
            """,
            auth["user_id"],
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch saved events: {exc}"))

    events = []
    for row in rows:
        payload = row["event_payload"] or {}
        # event_payload is JSONB — asyncpg returns it as a dict already
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:
                payload = {}
        events.append({
            "id":      row["event_id"],
            **payload,
            "savedAt": row["saved_at"].isoformat() if row["saved_at"] else None,
        })

    return {"events": events}


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/me/saved-events
# ─────────────────────────────────────────────────────────────────────────────

@router.post("")
async def save_or_unsave_event(
    body:    SaveRequest,
    request: Request,
    auth:    dict = Depends(require_auth),
):
    """
    Save (is_saving=true) or unsave (is_saving=false) an event.
    Upsert on (user_id, event_id) — safe to call multiple times.
    """
    db_pool = request.app.state.db_pool
    user_id = auth["user_id"]

    try:
        if not body.is_saving:
            # Unsave: delete the row
            await db_pool.execute(
                """
                DELETE FROM public.kickflip_saved_events
                 WHERE user_id = $1 AND event_id = $2
                """,
                user_id,
                body.event_id,
            )
        else:
            # Save: upsert — idempotent
            payload = body.event_payload or {}
            await db_pool.execute(
                """
                INSERT INTO public.kickflip_saved_events
                    (user_id, event_id, event_payload, saved_at)
                VALUES
                    ($1, $2, $3, NOW())
                ON CONFLICT (user_id, event_id)
                DO UPDATE SET
                    event_payload = EXCLUDED.event_payload,
                    saved_at      = NOW()
                """,
                user_id,
                body.event_id,
                json.dumps(payload),
            )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to save/unsave event: {exc}"))

    return {"ok": True}
