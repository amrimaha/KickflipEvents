"""
Rule-based natural language → ConstraintSet parser.

Extracts from a free-text query:
  - date_from / date_to  from temporal phrases (tonight, this weekend, …)
  - is_free              from "free" mentions
  - intent               stripped query text sent to the embedding model
  - date_label           human-readable date description for the response

All dates are expressed in Pacific time (America/Los_Angeles) to match
the Seattle-focused event corpus, then converted to UTC for DB queries.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import pytz

_PACIFIC = pytz.timezone("America/Los_Angeles")


# ── ConstraintSet ─────────────────────────────────────────────────────────────

@dataclass
class ConstraintSet:
    date_from:      Optional[datetime] = None
    date_to:        Optional[datetime] = None
    is_free:        Optional[bool]     = None
    intent:         str                = ""   # cleaned text for embedding
    original_query: str                = ""
    date_label:     str                = ""   # e.g. "this weekend"


# ── Date helpers ──────────────────────────────────────────────────────────────

def _pacific_today() -> date:
    return datetime.now(_PACIFIC).date()


def _start_of_day(d: date) -> datetime:
    """Midnight Pacific → UTC."""
    return _PACIFIC.localize(datetime(d.year, d.month, d.day, 0, 0, 0)).astimezone(timezone.utc)


def _end_of_day(d: date) -> datetime:
    """23:59:59 Pacific → UTC."""
    return _PACIFIC.localize(datetime(d.year, d.month, d.day, 23, 59, 59)).astimezone(timezone.utc)


def _next_weekday(ref: date, weekday: int) -> date:
    """
    Next occurrence of *weekday* (0=Mon … 6=Sun) strictly after *ref*.
    (If *ref* is already that weekday we advance a full week.)
    """
    days_ahead = weekday - ref.weekday()
    if days_ahead <= 0:
        days_ahead += 7
    return ref + timedelta(days=days_ahead)


# ── Patterns ──────────────────────────────────────────────────────────────────

_WEEKDAY_MAP: dict[str, int] = {
    "monday": 0,   "tuesday": 1,  "wednesday": 2, "thursday": 3,
    "friday": 4,   "saturday": 5, "sunday": 6,
    "mon": 0,      "tue": 1,      "wed": 2,       "thu": 3,
    "fri": 4,      "sat": 5,      "sun": 6,
}

# Ordered longest-match first so "next weekend" beats "weekend"
_DATE_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bthis\s+weekend\b",  re.I), "this_weekend"),
    (re.compile(r"\bnext\s+weekend\b",  re.I), "next_weekend"),
    (re.compile(r"\bthis\s+week\b",     re.I), "this_week"),
    (re.compile(r"\bnext\s+week\b",     re.I), "next_week"),
    (re.compile(r"\btonight\b",         re.I), "today"),
    (re.compile(r"\btoday\b",           re.I), "today"),
    (re.compile(r"\btomorrow\b",        re.I), "tomorrow"),
    (re.compile(
        r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday"
        r"|mon|tue|wed|thu|fri|sat|sun)\b",
        re.I,
    ), "weekday"),
]

_FREE_PAT = re.compile(
    r"\b(free|no[\s\-]charge|complimentary|free\s+admission|free\s+entry|free\s+event)\b",
    re.I,
)

# Patterns to strip from the query before embedding
_STRIP_PATS: list[re.Pattern] = [
    re.compile(r"\bthis\s+weekend\b",  re.I),
    re.compile(r"\bnext\s+weekend\b",  re.I),
    re.compile(r"\bthis\s+week\b",     re.I),
    re.compile(r"\bnext\s+week\b",     re.I),
    re.compile(r"\btonight\b",         re.I),
    re.compile(r"\btoday\b",           re.I),
    re.compile(r"\btomorrow\b",        re.I),
    re.compile(
        r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday"
        r"|mon|tue|wed|thu|fri|sat|sun)\b",
        re.I,
    ),
    re.compile(r"\bfree\b",             re.I),
    re.compile(r"\bno[\s\-]charge\b",   re.I),
    re.compile(r"\bcomplimentary\b",    re.I),
    re.compile(r"\bfree\s+admission\b", re.I),
    re.compile(r"\bfree\s+entry\b",     re.I),
    re.compile(r"\bfree\s+event\b",     re.I),
    re.compile(r"\bevents?\b",          re.I),
    re.compile(r"\bactivit(?:y|ies)\b", re.I),
    re.compile(r"\bin\s+seattle\b",     re.I),
    re.compile(r"\bseattle\b",          re.I),
    re.compile(r"\bgoing\s+on\b",       re.I),
    re.compile(r"\bwhat(?:'s|s)?\b",    re.I),
    re.compile(r"\bthere\b",            re.I),
]


# ── Public function ───────────────────────────────────────────────────────────

def parse_query(query: str) -> ConstraintSet:
    """Parse a natural-language event query into a ConstraintSet."""
    cs = ConstraintSet(original_query=query)
    today = _pacific_today()

    # ── Date detection ────────────────────────────────────────────────────────
    matched_key: Optional[str] = None
    matched_weekday_str: Optional[str] = None

    for pattern, key in _DATE_RULES:
        m = pattern.search(query)
        if m:
            matched_key = key
            if key == "weekday":
                matched_weekday_str = m.group(0).lower()
            break

    if matched_key == "today":
        cs.date_from  = _start_of_day(today)
        cs.date_to    = _end_of_day(today)
        cs.date_label = "today"

    elif matched_key == "tomorrow":
        d = today + timedelta(days=1)
        cs.date_from  = _start_of_day(d)
        cs.date_to    = _end_of_day(d)
        cs.date_label = "tomorrow"

    elif matched_key == "this_weekend":
        sat = _next_weekday(today, 5)
        sun = sat + timedelta(days=1)
        cs.date_from  = _start_of_day(sat)
        cs.date_to    = _end_of_day(sun)
        cs.date_label = "this weekend"

    elif matched_key == "next_weekend":
        sat = _next_weekday(today, 5) + timedelta(days=7)
        sun = sat + timedelta(days=1)
        cs.date_from  = _start_of_day(sat)
        cs.date_to    = _end_of_day(sun)
        cs.date_label = "next weekend"

    elif matched_key == "this_week":
        monday = today - timedelta(days=today.weekday())
        sunday = monday + timedelta(days=6)
        cs.date_from  = _start_of_day(max(today, monday))
        cs.date_to    = _end_of_day(sunday)
        cs.date_label = "this week"

    elif matched_key == "next_week":
        monday = today - timedelta(days=today.weekday()) + timedelta(days=7)
        sunday = monday + timedelta(days=6)
        cs.date_from  = _start_of_day(monday)
        cs.date_to    = _end_of_day(sunday)
        cs.date_label = "next week"

    elif matched_key == "weekday" and matched_weekday_str:
        wd_num = _WEEKDAY_MAP[matched_weekday_str]
        target = _next_weekday(today, wd_num)
        cs.date_from  = _start_of_day(target)
        cs.date_to    = _end_of_day(target)
        cs.date_label = target.strftime("%A, %B %d").replace(" 0", " ")

    else:
        # No temporal phrase → default to next 30 days
        cs.date_from  = _start_of_day(today)
        cs.date_to    = _end_of_day(today + timedelta(days=30))
        cs.date_label = "next 30 days"

    # ── Free detection ────────────────────────────────────────────────────────
    if _FREE_PAT.search(query):
        cs.is_free = True

    # ── Build intent for embedding ────────────────────────────────────────────
    intent = query
    for pat in _STRIP_PATS:
        intent = pat.sub(" ", intent)
    intent = re.sub(r"\s+", " ", intent).strip(" ,.-?!")
    cs.intent = intent if intent else query

    return cs
