"""
Normalizer — converts RawEventData → NormalizedEvent.

Steps:
  1. Parse & localize datetimes
  2. Filter past events (start_datetime <= now)
  3. Canonicalize URLs
  4. Deduplicate via stable ID
  5. Fill city/state defaults for Seattle-scoped sources
  6. Generate summaries + tags
  7. Compute confidence
  8. Validate with Pydantic
"""
from __future__ import annotations

import re
import time
from datetime import datetime
from typing import Optional

# ── Comma-cleanup patterns ────────────────────────────────────────────────────
# Removes stray leading/trailing comma sequences and collapses mid-string
# comma runs (≥ 2 consecutive commas) into a single comma.
# Seen on Showbox Presents: ", , The Showbox, addr , , , Showbox SoDo, addr ,"
_LEADING_COMMA = re.compile(r"^[\s,]+")
_TRAILING_COMMA = re.compile(r"[\s,]+$")
_MULTI_COMMA    = re.compile(r"(\s*,\s*){2,}")

# ── Price-rejection patterns ──────────────────────────────────────────────────
# Heuristics sometimes captures social-media handles (@artist) near the price
# block.  Reject any price that is purely a social-media handle.
_SOCIAL_HANDLE = re.compile(r"^@\w+", re.ASCII)

from app.config import settings
from app.models.event import (
    ExtractionMethod,
    NormalizedEvent,
    RawEventData,
    make_event_id,
    make_fallback_id,
)
from app.parsers.summarizer import (
    generate_summary_long,
    generate_summary_short,
    generate_tags,
)
from app.utils.datetime_utils import is_future, parse_datetime, to_iso
from app.utils.logger import BoundLogger
from app.utils.text_utils import normalize_text, truncate
from app.utils.url_utils import canonicalize_url

log = BoundLogger("kickflip.normalizer")


def _confidence(
    raw: RawEventData,
    method: ExtractionMethod,
    start_dt: Optional[datetime],
) -> float:
    """Heuristic confidence score based on extraction method + fields present."""
    base = {
        ExtractionMethod.jsonld: 0.90,
        ExtractionMethod.microdata: 0.80,
        ExtractionMethod.site_profile: 0.80,
        ExtractionMethod.heuristics: 0.50,
        ExtractionMethod.llm_fallback: 0.70,
    }.get(method, 0.50)

    bonus = 0.0
    if start_dt:
        bonus += 0.05
    if raw.venue_name:
        bonus += 0.03
    if raw.price_text:
        bonus += 0.02
    if raw.description:
        bonus += 0.02
    if raw.image_url:
        bonus += 0.01

    penalty = 0.0
    if not raw.title:
        penalty += 0.20
    if not start_dt:
        penalty += 0.15

    return round(min(1.0, max(0.0, base + bonus - penalty)), 3)


def _clean_str(val: Optional[str]) -> Optional[str]:
    if not val or not val.strip():
        return None
    return normalize_text(val)


def _clean_commas(val: Optional[str]) -> Optional[str]:
    """
    Strip leading/trailing comma-space junk and collapse comma runs.
    Safe to call on any string; returns None when only garbage remains.
    """
    if not val:
        return val
    v = _LEADING_COMMA.sub("", val)
    v = _TRAILING_COMMA.sub("", v)
    v = _MULTI_COMMA.sub(", ", v)
    return v.strip() or None


def _clean_price(val: Optional[str]) -> Optional[str]:
    """
    Normalise price text, and reject values that are social-media handles
    (e.g. '@bandofhorses') mis-extracted by the heuristics parser.
    """
    cleaned = _clean_str(val)
    if cleaned and _SOCIAL_HANDLE.match(cleaned):
        return None
    return cleaned


def normalize(
    raw: RawEventData,
    method: ExtractionMethod,
    source_name: str,
    source_url: str,
    page_url: str,
    tz_name: str,
    seattle_scoped: bool = False,
    run_time: Optional[datetime] = None,
) -> Optional[NormalizedEvent]:
    """
    Convert RawEventData → NormalizedEvent.
    Returns None if the event is in the past, lacks a title, or lacks a start date.
    """
    now = run_time or datetime.now()

    # ── Title ─────────────────────────────────────────────────────────────────
    title = _clean_str(raw.title)
    if not title:
        log.debug("Skipping: no title", url=page_url, stage="normalize")
        return None

    # ── Start datetime ────────────────────────────────────────────────────────
    start_dt: Optional[datetime] = None
    if raw.start_datetime_raw:
        start_dt = parse_datetime(raw.start_datetime_raw, tz_name)

    if start_dt is None:
        log.debug("Skipping: unparseable start_datetime", url=page_url, stage="normalize")
        return None

    # ── Filter past events ────────────────────────────────────────────────────
    if not is_future(start_dt, tz_name):
        log.debug(
            "Filtered: past event",
            url=page_url,
            stage="filter_future",
            extra={"start_dt": to_iso(start_dt)},
        )
        return None

    # ── End datetime ──────────────────────────────────────────────────────────
    end_dt: Optional[datetime] = None
    if raw.end_datetime_raw:
        end_dt = parse_datetime(raw.end_datetime_raw, tz_name)
    if end_dt is None:
        end_dt = start_dt  # use start time as end time when not published

    # ── URLs ──────────────────────────────────────────────────────────────────
    event_url = canonicalize_url(raw.event_url or page_url, base=page_url)
    ticket_url = canonicalize_url(raw.ticket_url, base=page_url) if raw.ticket_url else None
    image_url = canonicalize_url(raw.image_url, base=page_url) if raw.image_url else None

    # ── Location defaults (Seattle-scoped sources) ─────────────────────────────
    city = _clean_str(raw.city)
    state = _clean_str(raw.state)
    if seattle_scoped:
        city = city or "Seattle"
        state = state or "WA"

    # ── ID ────────────────────────────────────────────────────────────────────
    event_id = make_event_id(source_name, event_url)

    # ── Clean fields with known parser artefacts ──────────────────────────────
    # venue_name: strip leading/trailing comma junk (multi-venue concatenation)
    venue_clean = _clean_str(_clean_commas(raw.venue_name))
    # price_text: reject social-media handles captured near the price block
    price_clean = _clean_price(raw.price_text)

    # ── Summaries & tags ──────────────────────────────────────────────────────
    summary_short = generate_summary_short(title, start_dt, venue_clean, price_clean)
    summary_long = generate_summary_long(
        title=title,
        start_dt=start_dt,
        end_dt=end_dt,
        venue_name=venue_clean,
        address=raw.address,
        city=city,
        state=state,
        price_text=price_clean,
        description=raw.description,
    )
    tags = generate_tags(
        title=title,
        description=raw.description,
        category=raw.category,
        categories_raw=raw.categories_raw,
        price_text=raw.price_text,
    )

    # Merge any tags already on the raw
    for t in raw.tags:
        if t and t not in tags:
            tags.append(t)

    # ── Confidence ───────────────────────────────────────────────────────────
    confidence = _confidence(raw, method, start_dt)

    # ── Extra JSONB payload ───────────────────────────────────────────────────
    raw_data: dict = {}
    if raw.organizer:
        raw_data["organizer"] = raw.organizer
    if raw.performers:
        raw_data["performers"] = raw.performers
    if raw.event_format:
        raw_data["event_format"] = raw.event_format
    if raw.recurrence:
        raw_data["recurrence"] = raw.recurrence
    if raw.age_restriction:
        raw_data["age_restriction"] = raw.age_restriction
    if raw.registration_required is not None:
        raw_data["registration_required"] = raw.registration_required
    if raw.accessibility:
        raw_data["accessibility"] = raw.accessibility
    if raw.social_links:
        raw_data["social_links"] = raw.social_links
    if raw.categories_raw:
        raw_data["categories_raw"] = raw.categories_raw
    if raw.description_full and raw.description_full != raw.description:
        raw_data["description_full"] = truncate(raw.description_full, 5000)

    ts = run_time or datetime.utcnow()

    try:
        event = NormalizedEvent(
            id=event_id,
            title=title,
            start_datetime=start_dt,
            end_datetime=end_dt,
            venue_name=venue_clean,
            address=_clean_str(raw.address),
            city=city,
            state=state,
            price_text=price_clean,
            ticket_url=ticket_url,
            event_url=event_url,
            image_url=image_url,
            image_source=raw.image_source,
            source_name=source_name,
            source_url=source_url,
            tags=tags,
            summary_short=summary_short,
            summary_long=summary_long,
            confidence=confidence,
            extraction_method=method,
            evidence_snippets=raw.evidence_snippets[:10],
            raw_data=raw_data or None,
            last_seen_at=ts,
        )
        return event
    except Exception as exc:
        log.warning(f"Pydantic validation failed: {exc}", url=page_url, stage="validate")
        return None
