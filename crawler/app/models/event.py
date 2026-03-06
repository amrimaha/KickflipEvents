"""
Event data models.

RawEventData  – intermediate, unvalidated extracted fields.
NormalizedEvent – final, validated, ready-to-store event.
"""
from __future__ import annotations

import hashlib
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


class ExtractionMethod(str, Enum):
    jsonld = "jsonld"
    microdata = "microdata"
    site_profile = "site_profile"
    heuristics = "heuristics"
    llm_fallback = "llm_fallback"


class RawEventData(BaseModel):
    """Intermediate model: fields as extracted before normalization."""
    title: Optional[str] = None
    start_datetime_raw: Optional[str] = None
    end_datetime_raw: Optional[str] = None
    venue_name: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    price_text: Optional[str] = None
    ticket_url: Optional[str] = None
    event_url: Optional[str] = None
    image_url: Optional[str] = None
    image_source: Optional[str] = None  # "og"|"twitter"|"jsonld"|"img_tag"|"unsplash"
    description: Optional[str] = None
    category: Optional[str] = None
    organizer: Optional[str] = None
    tags: list[str] = []
    evidence_snippets: list[str] = []

    # Extra rich fields stored in raw_data JSONB
    performers: list[str] = []
    event_format: Optional[str] = None   # in-person | virtual | hybrid
    recurrence: Optional[str] = None
    age_restriction: Optional[str] = None
    registration_required: Optional[bool] = None
    accessibility: Optional[str] = None
    social_links: list[str] = []
    categories_raw: list[str] = []
    description_full: Optional[str] = None

    def has_minimum_data(self) -> bool:
        return bool(self.title and self.start_datetime_raw)


class NormalizedEvent(BaseModel):
    """Final normalized event, validated and ready for upsert."""

    # ── Identity ──────────────────────────────────────────────────────────────
    id: str = Field(description="Stable SHA-256 hash of (source_name, event_url)")

    # ── Core ──────────────────────────────────────────────────────────────────
    title: str
    start_datetime: datetime             # always tz-aware
    end_datetime: Optional[datetime] = None

    # ── Location ──────────────────────────────────────────────────────────────
    venue_name: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None

    # ── Ticketing ─────────────────────────────────────────────────────────────
    price_text: Optional[str] = None
    ticket_url: Optional[str] = None

    # ── URLs / media ──────────────────────────────────────────────────────────
    event_url: str
    image_url: Optional[str] = None
    image_source: Optional[str] = None  # "og"|"twitter"|"jsonld"|"img_tag"|"unsplash"
    source_name: str
    source_url: str

    # ── Enrichment ────────────────────────────────────────────────────────────
    tags: list[str] = []
    summary_short: str = Field(default="", max_length=140)
    summary_long: str = ""

    # ── Quality ───────────────────────────────────────────────────────────────
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    extraction_method: ExtractionMethod = ExtractionMethod.heuristics
    evidence_snippets: list[str] = []

    # ── Extra JSONB column (future-proofing) ──────────────────────────────────
    raw_data: Optional[dict[str, Any]] = None

    # ── Timestamps ───────────────────────────────────────────────────────────
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None

    @field_validator("summary_short", mode="before")
    @classmethod
    def cap_summary_short(cls, v: str) -> str:
        return (v or "")[:140]

    @field_validator("evidence_snippets", mode="before")
    @classmethod
    def cap_snippets(cls, v: list) -> list:
        return v[:10]  # Keep max 10 snippets


def make_event_id(source_name: str, event_url: str) -> str:
    """Deterministic primary ID: SHA-256(source_name + canonical_event_url)."""
    key = f"{source_name}\x00{event_url}"
    return hashlib.sha256(key.encode()).hexdigest()


def make_fallback_id(title: str, start_iso: str, venue: str) -> str:
    """Fallback ID when event_url is unreliable."""
    key = f"{title}\x00{start_iso}\x00{venue}"
    return hashlib.sha256(key.encode()).hexdigest()


def make_fingerprint(title: str, start_dt: datetime, venue: str) -> str:
    """
    Content-based fingerprint: SHA-256(title + start_datetime_iso + venue).
    Used as the kickflip_events.fingerprint column — allows fuzzy dedup when
    the same event appears at a slightly different URL.
    """
    key = f"{(title or '').strip().lower()}\x00{start_dt.isoformat()}\x00{(venue or '').strip().lower()}"
    return hashlib.sha256(key.encode()).hexdigest()
