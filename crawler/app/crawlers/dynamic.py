"""
Dynamic crawler using Playwright (headless Chromium).

Features:
- Browser instance pool managed by caller (orchestrator)
- Per-context isolation (no cookie leakage across sites)
- Wait strategies: networkidle / domcontentloaded / custom selector
- Configurable render timeout
- Intercept unnecessary resources (images, fonts, media) for speed
- JavaScript injection to expand hidden content if needed
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional, TYPE_CHECKING

from app.config import settings
from app.crawlers.base import FetchResult
from app.utils.logger import BoundLogger

if TYPE_CHECKING:
    from playwright.async_api import Browser, BrowserContext, Page

log = BoundLogger("kickflip.crawler.dynamic")

# Resource types to abort (speeds up rendering significantly)
_BLOCKED_TYPES = {"image", "font", "media", "stylesheet"}

# "load" fires after the page load event and is reliable without the heavy
# overhead of "networkidle" (which waits for all XHRs to finish and times out
# on analytics-heavy / infinite-polling SPAs like Visit Seattle and MoPOP).
_WAIT_UNTIL = "load"

# After page load, wait this many ms more to let JS hydrate the DOM
_SETTLE_MS = 2000


async def _build_context(browser: "Browser") -> "BrowserContext":
    ctx = await browser.new_context(
        user_agent=settings.robots_user_agent,
        viewport={"width": 1280, "height": 900},
        locale="en-US",
        timezone_id=settings.timezone,
        java_script_enabled=True,
    )
    # Block heavy resources
    async def handle_route(route, request):
        if request.resource_type in _BLOCKED_TYPES:
            await route.abort()
        else:
            await route.continue_()

    await ctx.route("**/*", handle_route)
    return ctx


async def fetch(
    url: str,
    browser: "Browser",
    semaphore: asyncio.Semaphore,
    run_id: str = "",
    source_name: str = "",
    wait_selector: Optional[str] = None,
) -> FetchResult:
    """Render *url* with Playwright inside a fresh browser context."""
    bound_log = log.bind(run_id=run_id, source_name=source_name, url=url, stage="render")

    async with semaphore:
        t0 = time.monotonic()
        context: Optional["BrowserContext"] = None
        try:
            context = await _build_context(browser)
            page: "Page" = await context.new_page()
            page.set_default_timeout(settings.render_timeout * 1000)

            resp = await page.goto(url, wait_until=_WAIT_UNTIL, timeout=settings.render_timeout * 1000)
            status = resp.status if resp else 0

            # Extra settle time for SPAs
            await page.wait_for_timeout(_SETTLE_MS)

            # Optional: wait for a specific selector to appear
            if wait_selector:
                try:
                    await page.wait_for_selector(wait_selector, timeout=5_000)
                except Exception:
                    pass  # best-effort

            html = await page.content()
            final_url = page.url
            elapsed = int((time.monotonic() - t0) * 1000)

            bound_log.info("Rendered", stage="render", extra={"status": status, "elapsed_ms": elapsed})

            return FetchResult(
                url=url,
                html=html,
                status_code=status,
                final_url=final_url,
                is_dynamic=True,
                elapsed_ms=elapsed,
            )

        except Exception as exc:
            elapsed = int((time.monotonic() - t0) * 1000)
            bound_log.error(f"Playwright error: {exc}", stage="render")
            return FetchResult(
                url=url,
                html="",
                status_code=0,
                final_url=url,
                is_dynamic=True,
                error=str(exc),
                elapsed_ms=elapsed,
            )
        finally:
            if context:
                await context.close()


async def fetch_many(
    urls: list[str],
    browser: "Browser",
    concurrency: int = 3,
    run_id: str = "",
    source_name: str = "",
) -> list[FetchResult]:
    """Render multiple URLs concurrently."""
    semaphore = asyncio.Semaphore(concurrency)
    tasks = [
        fetch(url, browser, semaphore, run_id=run_id, source_name=source_name)
        for url in urls
    ]
    return list(await asyncio.gather(*tasks))
