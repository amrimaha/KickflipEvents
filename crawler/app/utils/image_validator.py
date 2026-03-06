"""
Async image URL validator.

Performs a HEAD request to verify that a URL is a reachable image.
Results are cached for the duration of the process (one crawl run).

Usage:
    async with httpx.AsyncClient() as client:
        ok = await validate_image_url("https://example.com/photo.jpg", client)
"""
from __future__ import annotations

import httpx

# Module-level cache: url → bool.
# Concurrent writes for the same key are idempotent (same bool result),
# so no lock is needed.
_cache: dict[str, bool] = {}

_UNSPLASH_HOST = "images.unsplash.com"


async def validate_image_url(url: str, client: httpx.AsyncClient) -> bool:
    """
    HEAD request to verify the URL returns 200 and an image/* content-type.

    Rules:
    - Unsplash URLs are trusted — skipped (return True immediately).
    - Cache results for the process lifetime (cleared on restart).
    - 3-second timeout; any exception → False.
    - Accept: any 2xx status AND Content-Type starts with "image/".
    """
    if not url:
        return False

    # Unsplash is always trusted
    if _UNSPLASH_HOST in url:
        return True

    if url in _cache:
        return _cache[url]

    try:
        resp = await client.head(
            url,
            timeout=3.0,
            follow_redirects=True,
        )
        content_type = resp.headers.get("content-type", "")
        result = resp.is_success and content_type.startswith("image/")
    except Exception:
        result = False

    _cache[url] = result
    return result


def clear_cache() -> None:
    """Clear the validation cache (useful between test runs)."""
    _cache.clear()
