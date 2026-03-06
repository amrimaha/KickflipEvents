"""
/api/admin/* — Admin-only user management endpoints.

All routes require role = 'admin' (enforced by require_admin dependency).
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.auth.dependencies import require_admin
from app.api._util import err, row_to_dict

router = APIRouter(prefix="/api/admin", tags=["api:admin"])

_VALID_SORT_FIELDS = {"created_at", "full_name", "email", "role", "is_banned"}
_VALID_ROLES       = {"user", "provider", "admin"}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/users
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/users")
async def list_users(
    request:  Request,
    page:     int           = Query(1,    ge=1),
    pageSize: int           = Query(25,   ge=1, le=200),
    sortBy:   str           = Query("created_at"),
    sortDir:  str           = Query("desc"),
    search:   Optional[str] = Query(None),
    _: dict = Depends(require_admin),
):
    if sortBy not in _VALID_SORT_FIELDS:
        return JSONResponse(
            status_code=400,
            content=err(
                f"Invalid sortBy. Must be one of: {', '.join(sorted(_VALID_SORT_FIELDS))}",
                "INVALID_PARAM",
            ),
        )
    if sortDir not in ("asc", "desc"):
        return JSONResponse(
            status_code=400,
            content=err('sortDir must be "asc" or "desc"', "INVALID_PARAM"),
        )

    db_pool = request.app.state.db_pool
    offset  = (page - 1) * pageSize

    # Safe: sortBy is validated against a hard-coded whitelist above
    order_clause = f"{sortBy} {sortDir.upper()}"

    search_param = f"%{search}%" if search else None

    try:
        # Total count (for pagination metadata)
        count_row = await db_pool.fetchrow(
            """
            SELECT COUNT(*) AS n
            FROM public.profiles
            WHERE ($1::text IS NULL
                   OR full_name ILIKE $1
                   OR email     ILIKE $1)
            """,
            search_param,
        )
        total = count_row["n"] if count_row else 0

        rows = await db_pool.fetch(
            f"""
            SELECT id, full_name, email, phone, role,
                   is_banned, banned_at, created_at, updated_at
            FROM public.profiles
            WHERE ($1::text IS NULL
                   OR full_name ILIKE $1
                   OR email     ILIKE $1)
            ORDER BY {order_clause}
            LIMIT $2 OFFSET $3
            """,
            search_param,
            pageSize,
            offset,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch users: {exc}"))

    return {
        "data":     [row_to_dict(r) for r in rows],
        "count":    total,
        "page":     page,
        "pageSize": pageSize,
    }


# ─────────────────────────────────────────────────────────────────────────────
# PATCH /api/admin/users/{user_id}/role
# ─────────────────────────────────────────────────────────────────────────────

class _RoleBody:
    pass


from pydantic import BaseModel  # noqa: E402


class RoleBody(BaseModel):
    role: str


class BanBody(BaseModel):
    banned: bool


@router.patch("/users/{user_id}/role")
async def update_role(
    user_id:       str,
    body:          RoleBody,
    request:       Request,
    admin_payload: dict = Depends(require_admin),
):
    if body.role not in _VALID_ROLES:
        return JSONResponse(
            status_code=400,
            content=err(
                f"Invalid role. Must be one of: {', '.join(sorted(_VALID_ROLES))}",
                "INVALID_ROLE",
            ),
        )

    db_pool  = request.app.state.db_pool
    admin_id = admin_payload.get("sub")

    # Fetch old value for audit log
    try:
        old_row = await db_pool.fetchrow(
            "SELECT role FROM public.profiles WHERE id = $1", user_id
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch user: {exc}"))

    if old_row is None:
        return JSONResponse(status_code=404, content=err("User not found"))

    old_role = old_row["role"]

    try:
        row = await db_pool.fetchrow(
            "UPDATE public.profiles SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id",
            body.role,
            user_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to update role: {exc}"))

    if row is None:
        return JSONResponse(status_code=404, content=err("User not found"))

    # Audit log (fire-and-forget)
    try:
        await db_pool.execute(
            """
            INSERT INTO public.admin_logs
                (admin_id, action, target_id, target_type, metadata)
            VALUES ($1::uuid, $2, $3, $4, $5)
            """,
            admin_id, "change_role", user_id, "user",
            json.dumps({"old_value": old_role, "new_value": body.role}),
        )
    except Exception:
        pass

    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# PATCH /api/admin/users/{user_id}/ban
# ─────────────────────────────────────────────────────────────────────────────

@router.patch("/users/{user_id}/ban")
async def update_ban(
    user_id:       str,
    body:          BanBody,
    request:       Request,
    admin_payload: dict = Depends(require_admin),
):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)

    db_pool  = request.app.state.db_pool
    admin_id = admin_payload.get("sub")

    # Fetch old value for audit log
    try:
        old_row = await db_pool.fetchrow(
            "SELECT is_banned FROM public.profiles WHERE id = $1", user_id
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to fetch user: {exc}"))

    if old_row is None:
        return JSONResponse(status_code=404, content=err("User not found"))

    old_banned = bool(old_row["is_banned"])

    try:
        row = await db_pool.fetchrow(
            """
            UPDATE public.profiles
               SET is_banned  = $1,
                   banned_at  = $2,
                   updated_at = NOW()
             WHERE id = $3
            RETURNING id, banned_at
            """,
            body.banned,
            now if body.banned else None,
            user_id,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content=err(f"Failed to update ban status: {exc}"))

    if row is None:
        return JSONResponse(status_code=404, content=err("User not found"))

    # Audit log (fire-and-forget)
    action = "ban_user" if body.banned else "unban_user"
    try:
        await db_pool.execute(
            """
            INSERT INTO public.admin_logs
                (admin_id, action, target_id, target_type, metadata)
            VALUES ($1::uuid, $2, $3, $4, $5)
            """,
            admin_id, action, user_id, "user",
            json.dumps({"old_value": old_banned, "new_value": body.banned}),
        )
    except Exception:
        pass

    banned_at = row["banned_at"].isoformat() if row["banned_at"] else None
    return {"ok": True, "banned_at": banned_at}
