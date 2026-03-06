"""
/api/admin/* — Extended admin endpoints.

Registered alongside the existing admin.py router (same prefix /api/admin).

GET    /api/admin/events            — list all provider events (filterable)
DELETE /api/admin/events/{event_id} — delete any event + write admin_log
GET    /api/admin/logs              — paginated admin audit log
GET    /api/admin/event-views       — top events by view count
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.auth.dependencies import require_admin
from app.api._util import err, row_to_dict

router = APIRouter(prefix="/api/admin", tags=["api:admin-extended"])

_VALID_STATUSES = {"active", "draft", "completed"}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _write_admin_log(
    db_pool,
    admin_id:    str,
    action:      str,
    target_id:   Optional[str],
    target_type: Optional[str],
    metadata:    Optional[dict],
) -> None:
    """Insert an audit record into admin_logs (fire-and-forget, swallow errors)."""
    try:
        await db_pool.execute(
            """
            INSERT INTO public.admin_logs
                (admin_id, action, target_id, target_type, metadata)
            VALUES
                ($1::uuid, $2, $3, $4, $5)
            """,
            admin_id,
            action,
            target_id,
            target_type,
            json.dumps(metadata) if metadata else None,
        )
    except Exception:
        pass   # audit log failure must never break the main operation


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/events
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/events")
async def list_all_events(
    request:    Request,
    page:       int           = Query(1,    ge=1),
    page_size:  int           = Query(25,   ge=1, le=200),
    status:     Optional[str] = Query(None),
    creator_id: Optional[str] = Query(None),
    search:     Optional[str] = Query(None),
    admin_payload: dict = Depends(require_admin),
):
    if status and status not in _VALID_STATUSES:
        return JSONResponse(
            status_code=400,
            content=err(f"Invalid status. Must be one of: {', '.join(sorted(_VALID_STATUSES))}", "INVALID_STATUS"),
        )

    db_pool = request.app.state.db_pool
    offset  = (page - 1) * page_size

    # Build dynamic WHERE clauses — all validated server-side, no interpolation
    conditions = []
    params: list = []
    p = 1   # parameter counter

    if status:
        conditions.append(f"e.status = ${p}")
        params.append(status)
        p += 1

    if creator_id:
        conditions.append(f"e.creator_id = ${p}")
        params.append(creator_id)
        p += 1

    if search:
        conditions.append(f"e.title ILIKE ${p}")
        params.append(f"%{search}%")
        p += 1

    where_sql = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    count_params  = list(params)
    select_params = list(params) + [page_size, offset]

    try:
        count_row = await db_pool.fetchrow(
            f"""
            SELECT COUNT(*) AS n
            FROM public.kickflip_provider_events e
            {where_sql}
            """,
            *count_params,
        )
        total = int(count_row["n"]) if count_row else 0

        rows = await db_pool.fetch(
            f"""
            SELECT
                e.*,
                p.full_name AS creator_name
            FROM public.kickflip_provider_events e
            LEFT JOIN public.profiles p ON p.id::text = e.creator_id
            {where_sql}
            ORDER BY e.created_at DESC
            LIMIT ${p} OFFSET ${p + 1}
            """,
            *select_params,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch events: {exc}"))

    data = [row_to_dict(r) for r in rows]

    return {"data": data, "total": total, "page": page, "page_size": page_size}


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/admin/events/{event_id}
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/events/{event_id}")
async def admin_delete_event(
    event_id:      str,
    request:       Request,
    admin_payload: dict = Depends(require_admin),
):
    """Admin-only delete. Logs the action to admin_logs."""
    db_pool  = request.app.state.db_pool
    admin_id = admin_payload.get("sub")

    # 1. Fetch event title for audit log
    try:
        existing = await db_pool.fetchrow(
            "SELECT id, title FROM public.kickflip_provider_events WHERE id = $1::uuid",
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event: {exc}"))

    if existing is None:
        return JSONResponse(status_code=404, content=err("Event not found"))

    event_title = existing["title"]

    # 2. Delete the event
    try:
        await db_pool.execute(
            "DELETE FROM public.kickflip_provider_events WHERE id = $1::uuid",
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to delete event: {exc}"))

    # 3. Write audit log (non-blocking, never fails the response)
    await _write_admin_log(
        db_pool,
        admin_id    = admin_id,
        action      = "delete_event",
        target_id   = event_id,
        target_type = "event",
        metadata    = {"title": event_title},
    )

    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/logs
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/logs")
async def list_admin_logs(
    request:       Request,
    page:          int           = Query(1,   ge=1),
    page_size:     int           = Query(50,  ge=1, le=200),
    action:        Optional[str] = Query(None),
    admin_id:      Optional[str] = Query(None),
    admin_payload: dict = Depends(require_admin),
):
    db_pool = request.app.state.db_pool
    offset  = (page - 1) * page_size

    conditions: list[str] = []
    params:     list      = []
    p = 1

    if action:
        conditions.append(f"l.action = ${p}")
        params.append(action)
        p += 1

    if admin_id:
        conditions.append(f"l.admin_id = ${p}::uuid")
        params.append(admin_id)
        p += 1

    where_sql = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    count_params  = list(params)
    select_params = list(params) + [page_size, offset]

    try:
        count_row = await db_pool.fetchrow(
            f"SELECT COUNT(*) AS n FROM public.admin_logs l {where_sql}",
            *count_params,
        )
        total = int(count_row["n"]) if count_row else 0

        rows = await db_pool.fetch(
            f"""
            SELECT
                l.id, l.admin_id, l.action, l.target_id,
                l.target_type, l.metadata, l.created_at,
                p.full_name AS admin_name,
                p.email     AS admin_email
            FROM public.admin_logs l
            JOIN public.profiles p ON p.id = l.admin_id
            {where_sql}
            ORDER BY l.created_at DESC
            LIMIT ${p} OFFSET ${p + 1}
            """,
            *select_params,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch logs: {exc}"))

    data = []
    for row in rows:
        meta = row["metadata"]
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = None
        data.append({
            "id":          str(row["id"]),
            "admin_id":    str(row["admin_id"]),
            "admin_name":  row["admin_name"],
            "admin_email": row["admin_email"],
            "action":      row["action"],
            "target_id":   row["target_id"],
            "target_type": row["target_type"],
            "metadata":    meta,
            "created_at":  row["created_at"].isoformat() if row["created_at"] else None,
        })

    return {"data": data, "total": total, "page": page, "page_size": page_size}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/event-views
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/event-views")
async def top_event_views(
    request:       Request,
    limit:         int  = Query(20, ge=1, le=200),
    admin_payload: dict = Depends(require_admin),
):
    """Return top events ranked by total view count."""
    db_pool = request.app.state.db_pool
    try:
        rows = await db_pool.fetch(
            """
            SELECT
                v.event_id,
                COALESCE(e.title, v.event_id)    AS title,
                COUNT(v.id)                       AS total_views,
                COUNT(DISTINCT v.viewer_id)       AS unique_viewers,
                MAX(v.viewed_at)                  AS last_viewed_at
            FROM public.event_views v
            LEFT JOIN public.kickflip_provider_events e ON e.id::text = v.event_id
            GROUP BY v.event_id, e.title
            ORDER BY total_views DESC
            LIMIT $1
            """,
            limit,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event views: {exc}"))

    return {
        "data": [
            {
                "event_id":       row["event_id"],
                "title":          row["title"],
                "total_views":    int(row["total_views"]),
                "unique_viewers": int(row["unique_viewers"]),
                "last_viewed_at": row["last_viewed_at"].isoformat() if row["last_viewed_at"] else None,
            }
            for row in rows
        ]
    }
