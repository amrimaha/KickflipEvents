"""
/api/me/dashboard — Creator dashboard stats.

GET /api/me/dashboard  — event counts, view stats, per-event breakdown
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.auth.dependencies import require_auth
from app.api._util import err

router = APIRouter(prefix="/api/me/dashboard", tags=["api:dashboard"])


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/me/dashboard
# ─────────────────────────────────────────────────────────────────────────────

@router.get("")
async def get_dashboard(request: Request, auth: dict = Depends(require_auth)):
    """
    Return a summary of the authenticated user's events and view statistics.

    Runs three parallel-ish queries:
      1. Event counts by status
      2. Total views + unique viewers across all creator events
      3. Per-event stats (id, title, status, start_date, tickets_sold, price, is_free, views)
    """
    db_pool    = request.app.state.db_pool
    creator_id = auth["user_id"]

    # ── Query 1: event counts by status ──────────────────────────────────────
    try:
        status_rows = await db_pool.fetch(
            """
            SELECT status, COUNT(*) AS count
            FROM public.kickflip_provider_events
            WHERE creator_id = $1
            GROUP BY status
            """,
            creator_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event counts: {exc}"))

    status_counts: dict = {}
    for row in status_rows:
        status_counts[row["status"]] = int(row["count"])

    total_events     = sum(status_counts.values())
    active_events    = status_counts.get("active", 0)
    draft_events     = status_counts.get("draft", 0)
    completed_events = status_counts.get("completed", 0)

    # ── Query 2: total views + unique viewers ─────────────────────────────────
    try:
        views_row = await db_pool.fetchrow(
            """
            SELECT
                COUNT(*)                    AS total_views,
                COUNT(DISTINCT viewer_id)   AS unique_viewers
            FROM public.event_views
            WHERE event_id IN (
                SELECT id::text
                FROM public.kickflip_provider_events
                WHERE creator_id = $1
            )
            """,
            creator_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch view stats: {exc}"))

    total_views    = int(views_row["total_views"])   if views_row else 0
    unique_viewers = int(views_row["unique_viewers"]) if views_row else 0

    # ── Query 3: per-event stats ──────────────────────────────────────────────
    try:
        event_rows = await db_pool.fetch(
            """
            SELECT
                e.id,
                e.title,
                e.status,
                e.start_date,
                e.tickets_sold,
                e.price,
                e.is_free,
                COUNT(v.id) AS views
            FROM public.kickflip_provider_events e
            LEFT JOIN public.event_views v ON v.event_id = e.id::text
            WHERE e.creator_id = $1
            GROUP BY e.id
            ORDER BY e.created_at DESC
            """,
            creator_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event stats: {exc}"))

    events = [
        {
            "id":           str(row["id"]),
            "title":        row["title"],
            "status":       row["status"],
            "start_date":   row["start_date"],
            "tickets_sold": row["tickets_sold"] or 0,
            "price":        row["price"],
            "is_free":      bool(row["is_free"]),
            "views":        int(row["views"]),
        }
        for row in event_rows
    ]

    return {
        "total_events":     total_events,
        "active_events":    active_events,
        "draft_events":     draft_events,
        "completed_events": completed_events,
        "total_views":      total_views,
        "unique_viewers":   unique_viewers,
        "events":           events,
    }
