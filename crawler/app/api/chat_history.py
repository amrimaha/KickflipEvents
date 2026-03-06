"""
/api/me/chat-history/* — Persist and retrieve chat session history.

GET    /api/me/chat-history              — paginated session list
GET    /api/me/chat-history/{session_id} — full session with messages
POST   /api/me/chat-history              — upsert a session (idempotent)
DELETE /api/me/chat-history/{session_id} — delete a session
"""
from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth.dependencies import require_auth
from app.api._util import err, row_to_dict

router = APIRouter(prefix="/api/me/chat-history", tags=["api:chat-history"])


# ── Request model ─────────────────────────────────────────────────────────────

class SessionBody(BaseModel):
    session_key: str
    preview:     str
    messages:    list[dict[str, Any]]   # [{role, text, events?: [...]}]


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/me/chat-history
# ─────────────────────────────────────────────────────────────────────────────

@router.get("")
async def list_sessions(
    request:   Request,
    page:      int = Query(1,  ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: dict = Depends(require_auth),
):
    """Return paginated list of chat sessions, newest first."""
    db_pool = request.app.state.db_pool
    offset  = (page - 1) * page_size

    try:
        rows = await db_pool.fetch(
            """
            SELECT id, session_key, preview, created_at, updated_at,
                   jsonb_array_length(messages) AS message_count
            FROM public.chat_sessions
            WHERE user_id = $1::uuid
            ORDER BY updated_at DESC
            LIMIT $2 OFFSET $3
            """,
            auth["user_id"],
            page_size,
            offset,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch sessions: {exc}"))

    sessions = [
        {
            "id":            str(row["id"]),
            "session_key":   row["session_key"],
            "preview":       row["preview"],
            "message_count": row["message_count"] or 0,
            "created_at":    row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at":    row["updated_at"].isoformat() if row["updated_at"] else None,
        }
        for row in rows
    ]

    return {"sessions": sessions, "page": page, "page_size": page_size}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/me/chat-history/{session_id}
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{session_id}")
async def get_session(
    session_id: str,
    request:    Request,
    auth: dict = Depends(require_auth),
):
    """Return a single session including full messages array."""
    db_pool = request.app.state.db_pool
    try:
        row = await db_pool.fetchrow(
            """
            SELECT id, session_key, preview, messages, created_at, updated_at
            FROM public.chat_sessions
            WHERE id = $1::uuid AND user_id = $2::uuid
            """,
            session_id,
            auth["user_id"],
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch session: {exc}"))

    if row is None:
        return JSONResponse(status_code=404, content=err("Session not found"))

    messages = row["messages"]
    if isinstance(messages, str):
        try:
            messages = json.loads(messages)
        except Exception:
            messages = []

    return {
        "id":          str(row["id"]),
        "session_key": row["session_key"],
        "preview":     row["preview"],
        "messages":    messages,
        "created_at":  row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at":  row["updated_at"].isoformat() if row["updated_at"] else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/me/chat-history
# ─────────────────────────────────────────────────────────────────────────────

@router.post("")
async def upsert_session(
    body:    SessionBody,
    request: Request,
    auth: dict = Depends(require_auth),
):
    """
    Create or update a chat session.  Idempotent via (user_id, session_key).
    preview is truncated to 120 characters.
    """
    preview = (body.preview or "")[:120]

    db_pool = request.app.state.db_pool
    try:
        row = await db_pool.fetchrow(
            """
            INSERT INTO public.chat_sessions
                (user_id, session_key, preview, messages)
            VALUES
                ($1::uuid, $2, $3, $4)
            ON CONFLICT (user_id, session_key)
            DO UPDATE SET
                preview    = EXCLUDED.preview,
                messages   = EXCLUDED.messages,
                updated_at = NOW()
            RETURNING id
            """,
            auth["user_id"],
            body.session_key,
            preview,
            json.dumps(body.messages),
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to upsert session: {exc}"))

    return {"ok": True, "id": str(row["id"])}


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/me/chat-history/{session_id}
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    request:    Request,
    auth: dict = Depends(require_auth),
):
    """Delete a session. Only the owner can delete their own sessions."""
    db_pool = request.app.state.db_pool
    try:
        result = await db_pool.execute(
            "DELETE FROM public.chat_sessions WHERE id = $1::uuid AND user_id = $2::uuid",
            session_id,
            auth["user_id"],
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to delete session: {exc}"))

    # asyncpg returns "DELETE N" — check if a row was actually deleted
    deleted_count = int(result.split()[-1]) if result else 0
    if deleted_count == 0:
        return JSONResponse(status_code=404, content=err("Session not found"))

    return {"ok": True}
