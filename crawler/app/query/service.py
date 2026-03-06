"""
Search service — orchestrates the full parse → retrieve → respond pipeline.

Usage::

    from app.query.service import search, SearchResponse

    result: SearchResponse = await search("free jazz concerts this weekend", pool)
    print(result.response_text)
    for event in result.events:
        print(event["title"], event["start_time"])
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import asyncpg

from app.config import settings
from app.query.parser import ConstraintSet, parse_query
from app.query.responder import format_response
from app.query.retrieval import retrieve_events


# ── Response model ────────────────────────────────────────────────────────────

@dataclass
class SearchResponse:
    query:            str
    response_text:    str
    events:           list[dict]
    constraints:      dict
    retrieval_method: str
    timing_ms:        dict = field(default_factory=dict)
    total_candidates: int  = 0   # how many events matched before slicing


# ── Category normalisation ────────────────────────────────────────────────────

# Recognised values the UI renders as primary category chips.
# Any extra tags become vibeTags.  Recognised values are always sorted first.
_RECOGNISED_CATEGORIES = {
    "music", "food", "art", "outdoor", "party",
    "wellness", "fashion", "sports", "comedy",
}


def _normalise_categories(raw: Any) -> list[str]:
    """
    Return a list of lowercase category strings with recognised values first.

    Handles all storage formats:  list, JSON string, plain string, or None.
    """
    import json as _json

    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except Exception:
            raw = [raw]
    if not isinstance(raw, list):
        raw = [raw]

    cats = [str(c).lower().strip() for c in raw if c and str(c).strip()]
    recognised = [c for c in cats if c in _RECOGNISED_CATEGORIES]
    other      = [c for c in cats if c not in _RECOGNISED_CATEGORIES]
    return recognised + other


# ── Event serialisation ───────────────────────────────────────────────────────

def _serialise_event(e: dict) -> dict:
    """
    Convert an asyncpg row dict to the shape required by ParserSearchEvent.

    Guarantees:
      - id          → string
      - start_time  → ISO 8601 string
      - is_free     → bool (never None)
      - venue/city  → string (never None)
      - categories  → string[] with recognised values first
    """
    out: dict[str, Any] = {}
    for k, v in e.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, float) and k == "similarity":
            out[k] = round(v, 4)
        else:
            out[k] = v

    # ── Required field coercions ──────────────────────────────────────────────
    out["id"]         = str(out.get("id", ""))
    out["is_free"]    = bool(out.get("is_free") or False)
    out["venue"]      = out.get("venue") or ""
    out["city"]       = out.get("city") or "Seattle"
    out["categories"] = _normalise_categories(out.get("categories"))

    return out


# ── Pipeline ──────────────────────────────────────────────────────────────────

async def search(query: str, pool: asyncpg.Pool) -> SearchResponse:
    """
    Full search pipeline:
      1. parse_query  → ConstraintSet
      2. retrieve_events → ranked event list
      3. format_response → natural-language answer

    Per-stage timings (ms) are recorded in SearchResponse.timing_ms.
    """
    t0 = time.monotonic()

    # 1. Parse
    cs: ConstraintSet = parse_query(query)
    t1 = time.monotonic()

    # 2. Retrieve
    all_events, method = await retrieve_events(cs, pool)
    t2 = time.monotonic()

    # Slice to the display limit before passing to LLM
    display_events = all_events[: settings.search_result_limit]

    # 3. Format
    response_text = await format_response(display_events, cs)
    t3 = time.monotonic()

    def _ms(a: float, b: float) -> int:
        return int((b - a) * 1000)

    constraints_dict = {
        "date_from":  cs.date_from.isoformat() if cs.date_from else None,
        "date_to":    cs.date_to.isoformat()   if cs.date_to   else None,
        "is_free":    cs.is_free,
        "date_label": cs.date_label,
        "intent":     cs.intent,
    }

    return SearchResponse(
        query=query,
        response_text=response_text,
        events=[_serialise_event(e) for e in display_events],
        constraints=constraints_dict,
        retrieval_method=method,
        timing_ms={
            "parse":    _ms(t0, t1),
            "retrieve": _ms(t1, t2),
            "respond":  _ms(t2, t3),
            "total":    _ms(t0, t3),
        },
        total_candidates=len(all_events),
    )
