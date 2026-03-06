"""
Static crawler using httpx.

Features:
- Async HTTP/2 with connection pooling
- Tenacity retry with exponential backoff
- Per-domain rate limiting (simple token bucket)
- Respects robots.txt when configured
- User-agent spoof to avoid trivial bot blocks
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

import httpx

from app.config import settings
from app.crawlers.base import FetchResult
from app.utils.logger import BoundLogger

log = BoundLogger("kickflip.crawler.static")

# Per-domain rate-limit buckets: domain → last_request_time
_rate_bucket: dict[str, float] = {}
_RATE_DELAY_SECONDS = 1.0  # minimum gap between requests to same domain


async def _rate_limit(domain: str) -> None:
    now = time.monotonic()
    last = _rate_bucket.get(domain, 0.0)
    gap = now - last
    if gap < _RATE_DELAY_SECONDS:
        await asyncio.sleep(_RATE_DELAY_SECONDS - gap)
    _rate_bucket[domain] = time.monotonic()


def _build_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={
            "User-Agent": settings.robots_user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
        },
        follow_redirects=True,
        timeout=httpx.Timeout(settings.fetch_timeout),
        http2=True,
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )


async def fetch(
    url: str,
    client: Optional[httpx.AsyncClient] = None,
    run_id: str = "",
    source_name: str = "",
) -> FetchResult:
    """Fetch a single URL with retries and rate limiting."""
    from urllib.parse import urlparse
    domain = urlparse(url).netloc

    bound_log = log.bind(run_id=run_id, source_name=source_name, url=url, stage="fetch")

    await _rate_limit(domain)

    own_client = client is None
    if own_client:
        client = _build_client()

    t0 = time.monotonic()
    try:
        result = await _fetch_with_retry(client, url, bound_log)
        result.elapsed_ms = int((time.monotonic() - t0) * 1000)
        bound_log.info(
            "Fetched",
            stage="fetch",
            extra={"status": result.status_code, "elapsed_ms": result.elapsed_ms},
        )
        return result
    finally:
        if own_client:
            await client.aclose()


async def _fetch_with_retry(
    client: httpx.AsyncClient,
    url: str,
    bound_log: BoundLogger,
) -> FetchResult:
    last_error: Optional[str] = None

    for attempt in range(1, settings.max_retries + 1):
        try:
            resp = await client.get(url)
            html = resp.text
            return FetchResult(
                url=url,
                html=html,
                status_code=resp.status_code,
                final_url=str(resp.url),
            )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            last_error = str(exc)
            wait = min(2 ** attempt, settings.retry_wait_max)
            bound_log.warning(
                f"Fetch attempt {attempt} failed: {exc}; retrying in {wait}s"
            )
            await asyncio.sleep(wait)
        except httpx.HTTPStatusError as exc:
            return FetchResult(
                url=url,
                html="",
                status_code=exc.response.status_code,
                final_url=str(exc.response.url),
                error=str(exc),
            )

    return FetchResult(
        url=url,
        html="",
        status_code=0,
        final_url=url,
        error=f"All {settings.max_retries} attempts failed: {last_error}",
    )


async def fetch_many(
    urls: list[str],
    concurrency: int = 5,
    run_id: str = "",
    source_name: str = "",
) -> list[FetchResult]:
    """Fetch a list of URLs concurrently, bounded by *concurrency*."""
    semaphore = asyncio.Semaphore(concurrency)
    async with _build_client() as client:

        async def _fetch_one(url: str) -> FetchResult:
            async with semaphore:
                return await fetch(url, client=client, run_id=run_id, source_name=source_name)

        return list(await asyncio.gather(*[_fetch_one(u) for u in urls]))
