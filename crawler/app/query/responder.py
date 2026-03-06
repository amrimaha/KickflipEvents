"""
LLM-powered natural language response formatter for event search results.

If LLM_API_KEY is set and the LLM provider is configured, the matched events
are summarised into a friendly prose answer. Falls back to a plain-text list
when the LLM is unavailable or disabled.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from app.config import settings
from app.query.parser import ConstraintSet
from app.utils.logger import BoundLogger

log = BoundLogger("kickflip.responder")

_SYSTEM_PROMPT = (
    "You are Kickflip, a Seattle events assistant. "
    "Reply in exactly two parts:\n"
    "1. ONE sentence (under 15 words) summarising what you found.\n"
    "2. A markdown bullet list — one line per event, max 6 bullets — using "
    "this format exactly:\n"
    "• **Title** — Day Mon DD, H:MM AM/PM @ Venue — Price\n"
    "Use 'Free' when is_free is true and price is absent. "
    "Never invent details not present in the event list. "
    "If the list is empty, respond with one sentence only and suggest "
    "broadening the search. No extra commentary or filler."
)


# ── Event formatting ──────────────────────────────────────────────────────────

def _fmt_dt(dt) -> str:
    """Format a datetime (or ISO string) for human display."""
    if isinstance(dt, datetime):
        return dt.strftime("%a %b %d, %I:%M %p")
    return str(dt) if dt else "TBD"


def _fmt_event(e: dict) -> str:
    """Format one event row as a readable text block for the LLM context."""
    price = e.get("price") or ("Free" if e.get("is_free") else "See website")

    cats = e.get("categories") or []
    if isinstance(cats, str):
        try:
            cats = json.loads(cats)
        except Exception:
            cats = [cats]

    lines = [
        f"Title: {e.get('title', 'Unknown')}",
        f"Date:  {_fmt_dt(e.get('start_time'))}",
        f"Venue: {e.get('venue') or e.get('city') or 'TBD'}",
        f"Price: {price}",
    ]
    if e.get("event_summary"):
        lines.append(f"About: {e['event_summary']}")
    if cats:
        lines.append(f"Tags:  {', '.join(str(c) for c in cats[:5])}")
    url = e.get("source_url") or e.get("ticket_url") or ""
    if url:
        lines.append(f"URL:   {url}")

    return "\n".join(lines)


def _build_context(events: list[dict], cs: ConstraintSet) -> str:
    if not events:
        return "No matching events found."
    blocks = [_fmt_event(e) for e in events]
    header = f"Events matching your search ({cs.date_label}):\n\n"
    return header + "\n\n---\n\n".join(blocks)


# ── Plain-text fallback ───────────────────────────────────────────────────────

def _plain_fallback(events: list[dict], cs: ConstraintSet) -> str:
    if not events:
        return (
            f"No events found for {cs.date_label}. "
            "Try broadening your date range or removing the free filter."
        )
    lines = [f"Found {len(events)} event(s) for {cs.date_label}:\n"]
    for e in events:
        start_str = _fmt_dt(e.get("start_time"))
        venue     = e.get("venue") or e.get("city") or "TBD"
        price     = e.get("price") or ("Free" if e.get("is_free") else "")
        line      = f"• **{e.get('title', 'Event')}** — {start_str} @ {venue}"
        if price:
            line += f" — {price}"
        lines.append(line)
    return "\n".join(lines)


# ── Public function ───────────────────────────────────────────────────────────

async def format_response(events: list[dict], cs: ConstraintSet) -> str:
    """
    Use the configured LLM to write a natural-language answer.
    Falls back to _plain_fallback() when the LLM is unavailable.
    """
    api_key: Optional[str] = settings.llm_api_key
    if not api_key:
        return _plain_fallback(events, cs)

    try:
        from app.utils.llm_client import LLMClient

        client = LLMClient(
            provider=settings.llm_provider,
            model=settings.llm_model,
            api_key=api_key,
        )
        context  = _build_context(events[:settings.search_result_limit], cs)
        user_msg = f"User query: {cs.original_query}\n\n{context}"

        text = await client.complete(
            system=_SYSTEM_PROMPT,
            user=user_msg,
            max_tokens=settings.search_llm_max_tokens,
        )
        if text:
            return text
    except Exception as exc:
        log.warning(f"LLM response formatting failed: {exc}")

    return _plain_fallback(events, cs)
