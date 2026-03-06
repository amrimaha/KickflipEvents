"""
Build the system prompt for POST /chat.

Accepts a list of raw DB dicts (from fetch_upcoming_events_for_chat) and
formats them into a concise event catalog for the LLM system prompt.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _format_event_line(row: dict) -> str:
    dt = row.get("start_time")
    if isinstance(dt, datetime):
        day_label = f"{dt.strftime('%A')}, {_MONTH_NAMES[dt.month - 1]} {dt.day}"
        time_str = dt.strftime("%I:%M %p").lstrip("0") or dt.strftime("%I:%M %p")
        date_iso = dt.date().isoformat()
    else:
        day_label = str(dt) if dt else "TBD"
        time_str = ""
        date_iso = str(dt) if dt else ""

    categories: list = []
    raw_cats = row.get("categories")
    if raw_cats:
        try:
            categories = json.loads(raw_cats) if isinstance(raw_cats, str) else list(raw_cats)
        except Exception:
            pass
    category = categories[0] if categories else "general"

    desc = row.get("event_summary") or row.get("description") or ""
    if len(desc) > 150:
        desc = desc[:147] + "..."

    price = row.get("price") or ("Free" if row.get("is_free") else "?")
    venue = row.get("venue") or row.get("city") or ""
    source_url = row.get("ticket_url") or row.get("source_url") or ""

    event_id = str(row.get("id", ""))[:8]

    return (
        f"[{event_id}] {row.get('title', 'Untitled')} | "
        f"{day_label} {time_str} | {venue} | {category} | {price} | "
        f"{desc} | {source_url}"
    )


def build_system_prompt(events: list[dict]) -> str:
    """
    Return the full system prompt string for the /chat LLM call.

    The prompt embeds the event catalog and instructs the model to output
    an EVENTS_JSON block that the endpoint parses and sends as a typed SSE event.
    """
    catalog_lines = [_format_event_line(e) for e in events]
    catalog = "\n".join(catalog_lines) if catalog_lines else "(No upcoming events in the catalog)"

    return f"""You are Kickflip, a friendly and knowledgeable Seattle events assistant. \
You help people discover fun things to do in Seattle.

You have access to a live catalog of upcoming Seattle events. Use it to answer questions and make recommendations.

UPCOMING EVENTS CATALOG:
{catalog}

RESPONSE GUIDELINES:
- Be conversational, warm, and enthusiastic about Seattle's event scene.
- When recommending events, pick 2-5 that best match the user's request.
- Briefly describe why each recommendation fits.
- After your text response, output a machine-readable block so the UI can render event cards:

EVENTS_JSON: [
  {{
    "id": "<first 8 chars of event id>",
    "name": "<event title>",
    "dateISO": "<YYYY-MM-DD>",
    "dayLabel": "<e.g. Saturday, March 8>",
    "time": "<e.g. 7:30 PM>",
    "venue": "<venue name or city>",
    "price": "<price text or Free>",
    "category": "<category>",
    "description": "<1-2 sentence description>",
    "sourceUrl": "<ticket or event URL>"
  }}
]

IMPORTANT:
- Only include events from the catalog above. Never make up events.
- If no events match, say so politely and suggest broadening the search.
- Keep your text response concise (under 200 words before EVENTS_JSON).
- Always output EVENTS_JSON, even for a single event (as a one-item array).
- If truly no events fit at all, output EVENTS_JSON: []"""
