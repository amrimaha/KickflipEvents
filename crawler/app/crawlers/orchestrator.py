"""
Crawl orchestrator — the heart of the pipeline.

For each source:
  1. source_start        → log
  2. discover_urls       → fetch listing pages, extract event URLs
  3. fetch / render      → static or dynamic based on strategy
  4. parse               → JSON-LD → microdata → profile → heuristics → LLM
  5. normalize           → validate, filter future, generate summaries
  6. upsert_db           → store or update in Supabase
  7. source_done         → log timing + counts

All sources run concurrently (bounded by MAX_CONCURRENT_SOURCES).
"""
from __future__ import annotations

import asyncio
import time
import traceback
from datetime import datetime, timezone
from typing import Optional

from app.config import settings
from app.crawlers import static as static_crawler
from app.crawlers import dynamic as dynamic_crawler
from app.crawlers.base import FetchResult, looks_like_spa
from app.models.event import ExtractionMethod, RawEventData
from app.models.run import RunSummary, SourceResult
from app.models.source import CrawlStrategy, SourceConfig
from app.parsers import heuristics, jsonld, microdata, normalizer
from app.parsers import selector_adapter
from app.storage import database
from app.utils.logger import BoundLogger
from app.utils.url_utils import (
    apply_crawl_delay,
    canonicalize_url,
    check_robots,
    extract_domain,
    is_likely_event_url,
    same_domain,
)

log = BoundLogger("kickflip.orchestrator")


# ── URL Discovery ─────────────────────────────────────────────────────────────

def _discover_urls_from_html(
    html: str,
    page_url: str,
    source: SourceConfig,
    profile: Optional[dict],
) -> list[str]:
    """Extract candidate event URLs from a listing page."""
    from bs4 import BeautifulSoup

    # Profile-based discovery (most accurate)
    if profile:
        urls = selector_adapter.extract_event_urls(html, page_url, profile)
        if urls:
            return urls

    # JSON-LD ItemList
    events = jsonld.extract_from_html(html, page_url)
    jsonld_urls = [e.event_url for e in events if e.event_url]
    if jsonld_urls:
        return [canonicalize_url(u, base=page_url) for u in jsonld_urls]

    # Generic link scan
    soup = BeautifulSoup(html, "lxml")
    candidates: list[str] = []

    for a in soup.find_all("a", href=True):
        href = str(a["href"])
        url = canonicalize_url(href, base=page_url)
        if not same_domain(url, source.base_url):
            continue
        if not is_likely_event_url(url, source.allow_patterns, source.deny_patterns):
            continue
        candidates.append(url)

    return list(dict.fromkeys(candidates))  # deduplicate, preserve order


# ── Per-page extraction pipeline ──────────────────────────────────────────────

def _extract_raw_events(
    html: str,
    page_url: str,
    profile: Optional[dict],
) -> tuple[list[RawEventData], ExtractionMethod]:
    """
    Layered extraction: JSON-LD → microdata → site_profile → heuristics.
    Returns (raw_events, method_used).
    """
    # A) JSON-LD
    results = jsonld.extract_from_html(html, page_url)
    if results:
        return results, ExtractionMethod.jsonld

    # B) Microdata
    results = microdata.extract_from_html(html, page_url)
    if results:
        return results, ExtractionMethod.microdata

    # C) Site profile selectors
    if profile:
        result = selector_adapter.extract_event(html, page_url, profile)
        if result and result.has_minimum_data():
            return [result], ExtractionMethod.site_profile

    # D) Heuristics
    result = heuristics.extract_event(html, page_url)
    return [result], ExtractionMethod.heuristics


def _needs_llm_fallback(raws: list[RawEventData], method: ExtractionMethod) -> bool:
    """Return True if the extraction results are weak enough to warrant LLM fallback."""
    if not settings.enable_llm_fallback or not settings.llm_api_key:
        return False
    # Only fallback on heuristic results with missing critical fields
    if method != ExtractionMethod.heuristics:
        return False
    primary = raws[0] if raws else None
    if primary is None:
        return True
    # Invoke if title or start date is missing
    return not (primary.title and primary.start_datetime_raw)


# ── Source crawl ──────────────────────────────────────────────────────────────

async def crawl_source(
    source: SourceConfig,
    browser,                        # playwright Browser
    source_semaphore: asyncio.Semaphore,
    run_id: str,
    run_time: datetime,
    db_pool,
    llm_client=None,                # app.utils.llm_client.LLMClient | None
    llm_call_counter: Optional[list] = None,  # [int] shared across all sources
) -> SourceResult:
    """Full pipeline for one source. Never raises — errors are captured."""
    result = SourceResult(source_name=source.name)
    t_source_start = time.monotonic()
    bound_log = log.bind(run_id=run_id, source_name=source.name)
    respect_robots_effective = source.respect_robots if source.respect_robots is not None else settings.respect_robots_txt
    bound_log.info(
        "Starting source",
        stage="source_start",
        url=source.base_url,
        extra={
            "user_agent": settings.robots_user_agent,
            "respect_robots": respect_robots_effective,
        },
    )

    async with source_semaphore:
        try:
            profile = selector_adapter.load_profile(
                source.name, settings.site_profiles_dir
            )

            render_semaphore = asyncio.Semaphore(settings.max_concurrent_pages_per_source)

            if source.single_page:
                # listing_urls are themselves the event pages — skip URL discovery
                all_event_urls = list(dict.fromkeys(source.effective_listing_urls()))
                all_event_urls = all_event_urls[: source.max_pages_per_run]
                bound_log.info(
                    f"single_page mode: {len(all_event_urls)} event URL(s)",
                    stage="discover_urls",
                )
            else:
                # ── Phase 1: Discover event URLs ──────────────────────────────
                listing_urls = source.effective_listing_urls()
                all_event_urls: list[str] = []

                for listing_url in listing_urls:
                    bound_log.info(
                        "Discovering URLs", stage="discover_urls", url=listing_url
                    )
                    listing_result = await _fetch_page(
                        url=listing_url,
                        source=source,
                        browser=browser,
                        render_semaphore=render_semaphore,
                        run_id=run_id,
                    )
                    if not listing_result.ok:
                        err = (
                            f"Listing fetch failed [{listing_result.status_code}]: "
                            f"{listing_url} — {listing_result.error or 'no detail'}"
                        )
                        if listing_result.status_code == 404:
                            err += " [MISCONFIGURED: listing URL does not exist — update sources.yaml]"
                        result.errors.append(err)
                        bound_log.warning(
                            err,
                            stage="discover_urls",
                            url=listing_url,
                            extra={"final_url": listing_result.final_url},
                        )
                        continue

                    discovered = _discover_urls_from_html(
                        listing_result.html, listing_result.final_url, source, profile
                    )
                    if not discovered:
                        # Log a sample of all same-domain hrefs to help diagnose
                        # allow_pattern mismatches (visible at DEBUG level).
                        from bs4 import BeautifulSoup
                        soup_dbg = BeautifulSoup(listing_result.html, "lxml")
                        all_hrefs = [
                            str(a["href"]) for a in soup_dbg.find_all("a", href=True)
                            if same_domain(
                                canonicalize_url(str(a["href"]), base=listing_result.final_url),
                                source.base_url,
                            )
                        ]
                        sample = all_hrefs[:10]
                        msg = f"URL discovery returned 0 results from {listing_url}"
                        result.errors.append(msg)
                        bound_log.warning(
                            msg,
                            stage="discover_urls",
                            url=listing_url,
                            extra={"same_domain_hrefs_sample": sample, "total_hrefs": len(all_hrefs)},
                        )
                        continue
                    bound_log.info(
                        f"Discovered {len(discovered)} URLs",
                        stage="discover_urls",
                        url=listing_url,
                    )
                    all_event_urls.extend(discovered)

                # Deduplicate discovered URLs
                all_event_urls = list(dict.fromkeys(all_event_urls))
                all_event_urls = all_event_urls[: source.max_pages_per_run]

            result.urls_discovered = len(all_event_urls)

            # ── Phase 2: Fetch & extract each event page ──────────────────
            event_tasks = [
                _process_event_page(
                    url=eu,
                    source=source,
                    profile=profile,
                    browser=browser,
                    render_semaphore=render_semaphore,
                    run_id=run_id,
                    run_time=run_time,
                    bound_log=bound_log,
                    db_pool=db_pool,
                    llm_client=llm_client,
                    llm_call_counter=llm_call_counter,
                )
                for eu in all_event_urls
            ]

            page_results = await asyncio.gather(*event_tasks, return_exceptions=True)

            for pr in page_results:
                if isinstance(pr, Exception):
                    result.errors.append(str(pr))
                    continue
                pages_fetched, events_parsed, events_stored, events_filtered = pr
                result.pages_fetched += pages_fetched
                result.events_parsed += events_parsed
                result.events_stored += events_stored
                result.events_filtered_past += events_filtered

        except Exception as exc:
            tb = traceback.format_exc()
            bound_log.error(f"Source failed: {exc}", stage="source_done")
            result.errors.append(f"Source error: {exc}\n{tb[:500]}")
            result.status = "error"

    result.duration_ms = int((time.monotonic() - t_source_start) * 1000)
    if result.errors and result.status != "error":
        result.status = "partial"

    bound_log.info(
        "Source done",
        stage="source_done",
        elapsed_ms=result.duration_ms,
        extra={
            "urls": result.urls_discovered,
            "pages": result.pages_fetched,
            "stored": result.events_stored,
            "filtered": result.events_filtered_past,
            "errors": len(result.errors),
        },
    )
    return result


async def _fetch_page(
    url: str,
    source: SourceConfig,
    browser,
    render_semaphore: asyncio.Semaphore,
    run_id: str,
) -> FetchResult:
    """
    Fetch a page using static or dynamic crawler based on source strategy.

    robots.txt is checked ONCE here (not inside each crawler) so that
    auto-strategy pages are never checked twice.
    """
    # Per-source override takes precedence; fall back to global setting.
    should_check = (
        source.respect_robots
        if source.respect_robots is not None
        else settings.respect_robots_txt
    )
    if should_check:
        result = await check_robots(
            url,
            user_agent=settings.robots_user_agent,
            fetch_timeout=settings.robots_fetch_timeout,
        )
        bound_log = log.bind(run_id=run_id, source_name=source.name)
        from urllib.parse import urlparse as _urlparse
        _p = _urlparse(url)
        robots_url = f"{_p.scheme}://{_p.netloc}/robots.txt"
        if result.status in ("timeout", "error", "missing"):
            # Log non-OK status but still allow (fail-open)
            bound_log.warning(
                f"robots.txt {result.status} for {url} — treating as allowed",
                stage="fetch",
                url=url,
                extra={
                    "robots_url": robots_url,
                    "robots_fetch_status": result.fetch_status,
                    "robots_status": result.status,
                    "robots_error": result.error,
                },
            )
        elif not result.allowed:
            bound_log.warning(
                "Blocked by robots.txt",
                stage="fetch",
                url=url,
                extra={
                    "robots_url": robots_url,
                    "robots_fetch_status": result.fetch_status,
                    "robots_ua": settings.robots_user_agent,
                    "robots_status": result.status,
                    "matched_rule": result.matched_rule,
                    "respect_robots_effective": should_check,
                },
            )
            return FetchResult(
                url=url, html="", status_code=403, final_url=url,
                error=f"robots.txt disallowed ({result.matched_rule or 'unknown rule'})",
            )
        # Respect Crawl-delay if the site specified one
        if result.crawl_delay and result.crawl_delay > 0:
            domain = extract_domain(url)
            await apply_crawl_delay(domain, result.crawl_delay)

    elif source.crawl_delay_seconds and source.crawl_delay_seconds > 0:
        # robots check was skipped (respect_robots=false) but source has a
        # static delay configured — honour it to stay polite
        domain = extract_domain(url)
        await apply_crawl_delay(domain, source.crawl_delay_seconds)

    if source.crawl_strategy == CrawlStrategy.static:
        return await static_crawler.fetch(url, run_id=run_id, source_name=source.name)

    if source.crawl_strategy == CrawlStrategy.dynamic:
        return await dynamic_crawler.fetch(
            url, browser, render_semaphore, run_id=run_id, source_name=source.name
        )

    # auto: try static first
    static_result = await static_crawler.fetch(url, run_id=run_id, source_name=source.name)
    if static_result.ok and not looks_like_spa(static_result.html):
        return static_result

    # Promote to dynamic (SPA detected or static fetch failed)
    return await dynamic_crawler.fetch(
        url, browser, render_semaphore, run_id=run_id, source_name=source.name
    )


async def _process_event_page(
    url: str,
    source: SourceConfig,
    profile: Optional[dict],
    browser,
    render_semaphore: asyncio.Semaphore,
    run_id: str,
    run_time: datetime,
    bound_log: BoundLogger,
    db_pool=None,
    llm_client=None,
    llm_call_counter: Optional[list] = None,
) -> tuple[int, int, int, int]:
    """
    Fetch, parse, normalize, and store one event page.
    Returns (pages_fetched, events_parsed, events_stored, events_filtered).
    """
    from app.storage import database as db

    pages_fetched = events_parsed = events_stored = events_filtered = 0

    fetch_result = await _fetch_page(url, source, browser, render_semaphore, run_id)
    pages_fetched += 1

    if not fetch_result.ok:
        bound_log.warning(
            f"Page fetch failed: {fetch_result.error}",
            url=url,
            stage="fetch",
        )
        return pages_fetched, events_parsed, events_stored, events_filtered

    raws, method = _extract_raw_events(
        fetch_result.html, fetch_result.final_url, profile
    )

    # ── Event detail gate ─────────────────────────────────────────────────
    # Listing, category, and editorial pages reach here when allow_patterns
    # are too broad.  For heuristics-only results, require at least a
    # parseable start date — without it this is almost certainly not an
    # individual event detail page.
    if method == ExtractionMethod.heuristics:
        primary = raws[0] if raws else None
        if not primary or not primary.start_datetime_raw:
            bound_log.info(
                "Not an event detail page (heuristics, no start_datetime) — skipping",
                stage="parse",
                url=url,
                extra={"title": primary.title if primary else None},
            )
            return pages_fetched, 0, 0, 0

    # ── LLM fallback if heuristics found nothing useful ────────────────────
    if _needs_llm_fallback(raws, method) and llm_client and llm_call_counter is not None:
        from app.parsers import llm_fallback
        llm_raw = await llm_fallback.extract_event(
            html=fetch_result.html,
            page_url=fetch_result.final_url,
            llm_client=llm_client,
            call_counter=llm_call_counter,
            max_calls=settings.llm_max_calls_per_run,
        )
        if llm_raw:
            raws = [llm_raw]
            method = ExtractionMethod.llm_fallback

    for raw in raws:
        if not raw.event_url:
            raw.event_url = fetch_result.final_url

        bound_log.info(
            "Parsed event",
            stage="parse",
            url=url,
            extra={"method": method, "title": raw.title},
        )

        ev = normalizer.normalize(
            raw=raw,
            method=method,
            source_name=source.name,
            source_url=source.base_url,
            page_url=fetch_result.final_url,
            tz_name=settings.timezone,
            seattle_scoped=source.seattle_scoped,
            run_time=run_time,
        )

        if ev is None:
            events_filtered += 1
            continue

        events_parsed += 1

        try:
            stored = await db.upsert_event(ev, db_pool)
            if stored:
                events_stored += 1
            else:
                events_filtered += 1  # deduped / unchanged
        except Exception as exc:
            bound_log.error(f"DB upsert failed: {exc}", url=url, stage="upsert_db")

    return pages_fetched, events_parsed, events_stored, events_filtered


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_all_sources(
    sources: list[SourceConfig],
    run_id: str,
    summary: RunSummary,
    db_pool,
) -> RunSummary:
    """
    Crawl all sources concurrently and populate *summary*.
    Uses a shared Playwright browser and a global source semaphore.
    """
    run_time = datetime.now(timezone.utc)

    # ── LLM client setup (shared across all sources) ──────────────────────
    llm_client = None
    llm_call_counter: list[int] = [0]   # mutable shared counter; asyncio is single-threaded

    if settings.enable_llm_fallback and settings.llm_api_key:
        from app.utils.llm_client import LLMClient
        llm_client = LLMClient(
            provider=settings.llm_provider,
            model=settings.llm_model,
            api_key=settings.llm_api_key,
        )
        log.info(
            f"LLM fallback enabled: provider={settings.llm_provider} "
            f"model={settings.llm_model} cap={settings.llm_max_calls_per_run}",
            run_id=run_id,
        )

    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )

        source_semaphore = asyncio.Semaphore(settings.max_concurrent_sources)

        tasks = [
            crawl_source(
                source=src,
                browser=browser,
                source_semaphore=source_semaphore,
                run_id=run_id,
                run_time=run_time,
                db_pool=db_pool,
                llm_client=llm_client,
                llm_call_counter=llm_call_counter,
            )
            for src in sources
        ]

        source_results = await asyncio.gather(*tasks, return_exceptions=True)

        await browser.close()

    for i, sr in enumerate(source_results):
        if isinstance(sr, Exception):
            fallback = SourceResult(
                source_name=sources[i].name,
                status="error",
                errors=[str(sr)],
            )
            summary.add_source(fallback)
        else:
            summary.add_source(sr)

    if llm_call_counter[0] > 0:
        log.info(
            f"LLM fallback used {llm_call_counter[0]} calls this run",
            run_id=run_id,
        )

    return summary
