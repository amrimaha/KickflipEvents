"""
FastAPI auth dependencies for Kickflip Parser.

Protected endpoints require a valid Supabase JWT issued to a user whose row
in public.profiles has role = 'admin'.

Flow:
  1. Extract Bearer token from the Authorization header.
  2. Resolve the signing key from the Supabase JWKS endpoint (RS256 or ES256).
     Keys are fetched via httpx and cached in-memory (TTL: 1 hour).
     On a kid cache-miss the cache is refreshed once to handle key rotation.
  3. Verify the JWT signature and expiry.
  4. Extract `sub` (user UUID) from the verified claims.
  5. Query public.profiles WHERE id = $1 to confirm role = 'admin'.
  6. Return the decoded payload on success.

Error responses:
  401 — missing / expired / invalid token
  403 — valid token but user is not an admin
  500 — SUPABASE_JWKS_URL not configured (fail closed, never fail open)
  503 — database unavailable
"""
from __future__ import annotations

import time
from typing import Optional

import httpx
import jwt
from jwt import PyJWK
from fastapi import HTTPException, Request

from app.config import settings

# ── JWKS cache (httpx-based, avoids urllib.request Windows firewall issues) ───
# Keys are fetched via httpx (same client used by crawlers) and cached for
# _JWKS_TTL seconds.  On a kid miss the cache is force-refreshed once so that
# key rotation is handled transparently.
_jwks_cache: Optional[dict] = None
_jwks_cache_at: float = 0.0
_JWKS_TTL: float = 3600.0  # seconds


async def _fetch_jwks(force: bool = False) -> dict:
    """
    Return the JWKS as a dict.

    Priority:
      1. In-memory cache (if still within TTL and not forced).
      2. SUPABASE_JWKS_JSON env var — loaded directly, no network call.
         Use this when supabase.co is blocked at the network/ISP level.
      3. Live HTTP fetch via httpx (normal production path).
    """
    global _jwks_cache, _jwks_cache_at  # noqa: PLW0603
    now = time.monotonic()
    if not force and _jwks_cache is not None and (now - _jwks_cache_at) < _JWKS_TTL:
        return _jwks_cache

    if settings.supabase_jwks_json:
        import json as _json
        _jwks_cache = _json.loads(settings.supabase_jwks_json)
        _jwks_cache_at = now
        return _jwks_cache

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(settings.supabase_jwks_url)
        resp.raise_for_status()
        _jwks_cache = resp.json()
        _jwks_cache_at = time.monotonic()  # intentional: read by next call's TTL check
    return _jwks_cache


async def _get_signing_key(token: str) -> PyJWK:
    """Return the PyJWK matching the token's kid, refreshing cache if needed."""
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")

    jwks = await _fetch_jwks()
    key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)

    if key is None:
        # kid not in cache — Supabase may have rotated keys; refresh once
        jwks = await _fetch_jwks(force=True)
        key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)

    if key is None:
        raise HTTPException(
            status_code=401,
            detail="Could not resolve signing key: kid not found in JWKS.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return PyJWK(key)
    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Failed to construct signing key: {type(exc).__name__}: {exc!r}",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def require_admin(request: Request) -> dict:
    """
    FastAPI dependency — call as ``Depends(require_admin)``.

    Returns the decoded JWT payload on success.  Raises HTTPException
    on any auth/authorisation failure.
    """
    # ── 1. Extract token ──────────────────────────────────────────────────────
    auth_header: Optional[str] = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authorization header missing or not a Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Bearer token is empty.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── DEV BYPASS (DEBUG_MODE only — NEVER in production) ───────────────────
    if settings.debug_mode and token == settings.debug_bypass_token:
        return {
            "sub":   "00000000-0000-0000-0000-000000000000",
            "email": "dev@localhost",
            "role":  "admin",
        }

    # ── 0. Config guard ───────────────────────────────────────────────────────
    if not settings.supabase_jwks_url:
        raise HTTPException(
            status_code=500,
            detail="Server auth is not configured (SUPABASE_JWKS_URL missing).",
        )

    # ── 2. Resolve signing key from JWKS (httpx, async, cached) ──────────────
    try:
        signing_key = await _get_signing_key(token)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Could not resolve signing key: {type(exc).__name__}: {exc!r}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── 3. Verify JWT (RS256) ─────────────────────────────────────────────────
    try:
        payload: dict = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],  # Supabase uses ES256 on newer projects
            audience="authenticated",       # Supabase standard audience claim
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="Token has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── 4. Extract subject ────────────────────────────────────────────────────
    user_id: Optional[str] = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing 'sub' claim.")

    # ── 5. DB pool ────────────────────────────────────────────────────────────
    db_pool = getattr(request.app.state, "db_pool", None)
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable.")

    # ── 6. Admin check (profiles table) ──────────────────────────────────────
    try:
        row = await db_pool.fetchrow(
            "SELECT role FROM public.profiles WHERE id = $1",
            user_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not verify admin status: {exc}",
        )

    if row is None or row["role"] != "admin":
        raise HTTPException(
            status_code=403,
            detail="Admin access required.",
        )

    return payload


async def require_auth(request: Request) -> dict:
    """
    FastAPI dependency — call as ``Depends(require_auth)``.

    Passes for any authenticated, non-banned user (not just admins).
    Returns ``{"user_id": str, "role": str}`` on success.
    Raises HTTPException on any auth failure.
    """
    # ── 1. Extract token ──────────────────────────────────────────────────────
    auth_header: Optional[str] = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authorization header missing or not a Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Bearer token is empty.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── DEV BYPASS (DEBUG_MODE only — NEVER in production) ───────────────────
    if settings.debug_mode and token == settings.debug_bypass_token:
        return {"user_id": "00000000-0000-0000-0000-000000000000", "role": "admin"}

    # ── 0. Config guard ───────────────────────────────────────────────────────
    if not settings.supabase_jwks_url:
        raise HTTPException(
            status_code=500,
            detail="Server auth is not configured (SUPABASE_JWKS_URL missing).",
        )

    # ── 2. Resolve signing key ────────────────────────────────────────────────
    try:
        signing_key = await _get_signing_key(token)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Could not resolve signing key: {type(exc).__name__}: {exc!r}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── 3. Verify JWT ─────────────────────────────────────────────────────────
    try:
        payload: dict = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience="authenticated",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="Token has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=401,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── 4. Extract subject ────────────────────────────────────────────────────
    user_id: Optional[str] = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing 'sub' claim.")

    # ── 5. DB pool ────────────────────────────────────────────────────────────
    db_pool = getattr(request.app.state, "db_pool", None)
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Database unavailable.")

    # ── 6. Fetch profile (role + is_banned) — never trust JWT role claim ──────
    try:
        row = await db_pool.fetchrow(
            "SELECT role, is_banned FROM public.profiles WHERE id = $1",
            user_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not verify user: {exc}",
        )

    if row is None:
        raise HTTPException(status_code=401, detail="User profile not found.")

    if row["is_banned"]:
        raise HTTPException(status_code=403, detail="Account is banned.")

    return {"user_id": user_id, "role": row["role"]}
