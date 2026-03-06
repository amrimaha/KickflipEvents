"""Crawl run tracking models."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class SourceResult(BaseModel):
    source_name: str
    status: str = "ok"  # ok | error | partial
    urls_discovered: int = 0
    pages_fetched: int = 0
    events_parsed: int = 0
    events_stored: int = 0
    events_filtered_past: int = 0
    events_deduped: int = 0
    errors: list[str] = []
    duration_ms: int = 0


class RunSummary(BaseModel):
    run_id: str
    started_at: datetime
    finished_at: Optional[datetime] = None
    status: str = "running"  # running | completed | failed
    duration_ms: int = 0

    # Aggregate counts
    total_sources: int = 0
    total_urls_discovered: int = 0
    total_pages_fetched: int = 0
    total_events_parsed: int = 0
    total_events_stored: int = 0
    total_events_filtered_past: int = 0
    total_events_deduped: int = 0
    total_errors: int = 0

    # Per-source breakdown
    source_results: list[SourceResult] = []

    # Small sample of stored events (for response body)
    sample_events: list[dict[str, Any]] = []

    def add_source(self, result: SourceResult) -> None:
        self.source_results.append(result)
        self.total_sources += 1
        self.total_urls_discovered += result.urls_discovered
        self.total_pages_fetched += result.pages_fetched
        self.total_events_parsed += result.events_parsed
        self.total_events_stored += result.events_stored
        self.total_events_filtered_past += result.events_filtered_past
        self.total_events_deduped += result.events_deduped
        self.total_errors += len(result.errors)
