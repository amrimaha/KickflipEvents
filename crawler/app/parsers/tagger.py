"""
Post-crawl vibe tagging pass.

Reads events with empty vibe_tags from kickflip_events, sends them to the
configured LLM in batches of 10, and writes vibe labels + price_tier back.

Tags written to vibe_tags JSONB column:
  - 1–3 vibe labels from the canonical set:
      adventurous, relaxing, social, educational, family-friendly,
      romantic, creative, cultural, nightlife, sporty
  - price tier encoded as a "price:<tier>" tag (e.g. "price:free", "price:low")
    so no schema change is needed — the frontend reads vibe_tags as-is.

Uses the same LLM_PROVIDER / LLM_MODEL / LLM_API_KEY env vars as the rest
of the crawler (default: gemini-2.0-flash).  Skipped silently if no API key.
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

import asyncpg

from app.config import settings
from app.utils.llm_client import LLMClient
from app.utils.logger import BoundLogger

log = BoundLogger("kickflip.tagger")

_BATCH_SIZE = 10

_SYSTEM_PROMPT = """\
You are a Seattle events tagger. For each event return ONLY a valid JSON array — \
no markdown fences, no commentary.

Output schema (one object per event):
[
  {
    "id": "<event id as given>",
    "vibe": ["<label>", ...],
    "price_tier": "free|low|medium|premium|unknown"
  }
]

vibe: 1–3 labels chosen from this exact set ONLY:
  adventurous, relaxing, social, educational, family-friendly,
  romantic, creative, cultural, nightlife, sporty

price_tier rules:
  free    = free admission / no cost
  low     = under $20
  medium  = $20–$60
  premium = over $60
  unknown = no price info provided
"""


def _build_batch_prompt(events: list[dict]) -> str:
    parts = []
    for e in events:
        cats = e.get("categories") or []
        if isinstance(cats, str):
            try:
                cats = json.loads(cats)
            except Exception:
                cats = []
        cats_str = ", ".join(str(c) for c in cats) if cats else "unknown"
        price_str = (
            e.get("price") or ("free" if e.get("is_free") else "unknown")
        )
        desc = (e.get("event_summary") or e.get("description") or "")[:300].strip()
        parts.append(
            f"id: {e['id']}\n"
            f"title: {e.get('title', '')}\n"
            f"categories: {cats_str}\n"
            f"price: {price_str}\n"
            f"description: {desc}"
        )
    return "\n\n---\n\n".join(parts)


async def tag_pending_events(pool: asyncpg.Pool) -> int:
    """
    Tag events that have an empty vibe_tags array.
    Returns count of events successfully tagged.
    Skipped silently when no LLM_API_KEY is configured.
    """
    api_key = settings.llm_api_key
    if not api_key:
        log.warning("tag_pending_events: LLM_API_KEY not set — skipping", stage="tag")
        return 0

    client = LLMClient(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=api_key,
    )

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, title, event_summary, description, categories, price, is_free
            FROM kickflip_events
            WHERE is_active = TRUE
              AND (vibe_tags IS NULL OR vibe_tags = '[]'::jsonb)
            ORDER BY last_seen_at DESC
            LIMIT 300
            """
        )

    if not rows:
        log.info("No events need tagging", stage="tag")
        return 0

    events = [dict(r) for r in rows]
    total_batches = (len(events) + _BATCH_SIZE - 1) // _BATCH_SIZE
    log.info(
        f"Tagging {len(events)} event(s) in {total_batches} batch(es)",
        stage="tag",
        extra={"provider": settings.llm_provider, "model": settings.llm_model},
    )

    tagged = 0
    for i in range(0, len(events), _BATCH_SIZE):
        batch = events[i : i + _BATCH_SIZE]
        batch_num = i // _BATCH_SIZE + 1

        prompt = _build_batch_prompt(batch)
        raw = await client.complete(
            system=_SYSTEM_PROMPT,
            user=f"Tag these {len(batch)} Seattle events:\n\n{prompt}",
            max_tokens=1024,
        )

        if not raw:
            log.warning(
                f"Batch {batch_num}/{total_batches}: empty LLM response",
                stage="tag",
            )
            continue

        # Strip accidental markdown fences
        clean = raw.strip()
        if clean.startswith("```"):
            lines = clean.split("\n")
            clean = "\n".join(lines[1:] if len(lines) > 1 else lines)
        if clean.endswith("```"):
            clean = "\n".join(clean.split("\n")[:-1])

        # Extract the JSON array
        start = clean.find("[")
        end   = clean.rfind("]")
        if start == -1 or end == -1:
            log.warning(
                f"Batch {batch_num}/{total_batches}: no JSON array in response",
                stage="tag",
            )
            continue

        try:
            parsed = json.loads(clean[start : end + 1])
        except json.JSONDecodeError as exc:
            log.warning(
                f"Batch {batch_num}/{total_batches}: JSON parse failed: {exc}",
                stage="tag",
            )
            continue

        if not isinstance(parsed, list):
            continue

        batch_tagged = 0
        async with pool.acquire() as conn:
            for item in parsed:
                event_id = str(item.get("id") or "").strip()
                if not event_id:
                    continue

                vibes = item.get("vibe") or []
                price_tier = (item.get("price_tier") or "unknown").strip()
                if not isinstance(vibes, list):
                    vibes = []

                tag_list: list[str] = [v for v in vibes if isinstance(v, str)]
                # Encode price_tier inline so vibe_tags carries full enrichment
                if price_tier and price_tier != "unknown":
                    tag_list.append(f"price:{price_tier}")

                try:
                    await conn.execute(
                        "UPDATE kickflip_events "
                        "SET vibe_tags = $1::jsonb, updated_at = NOW() "
                        "WHERE id = $2",
                        json.dumps(tag_list),
                        event_id,
                    )
                    tagged += 1
                    batch_tagged += 1
                except Exception as exc:
                    log.warning(
                        f"vibe_tags update failed for {event_id}: {exc}",
                        stage="tag",
                    )

        log.info(
            f"Batch {batch_num}/{total_batches}: tagged {batch_tagged}/{len(batch)}",
            stage="tag",
        )

        # Brief pause between batches (rate-limit safety)
        if i + _BATCH_SIZE < len(events):
            await asyncio.sleep(1.0)

    log.info(f"Tagging complete: {tagged}/{len(events)} event(s) tagged", stage="tag")
    return tagged
