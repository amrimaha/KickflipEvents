"""
LLM fallback extractor — DISABLED BY DEFAULT.

Guards:
  - ENABLE_LLM_FALLBACK must be true
  - Only invoked when heuristic confidence < settings.llm_confidence_threshold
  - Per-run call counter caps at settings.llm_max_calls_per_run
  - Sends ONLY cleaned main text (≤ 3 000 chars) — never raw HTML
  - Must return strict JSON; invalid or low-confidence response is discarded

Provider is configured via LLM_PROVIDER / LLM_MODEL / LLM_API_KEY env vars.
Switch providers without any code changes.
"""
from __future__ import annotations

import json
from typing import Optional

from app.models.event import RawEventData
from app.utils.llm_client import LLMClient
from app.utils.logger import BoundLogger
from app.utils.text_utils import normalize_text, clean_whitespace

log = BoundLogger("kickflip.parser.llm")

_SYSTEM_PROMPT = """\
You are a structured data extractor for event websites.
Extract event information and return ONLY valid JSON — no markdown fences, no commentary.

Required JSON shape (use null for missing fields):
{
  "title": string | null,
  "start_datetime": "ISO8601 string" | null,
  "end_datetime":   "ISO8601 string" | null,
  "venue_name":     string | null,
  "address":        string | null,
  "city":           string | null,
  "state":          string | null,
  "price_text":     string | null,
  "description":    string | null,
  "organizer":      string | null,
  "event_format":   "in-person" | "virtual" | "hybrid" | null,
  "confidence":     float between 0.0 and 1.0
}

Rules:
- NEVER invent or hallucinate facts.
- Use null rather than guessing.
- confidence = how certain you are the data is correct and complete.
"""

_MAX_TEXT_CHARS = 3_000


def _extract_main_text(html: str) -> str:
    """Use trafilatura to extract main text from HTML."""
    try:
        import trafilatura
        text = trafilatura.extract(html, include_comments=False, include_tables=False)
        if text:
            return clean_whitespace(text[:_MAX_TEXT_CHARS])
    except Exception:
        pass

    import re
    text = re.sub(r"<[^>]+>", " ", html)
    return clean_whitespace(text[:_MAX_TEXT_CHARS])


async def extract_event(
    html: str,
    page_url: str,
    llm_client: LLMClient,
    call_counter: list,      # [current_count] — mutated in-place
    max_calls: int,
) -> Optional[RawEventData]:
    """
    Extract event data via LLM.

    Args:
        html:          Rendered HTML of the event page.
        page_url:      Canonical URL of the page.
        llm_client:    Configured LLMClient (provider-agnostic).
        call_counter:  Single-element list tracking calls this run; mutated.
        max_calls:     Hard cap for this run.

    Returns:
        RawEventData if extraction succeeds and confidence >= 0.4, else None.
    """
    if call_counter[0] >= max_calls:
        log.warning(
            f"LLM call cap ({max_calls}) reached for this run, skipping",
            url=page_url,
            stage="parse",
        )
        return None

    text = _extract_main_text(html)
    if not text:
        log.warning("No text extracted for LLM", url=page_url)
        return None

    log.info(
        "LLM fallback invoked",
        url=page_url,
        stage="parse",
        extra={
            "call_n": call_counter[0] + 1,
            "cap": max_calls,
            "text_len": len(text),
            "provider": llm_client.provider,
            "model": llm_client.model,
        },
    )

    call_counter[0] += 1
    raw_text = await llm_client.complete(
        system=_SYSTEM_PROMPT,
        user=f"Extract event data from this page text:\n\n{text}",
        max_tokens=512,
    )

    if not raw_text:
        return None

    # ── Parse JSON ────────────────────────────────────────────────────────────
    try:
        clean = raw_text.strip()
        # Strip any accidental markdown fences
        if clean.startswith("```"):
            lines = clean.split("\n")
            clean = "\n".join(lines[1:] if len(lines) > 1 else lines)
        if clean.endswith("```"):
            lines = clean.split("\n")
            clean = "\n".join(lines[:-1])
        data = json.loads(clean.strip())
    except (json.JSONDecodeError, Exception) as exc:
        log.warning(f"LLM returned non-JSON response: {exc}", url=page_url)
        return None

    # ── Validate minimum fields ───────────────────────────────────────────────
    if not (data.get("title") or data.get("start_datetime")):
        log.warning("LLM response missing both title and start_datetime, discarding", url=page_url)
        return None

    confidence = float(data.get("confidence") or 0.5)
    if confidence < 0.4:
        log.warning(
            f"LLM confidence {confidence:.2f} below 0.4, discarding",
            url=page_url,
        )
        return None

    # ── Build RawEventData ────────────────────────────────────────────────────
    raw = RawEventData()
    raw.title = normalize_text(data.get("title") or "")
    raw.start_datetime_raw = data.get("start_datetime")
    raw.end_datetime_raw = data.get("end_datetime")
    raw.venue_name = normalize_text(data.get("venue_name") or "")
    raw.address = normalize_text(data.get("address") or "")
    raw.city = normalize_text(data.get("city") or "")
    raw.state = normalize_text(data.get("state") or "")
    raw.price_text = normalize_text(data.get("price_text") or "")
    raw.description = normalize_text(data.get("description") or "")
    raw.organizer = normalize_text(data.get("organizer") or "")
    raw.event_format = data.get("event_format")
    raw.event_url = page_url
    raw.evidence_snippets = [
        f"llm_provider={llm_client.provider}",
        f"llm_model={llm_client.model}",
        f"llm_confidence={confidence:.2f}",
    ]

    return raw
