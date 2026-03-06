"""
/api/events/* — Provider event CRUD + public read endpoints.

Public:
  GET  /api/events        — list active provider events (no auth)
  GET  /api/events/{id}   — get single provider event (no auth)

Authenticated (any logged-in, non-banned user):
  POST   /api/events       — create a new event
  PUT    /api/events/{id}  — update own event (admin bypasses ownership)
  DELETE /api/events/{id}  — delete own event (admin bypasses ownership)

Events are stored in public.kickflip_provider_events (user-submitted UI events).
This table is separate from public.kickflip_events (crawler-ingested events).
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth.dependencies import require_auth
from app.api._util import check_payload_size, err, row_to_dict

router = APIRouter(prefix="/api/events", tags=["api:events"])

_VALID_CATEGORIES = {
    "music", "food", "art", "outdoor", "party",
    "wellness", "fashion", "sports", "comedy", "other",
}
_VALID_STATUSES = {"active", "draft", "completed"}


# ── Request model ─────────────────────────────────────────────────────────────

class MediaItem(BaseModel):
    type: str                    # "image" | "video"
    url:  Optional[str] = None   # file field stripped server-side


class EventDraft(BaseModel):
    title:                str
    category:             Optional[str] = None
    vibeDescription:      Optional[str] = None
    locationName:         Optional[str] = None
    address:              Optional[str] = None
    startDate:            Optional[str] = None   # YYYY-MM-DD
    startTime:            Optional[str] = None   # HH:MM
    endDate:              Optional[str] = None
    endTime:              Optional[str] = None
    isFree:               Optional[bool] = None
    price:                Optional[str] = None
    isUnlimitedCapacity:  Optional[bool] = None
    capacity:             Optional[int] = None
    overview:             Optional[str] = None
    media:                Optional[list[MediaItem]] = None
    status:               Optional[str] = None   # active | draft | completed
    origin:               Optional[str] = "user"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _draft_to_db(draft: EventDraft) -> dict[str, Any]:
    """Map camelCase EventDraft → snake_case DB columns."""
    return {
        "title":                 draft.title,
        "category":              draft.category,
        "vibe_description":      draft.vibeDescription,
        "location_name":         draft.locationName,
        "address":               draft.address,
        "start_date":            draft.startDate,
        "start_time":            draft.startTime,
        "end_date":              draft.endDate,
        "end_time":              draft.endTime,
        "is_free":               draft.isFree,
        "price":                 draft.price,
        "is_unlimited_capacity": draft.isUnlimitedCapacity,
        "capacity":              draft.capacity,
        "overview":              draft.overview,
        # Strip any 'file' object fields — only persist {type, url}
        "media": [
            {"type": m.type, "url": m.url}
            for m in (draft.media or [])
            if m.url
        ],
        "status": draft.status or "draft",
        "origin": draft.origin or "user",
    }


def _db_to_client(row) -> dict:
    """Map snake_case DB row → camelCase client response."""
    d = row_to_dict(row)
    return {
        "id":                   d.get("id"),
        "title":                d.get("title"),
        "category":             d.get("category"),
        "vibeDescription":      d.get("vibe_description"),
        "locationName":         d.get("location_name"),
        "address":              d.get("address"),
        "startDate":            d.get("start_date"),
        "startTime":            d.get("start_time"),
        "endDate":              d.get("end_date"),
        "endTime":              d.get("end_time"),
        "isFree":               d.get("is_free"),
        "price":                d.get("price"),
        "isUnlimitedCapacity":  d.get("is_unlimited_capacity"),
        "capacity":             d.get("capacity"),
        "overview":             d.get("overview"),
        "media":                d.get("media") or [],
        "status":               d.get("status"),
        "creatorId":            d.get("creator_id"),
        "origin":               d.get("origin"),
        "ticketsSold":          d.get("tickets_sold"),
        "createdAt":            d.get("created_at"),
        "updatedAt":            d.get("updated_at"),
    }


# ── Priority 3: Public reads ──────────────────────────────────────────────────

@router.get("")
async def list_events(
    request:  Request,
    limit:    int           = Query(50, ge=1, le=100),
    category: Optional[str] = Query(None),
):
    """List active provider events (public, no auth required)."""
    if category and category not in _VALID_CATEGORIES:
        return JSONResponse(
            status_code=400,
            content=err(f"Invalid category '{category}'", "INVALID_CATEGORY"),
        )

    db_pool = request.app.state.db_pool
    if db_pool is None:
        return JSONResponse(status_code=503, content=err("Database unavailable"))

    try:
        if category:
            rows = await db_pool.fetch(
                """
                SELECT * FROM public.kickflip_provider_events
                WHERE status = 'active' AND category = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                category, limit,
            )
        else:
            rows = await db_pool.fetch(
                """
                SELECT * FROM public.kickflip_provider_events
                WHERE status = 'active'
                ORDER BY created_at DESC
                LIMIT $1
                """,
                limit,
            )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch events: {exc}"))

    return {"events": [_db_to_client(r) for r in rows]}


@router.get("/{event_id}")
async def get_event(event_id: str, request: Request):
    """Get a single provider event by ID (public, no auth required)."""
    db_pool = request.app.state.db_pool
    if db_pool is None:
        return JSONResponse(status_code=503, content=err("Database unavailable"))

    try:
        row = await db_pool.fetchrow(
            "SELECT * FROM public.kickflip_provider_events WHERE id = $1::uuid",
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event: {exc}"))

    if row is None:
        return JSONResponse(status_code=404, content=err("Event not found"))

    return _db_to_client(row)


# ── Priority 1: Authenticated writes ─────────────────────────────────────────

@router.post("", status_code=201)
async def create_event(
    draft:   EventDraft,
    request: Request,
    auth:    dict = Depends(require_auth),
):
    """Create a new event. creatorId is always set from the verified JWT."""
    size_err = check_payload_size(request)
    if size_err:
        return JSONResponse(status_code=413, content=size_err)

    if not draft.title or not draft.title.strip():
        return JSONResponse(status_code=400, content=err("title is required", "MISSING_FIELD"))
    if draft.category and draft.category not in _VALID_CATEGORIES:
        return JSONResponse(status_code=400, content=err(f"Invalid category '{draft.category}'", "INVALID_CATEGORY"))
    if draft.status and draft.status not in _VALID_STATUSES:
        return JSONResponse(status_code=400, content=err(f"Invalid status '{draft.status}'", "INVALID_STATUS"))

    record = _draft_to_db(draft)

    # Only admin / provider may publish as 'active' immediately
    if record["status"] == "active" and auth["role"] not in ("admin", "provider"):
        record["status"] = "draft"

    # Always set creator_id from the verified JWT — never trust the request body
    record["creator_id"]   = auth["user_id"]
    record["tickets_sold"] = 0

    db_pool = request.app.state.db_pool
    try:
        row = await db_pool.fetchrow(
            """
            INSERT INTO public.kickflip_provider_events
                (title, category, vibe_description, location_name, address,
                 start_date, start_time, end_date, end_time,
                 is_free, price, is_unlimited_capacity, capacity,
                 overview, media, status, creator_id, origin, tickets_sold)
            VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            RETURNING id
            """,
            record["title"], record["category"], record["vibe_description"],
            record["location_name"], record["address"],
            record["start_date"], record["start_time"],
            record["end_date"], record["end_time"],
            record["is_free"], record["price"],
            record["is_unlimited_capacity"], record["capacity"],
            record["overview"],
            # asyncpg serialises Python list→JSONB automatically
            record["media"],
            record["status"], record["creator_id"], record["origin"],
            record["tickets_sold"],
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to create event: {exc}"))

    return JSONResponse(
        status_code=201,
        content={"ok": True, "id": str(row["id"])},
    )


@router.put("/{event_id}")
async def update_event(
    event_id: str,
    draft:    EventDraft,
    request:  Request,
    auth:     dict = Depends(require_auth),
):
    """Update an event. Only the owner or an admin may update."""
    size_err = check_payload_size(request)
    if size_err:
        return JSONResponse(status_code=413, content=size_err)

    if draft.category and draft.category not in _VALID_CATEGORIES:
        return JSONResponse(status_code=400, content=err(f"Invalid category '{draft.category}'", "INVALID_CATEGORY"))
    if draft.status and draft.status not in _VALID_STATUSES:
        return JSONResponse(status_code=400, content=err(f"Invalid status '{draft.status}'", "INVALID_STATUS"))

    db_pool = request.app.state.db_pool

    # Ownership check — fetch existing record first
    try:
        existing = await db_pool.fetchrow(
            "SELECT id, creator_id FROM public.kickflip_provider_events WHERE id = $1::uuid",
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event: {exc}"))

    if existing is None:
        return JSONResponse(status_code=404, content=err("Event not found"))

    if auth["role"] != "admin" and str(existing["creator_id"]) != auth["user_id"]:
        return JSONResponse(status_code=403, content=err("You do not own this event", "FORBIDDEN"))

    record = _draft_to_db(draft)
    # creator_id must never change — remove from update dict
    record.pop("creator_id", None)

    try:
        await db_pool.execute(
            """
            UPDATE public.kickflip_provider_events
               SET title                 = COALESCE($1,  title),
                   category              = COALESCE($2,  category),
                   vibe_description      = COALESCE($3,  vibe_description),
                   location_name         = COALESCE($4,  location_name),
                   address               = COALESCE($5,  address),
                   start_date            = COALESCE($6,  start_date),
                   start_time            = COALESCE($7,  start_time),
                   end_date              = COALESCE($8,  end_date),
                   end_time              = COALESCE($9,  end_time),
                   is_free               = COALESCE($10, is_free),
                   price                 = COALESCE($11, price),
                   is_unlimited_capacity = COALESCE($12, is_unlimited_capacity),
                   capacity              = COALESCE($13, capacity),
                   overview              = COALESCE($14, overview),
                   media                 = COALESCE($15, media),
                   status                = COALESCE($16, status),
                   origin                = COALESCE($17, origin),
                   updated_at            = NOW()
             WHERE id = $18::uuid
            """,
            record["title"], record["category"], record["vibe_description"],
            record["location_name"], record["address"],
            record["start_date"], record["start_time"],
            record["end_date"], record["end_time"],
            record["is_free"], record["price"],
            record["is_unlimited_capacity"], record["capacity"],
            record["overview"], record["media"] or None,
            record["status"], record["origin"],
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to update event: {exc}"))

    return {"ok": True}


@router.delete("/{event_id}")
async def delete_event(
    event_id: str,
    request:  Request,
    auth:     dict = Depends(require_auth),
):
    """Delete an event. Only the owner or an admin may delete."""
    db_pool = request.app.state.db_pool

    try:
        existing = await db_pool.fetchrow(
            "SELECT id, creator_id FROM public.kickflip_provider_events WHERE id = $1::uuid",
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch event: {exc}"))

    if existing is None:
        return JSONResponse(status_code=404, content=err("Event not found"))

    if auth["role"] != "admin" and str(existing["creator_id"]) != auth["user_id"]:
        return JSONResponse(status_code=403, content=err("You do not own this event", "FORBIDDEN"))

    try:
        await db_pool.execute(
            "DELETE FROM public.kickflip_provider_events WHERE id = $1::uuid",
            event_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to delete event: {exc}"))

    return {"ok": True}
