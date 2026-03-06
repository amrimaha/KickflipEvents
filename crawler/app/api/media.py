"""
/api/upload-media — Upload images/videos to Supabase Storage.

POST /api/upload-media  — multipart/form-data upload; returns public URL
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from app.auth.dependencies import require_auth
from app.api._util import err
from app.config import settings
from app.utils.logger import BoundLogger

router = APIRouter(prefix="/api/upload-media", tags=["api:media"])
log = BoundLogger("kickflip.api.media")

_ALLOWED_MIMES = {
    "image/jpeg", "image/png", "image/webp", "image/gif",
    "video/mp4", "video/quicktime", "video/webm",
}

_MAX_BYTES = 20 * 1024 * 1024   # 20 MB


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/upload-media
# ─────────────────────────────────────────────────────────────────────────────

@router.post("")
async def upload_media(
    request:  Request,
    file:     UploadFile = File(...),
    event_id: Optional[str] = Form(None),
    auth:     dict = Depends(require_auth),
):
    """
    Upload an image or video to Supabase Storage and record the metadata in
    the event_media table.

    Allowed types: JPEG, PNG, WebP, GIF, MP4, QuickTime, WebM
    Max size: 20 MB
    """
    # ── 1. Validate Content-Length (fast reject) ──────────────────────────────
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > _MAX_BYTES:
        return JSONResponse(
            status_code=413,
            content=err("File too large (max 20 MB)", "PAYLOAD_TOO_LARGE"),
        )

    # ── 2. Validate MIME type ─────────────────────────────────────────────────
    mime = file.content_type or ""
    if mime not in _ALLOWED_MIMES:
        return JSONResponse(
            status_code=415,
            content=err(
                f"Unsupported media type '{mime}'. "
                f"Allowed: {', '.join(sorted(_ALLOWED_MIMES))}",
                "UNSUPPORTED_MEDIA_TYPE",
            ),
        )

    # ── 3. Read file bytes + enforce size ─────────────────────────────────────
    file_bytes = await file.read()
    if len(file_bytes) > _MAX_BYTES:
        return JSONResponse(
            status_code=413,
            content=err("File too large (max 20 MB)", "PAYLOAD_TOO_LARGE"),
        )

    # ── 4. Determine media type ───────────────────────────────────────────────
    media_type = "image" if mime.startswith("image/") else "video"

    # ── 5. Build storage path ─────────────────────────────────────────────────
    safe_filename = (file.filename or "upload").replace(" ", "_")
    storage_path  = f"events/{auth['user_id']}/{uuid.uuid4()}/{safe_filename}"
    public_url    = (
        f"{settings.supabase_url}/storage/v1/object/public"
        f"/{settings.storage_bucket}/{storage_path}"
    )

    # ── 6. Upload to Supabase Storage via REST API ────────────────────────────
    upload_url = (
        f"{settings.supabase_url}/storage/v1/object"
        f"/{settings.storage_bucket}/{storage_path}"
    )
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                upload_url,
                headers={
                    "Authorization": f"Bearer {settings.supabase_service_key}",
                    "Content-Type":  mime,
                },
                content=file_bytes,
            )
            if resp.status_code not in (200, 201):
                detail = resp.text[:200]
                log.warning(f"Supabase Storage upload failed: {resp.status_code} {detail}")
                return JSONResponse(
                    status_code=500,
                    content=err(f"Storage upload failed: {detail}", "STORAGE_ERROR"),
                )
    except Exception as exc:
        log.warning(f"Supabase Storage upload error: {exc}")
        return JSONResponse(
            status_code=500,
            content=err(f"Storage upload error: {exc}", "STORAGE_ERROR"),
        )

    # ── 7. Record in event_media table ────────────────────────────────────────
    db_pool = request.app.state.db_pool
    try:
        await db_pool.execute(
            """
            INSERT INTO public.event_media
                (event_id, storage_path, public_url, type, size_bytes, uploaded_by)
            VALUES
                ($1, $2, $3, $4, $5, $6::uuid)
            """,
            event_id,
            storage_path,
            public_url,
            media_type,
            len(file_bytes),
            auth["user_id"],
        )
    except Exception as exc:
        # Log but don't fail — the file is already uploaded
        log.warning(f"Failed to record event_media row: {exc}")

    return {
        "ok":           True,
        "public_url":   public_url,
        "storage_path": storage_path,
        "type":         media_type,
        "size_bytes":   len(file_bytes),
    }
