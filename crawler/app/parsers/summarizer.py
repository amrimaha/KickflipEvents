"""
Deterministic (no-LLM) summary and tag generation.

summary_short  ≤ 140 chars — key facts as a single line
summary_long   2–4 lines   — structured detail block

Both are assembled entirely from parsed fields. No hallucination.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.utils.datetime_utils import format_dt_display
from app.utils.text_utils import extract_tags, truncate, normalize_text


def _join(*parts: Optional[str], sep: str = " | ") -> str:
    return sep.join(p for p in parts if p and p.strip())


def generate_summary_short(
    title: Optional[str],
    start_dt: Optional[datetime],
    venue_name: Optional[str],
    price_text: Optional[str],
) -> str:
    """
    Format: "Title | Day Mon D, YYYY H:MM PM | Venue (Price)"
    Truncated to 140 chars.
    """
    parts: list[str] = []

    if title:
        parts.append(normalize_text(title))

    if start_dt:
        parts.append(format_dt_display(start_dt))

    if venue_name:
        parts.append(normalize_text(venue_name))

    if price_text:
        parts.append(f"({normalize_text(price_text)})")

    result = _join(*parts)
    return truncate(result, 140)


def generate_summary_long(
    title: Optional[str],
    start_dt: Optional[datetime],
    end_dt: Optional[datetime],
    venue_name: Optional[str],
    address: Optional[str],
    city: Optional[str],
    state: Optional[str],
    price_text: Optional[str],
    description: Optional[str],
) -> str:
    """
    Multi-line fact block:
      Line 1 — When: <date> [– end]
      Line 2 — Where: <venue>, <address>, <city, state>
      Line 3 — Price: <price>
      Line 4 — <description snippet>

    Only lines with data are included.
    """
    lines: list[str] = []

    # Line 1: When
    when_parts = [format_dt_display(start_dt)]
    if end_dt:
        when_parts.append(f"– {format_dt_display(end_dt)}")
    when_str = " ".join(p for p in when_parts if p)
    if when_str:
        lines.append(f"When: {when_str}")

    # Line 2: Where
    where_parts: list[str] = []
    if venue_name:
        where_parts.append(normalize_text(venue_name))
    if address:
        where_parts.append(normalize_text(address))
    elif city or state:
        loc = ", ".join(p for p in [city, state] if p)
        where_parts.append(loc)
    if where_parts:
        lines.append(f"Where: {', '.join(where_parts)}")

    # Line 3: Price
    if price_text:
        lines.append(f"Price: {normalize_text(price_text)}")

    # Line 4: Description snippet (first 280 chars)
    if description:
        desc = normalize_text(description)
        desc = truncate(desc, 280)
        if desc:
            lines.append(desc)

    if not lines and title:
        lines.append(normalize_text(title))

    return "\n".join(lines)


def generate_tags(
    title: Optional[str],
    description: Optional[str],
    category: Optional[str],
    categories_raw: Optional[list[str]],
    price_text: Optional[str],
    max_tags: int = 8,
) -> list[str]:
    """
    Keyword-based tag extraction from available text fields.
    No LLM needed.
    """
    combined_text = " ".join(
        t for t in [
            title or "",
            description or "",
            category or "",
            " ".join(categories_raw or []),
            price_text or "",
        ] if t
    )

    tags = extract_tags(combined_text, max_tags=max_tags)

    # Ensure "free" tag consistency
    if price_text and "free" in price_text.lower() and "free" not in tags:
        tags.append("free")

    return tags[:max_tags]
