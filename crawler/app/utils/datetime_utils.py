"""
Timezone-aware datetime parsing utilities.

Strategy (in order):
  1. ISO 8601 direct parse via stdlib / dateutil
  2. dateparser with PREFER_DATES_FROM=future + configured TZ
  3. Regex patterns for US date strings
  4. Return None if unparseable

All returned datetimes are timezone-aware (localized to configured_tz if naive).
"""
from __future__ import annotations

import re
from datetime import datetime, time as dt_time
from typing import Optional, Tuple

import dateparser
import pytz
from dateutil import parser as dateutil_parser

# Month names for regex
_MONTHS = (
    "January|February|March|April|May|June|"
    "July|August|September|October|November|December"
)
_MONTHS_SHORT = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"

# Patterns ordered by specificity
_DATE_RES: list[re.Pattern] = [
    # ISO 8601 with offset: 2025-03-15T19:00:00-07:00
    re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?"),
    # 2025-03-15
    re.compile(r"\d{4}-\d{2}-\d{2}"),
    # March 15, 2025  /  March 15th, 2025
    re.compile(rf"(?:{_MONTHS})\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}", re.I),
    # 15 March 2025
    re.compile(rf"\d{{1,2}}\s+(?:{_MONTHS})\s+\d{{4}}", re.I),
    # Mar 15, 2025
    re.compile(rf"(?:{_MONTHS_SHORT})\.?\s+\d{{1,2}},?\s+\d{{4}}", re.I),
    # 3/15/2025  or  03/15/25
    re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b"),
]

_TIME_RES: list[re.Pattern] = [
    # 7:00 PM | 19:00 | 7pm
    re.compile(r"\b\d{1,2}:\d{2}\s*(?:AM|PM)\b", re.I),
    re.compile(r"\b\d{1,2}\s*(?:AM|PM)\b", re.I),
    re.compile(r"\b\d{2}:\d{2}\b"),
]


def _local_tz(tz_name: str) -> pytz.BaseTzInfo:
    try:
        return pytz.timezone(tz_name)
    except Exception:
        return pytz.UTC


def _localize(dt: datetime, tz: pytz.BaseTzInfo) -> datetime:
    """Attach timezone if naive."""
    if dt.tzinfo is None:
        return tz.localize(dt)
    return dt


def parse_datetime(
    raw: str,
    tz_name: str = "America/Los_Angeles",
) -> Optional[datetime]:
    """
    Parse a raw date/time string and return a tz-aware datetime.
    Returns None if unparseable.
    """
    if not raw or not raw.strip():
        return None

    raw = raw.strip()
    tz = _local_tz(tz_name)

    # 1. Try stdlib ISO parse first (fast)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(raw[:len(fmt) + 6], fmt)
            return _localize(dt, tz)
        except ValueError:
            pass

    # 2. dateparser (handles natural language + many formats)
    dp_settings = {
        "PREFER_DATES_FROM": "future",
        "RETURN_AS_TIMEZONE_AWARE": True,
        "PREFER_DAY_OF_MONTH": "first",
        "TIMEZONE": tz_name,
        "TO_TIMEZONE": tz_name,
    }
    parsed = dateparser.parse(raw, settings=dp_settings)
    if parsed:
        return _localize(parsed, tz) if parsed.tzinfo is None else parsed

    # 3. dateutil fuzzy
    try:
        dt = dateutil_parser.parse(raw, fuzzy=True)
        return _localize(dt, tz)
    except Exception:
        pass

    return None


def parse_date_only(raw: str, tz_name: str = "America/Los_Angeles") -> Optional[datetime]:
    """Parse a date-only string; if found, return midnight in configured TZ."""
    parsed = parse_datetime(raw, tz_name)
    if parsed is None:
        return None
    tz = _local_tz(tz_name)
    midnight = datetime.combine(parsed.date(), dt_time.min)
    return tz.localize(midnight) if midnight.tzinfo is None else midnight


def extract_date_from_text(text: str) -> Optional[str]:
    """
    Scan text for the first date-like substring and return it as a string
    (to be passed through parse_datetime).
    """
    for pattern in _DATE_RES:
        m = pattern.search(text)
        if m:
            return m.group(0)
    return None


def extract_time_from_text(text: str) -> Optional[str]:
    """Return first time-like substring found in text."""
    for pattern in _TIME_RES:
        m = pattern.search(text)
        if m:
            return m.group(0)
    return None


def combine_date_time_strings(
    date_str: str,
    time_str: Optional[str],
    tz_name: str = "America/Los_Angeles",
) -> Optional[datetime]:
    """Combine separate date and time strings into a tz-aware datetime."""
    combined = f"{date_str} {time_str}" if time_str else date_str
    return parse_datetime(combined, tz_name)


def is_future(dt: datetime, tz_name: str = "America/Los_Angeles") -> bool:
    """
    Return True if dt is in the future (or still happening today).

    Date-only events are stored with time=midnight (00:00:00). Comparing
    midnight strictly against the current time would incorrectly drop events
    happening later the same day. When time is exactly midnight we compare
    the date component only, so an event dated today at 00:00 is kept until
    the calendar day is over.
    """
    tz = _local_tz(tz_name)
    now = datetime.now(tz)
    if dt.tzinfo is None:
        dt = tz.localize(dt)
    # Date-only (no time given): keep if the event date >= today
    if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
        return dt.date() >= now.date()
    return dt > now


def format_dt_display(dt: Optional[datetime]) -> str:
    """Human-readable format for summaries: 'Sat Mar 15, 2025 7:00 PM'.

    Uses explicit int formatting instead of %-d/%-I (Linux-only strftime flags
    that raise ValueError on Windows).
    """
    if dt is None:
        return ""
    day = dt.day                          # no zero-padding, cross-platform
    hour = dt.hour % 12 or 12            # 12-hour clock
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt.strftime('%a %b')} {day}, {dt.year} {hour}:{dt.minute:02d} {ampm}"


def to_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.isoformat()


def parse_range(raw: str, tz_name: str = "America/Los_Angeles") -> Tuple[Optional[datetime], Optional[datetime]]:
    """
    Try to parse a date range string like "March 15 – 17, 2025" or
    "March 15, 7PM – 9PM".
    Returns (start, end).
    """
    # Split on common range separators
    for sep in ("–", "—", "-", "to", "until"):
        if sep in raw:
            parts = raw.split(sep, 1)
            start = parse_datetime(parts[0].strip(), tz_name)
            end = parse_datetime(parts[1].strip(), tz_name)
            if start:
                return start, end
    return parse_datetime(raw, tz_name), None
