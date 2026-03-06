"""
/api/profile/* — Authenticated user profile endpoints.

GET  /api/profile           — fetch own profile
PATCH /api/profile          — update allowed fields (role is blocked)
POST /api/profile/upsert    — create profile on first OAuth login (idempotent)
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth.dependencies import require_auth
from app.api._util import err, row_to_dict

router = APIRouter(prefix="/api/profile", tags=["api:profile"])

# Only these fields are writable by the user themselves
_ALLOWED_UPDATE_FIELDS = {"full_name", "phone", "avatar", "profile_cover_url", "notification_prefs"}
# Fields that must be JSON-serialised before passing to asyncpg as a JSONB param
_JSONB_FIELDS = {"notification_prefs"}


# ── Request models ────────────────────────────────────────────────────────────

class ProfilePatch(BaseModel):
    full_name:          Optional[str]  = None
    phone:              Optional[str]  = None
    avatar:             Optional[str]  = None
    profile_cover_url:  Optional[str]  = None
    notification_prefs: Optional[dict] = None
    # 'role' intentionally excluded — only changeable via admin endpoint


class ProfileUpsert(BaseModel):
    full_name:         Optional[str] = None
    email:             Optional[str] = None
    phone:             Optional[str] = None
    profile_cover_url: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/profile
# ─────────────────────────────────────────────────────────────────────────────

@router.get("")
async def get_profile(request: Request, auth: dict = Depends(require_auth)):
    """Return the authenticated user's own profile."""
    db_pool = request.app.state.db_pool
    try:
        row = await db_pool.fetchrow(
            """
            SELECT id, full_name, email, phone, avatar, profile_cover_url,
                   role, notification_prefs
              FROM public.profiles
             WHERE id = $1
            """,
            auth["user_id"],
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch profile: {exc}"))

    if row is None:
        return JSONResponse(status_code=404, content=err("Profile not found"))

    data = row_to_dict(row)
    # notification_prefs comes back as a dict from asyncpg (JSONB auto-parsed)
    # row_to_dict handles it fine, but ensure it's never a bare string
    if isinstance(data.get("notification_prefs"), str):
        try:
            data["notification_prefs"] = json.loads(data["notification_prefs"])
        except Exception:
            data["notification_prefs"] = None
    return data


# ─────────────────────────────────────────────────────────────────────────────
# PATCH /api/profile
# ─────────────────────────────────────────────────────────────────────────────

@router.patch("")
async def update_profile(
    body:    ProfilePatch,
    request: Request,
    auth:    dict = Depends(require_auth),
):
    """
    Update allowed profile fields.
    'role' is hard-blocked here — use PATCH /api/admin/users/{id}/role instead.
    """
    updates: dict = {}
    for field in _ALLOWED_UPDATE_FIELDS:
        val = getattr(body, field, None)
        if val is not None:
            # JSONB fields must be serialised to a JSON string for asyncpg
            updates[field] = json.dumps(val) if field in _JSONB_FIELDS else val

    if not updates:
        return JSONResponse(
            status_code=400,
            content=err("No valid fields provided", "NO_FIELDS"),
        )

    # Build SET clause dynamically from the validated field set
    set_parts = [f"{col} = ${i + 1}" for i, col in enumerate(updates)]
    set_parts.append("updated_at = NOW()")
    values    = list(updates.values())
    values.append(auth["user_id"])   # for WHERE id = $N

    sql = f"""
        UPDATE public.profiles
           SET {', '.join(set_parts)}
         WHERE id = ${len(values)}
        RETURNING id, full_name, phone, avatar, profile_cover_url, notification_prefs
    """

    db_pool = request.app.state.db_pool
    try:
        row = await db_pool.fetchrow(sql, *values)
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to update profile: {exc}"))

    return {"ok": True, "profile": row_to_dict(row) if row else {}}


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/profile/upsert
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/upsert")
async def upsert_profile(
    body:    ProfileUpsert,
    request: Request,
    auth:    dict = Depends(require_auth),
):
    """
    Idempotent: create profile on first OAuth login, or update non-role fields
    on subsequent calls.  'role' is never updated via this endpoint —
    existing roles are preserved, new profiles default to 'user'.
    """
    db_pool   = request.app.state.db_pool
    user_id   = auth["user_id"]

    # Derive the email from the JWT sub if not provided in body
    # (Supabase stores email in the JWT 'email' claim)
    email = body.email

    try:
        await db_pool.execute(
            """
            INSERT INTO public.profiles
                (id, full_name, email, phone, profile_cover_url, role, updated_at)
            VALUES
                ($1, $2, $3, $4, $5, 'user', NOW())
            ON CONFLICT (id) DO UPDATE
               SET full_name         = COALESCE(EXCLUDED.full_name,         profiles.full_name),
                   email             = COALESCE(EXCLUDED.email,             profiles.email),
                   phone             = COALESCE(EXCLUDED.phone,             profiles.phone),
                   profile_cover_url = COALESCE(EXCLUDED.profile_cover_url, profiles.profile_cover_url),
                   updated_at        = NOW()
               -- role is intentionally NOT updated on conflict
            """,
            user_id,
            body.full_name,
            email,
            body.phone,
            body.profile_cover_url,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to upsert profile: {exc}"))

    return {"ok": True}
