"""Source configuration models (loaded from sources.yaml / sources.json)."""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, field_validator


class CrawlStrategy(str, Enum):
    static = "static"    # httpx only
    dynamic = "dynamic"  # Playwright always
    auto = "auto"        # static first; promote to dynamic on SPA signals


class SourceConfig(BaseModel):
    name: str
    base_url: str
    listing_urls: Optional[list[str]] = None
    crawl_strategy: CrawlStrategy = CrawlStrategy.auto

    # URL filtering (regex patterns)
    allow_patterns: list[str] = []
    deny_patterns: list[str] = []

    # Caps
    max_pages_per_run: int = 50

    # Seattle-scoped: if True, default city/state to Seattle, WA when missing
    seattle_scoped: bool = False

    notes: Optional[str] = None

    # Per-source robots.txt override.
    # None  → use the global RESPECT_ROBOTS_TXT setting (default).
    # True  → always respect robots.txt for this source.
    # False → skip robots.txt check for this source (use when you have
    #          explicit permission or the site incorrectly blocks crawlers).
    respect_robots: Optional[bool] = None

    # Static crawl delay (seconds) applied between every page fetch for this
    # source, regardless of robots.txt.  Primary use: honour a site's stated
    # Crawl-delay when respect_robots=false (so robots.txt is never read).
    # Ignored when respect_robots is True/None and robots.txt already specifies
    # its own Crawl-delay.
    crawl_delay_seconds: Optional[float] = None

    # single_page: if True, skip Phase 1 URL discovery; listing_urls are event pages
    single_page: bool = False

    # Set to false to skip this source without removing it from the file
    enabled: bool = True

    @field_validator("listing_urls", mode="before")
    @classmethod
    def coerce_listing_urls(cls, v):
        if isinstance(v, str):
            return [v]
        return v

    def effective_listing_urls(self) -> list[str]:
        """Return listing_urls if set, else [base_url]."""
        return self.listing_urls or [self.base_url]
