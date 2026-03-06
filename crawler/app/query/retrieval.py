"""
Semantic retrieval: embed a search intent → pgvector similarity search.

Flow:
  1. Embed cs.intent using the OpenAI Embeddings API.
  2. Run search_events_semantic() with the date + is_free constraints.
  3. If no results and is_free was set, retry without the free filter.
  4. Fall back to chronological ORDER BY when embeddings are disabled or fail.

Returns (events: list[dict], method: str).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import asyncpg

from app.config import settings
from app.query.parser import ConstraintSet
from app.utils.logger import BoundLogger

log = BoundLogger("kickflip.retrieval")


async def retrieve_events(
    cs: ConstraintSet,
    pool: asyncpg.Pool,
    candidate_limit: Optional[int] = None,
) -> tuple[list[dict], str]:
    """
    Embed the intent text and run a pgvector cosine-similarity search.

    Returns ``(events, method)`` where method is one of:
      ``semantic``          — cosine similarity ranked results
      ``semantic_nofree``   — retried without is_free constraint (no results with it)
      ``chronological``     — fallback when embeddings are disabled / unavailable
    """
    from app.storage import database
    from app.utils.embedder import embed_texts

    limit = candidate_limit or settings.search_candidate_limit

    # ── Embedding disabled or no key ─────────────────────────────────────────
    if not settings.enable_embeddings:
        return await _chronological_fallback(cs, pool, limit), "chronological"

    api_key = settings.embedding_api_key or settings.llm_api_key
    if not api_key:
        log.warning("No embedding API key — falling back to chronological search")
        return await _chronological_fallback(cs, pool, limit), "chronological"

    # ── Embed the intent ──────────────────────────────────────────────────────
    try:
        vecs = await embed_texts(
            [cs.intent],
            api_key=api_key,
            model=settings.embedding_model,
            provider=settings.embedding_provider,
            batch_size=1,
            task_type="RETRIEVAL_QUERY",                         # query task type for Google
            output_dimensionality=settings.embedding_dimensions, # must match indexed vectors
        )
        query_vec = vecs[0]
    except Exception as exc:
        log.warning(f"Intent embedding failed: {exc} — falling back to chronological")
        return await _chronological_fallback(cs, pool, limit), "chronological"

    if query_vec is None:
        log.warning("Intent embedding returned None — falling back to chronological")
        return await _chronological_fallback(cs, pool, limit), "chronological"

    # ── Primary semantic search ───────────────────────────────────────────────
    events = await database.search_events_semantic(
        pool=pool,
        query_embedding=query_vec,
        date_from=cs.date_from,
        date_to=cs.date_to,
        is_free=cs.is_free,
        limit=limit,
    )

    # ── Retry without is_free if no results ──────────────────────────────────
    if not events and cs.is_free is not None:
        log.info("No semantic results with is_free filter — retrying without it")
        events = await database.search_events_semantic(
            pool=pool,
            query_embedding=query_vec,
            date_from=cs.date_from,
            date_to=cs.date_to,
            is_free=None,
            limit=limit,
        )
        return events, "semantic_nofree"

    return events, "semantic"


async def _chronological_fallback(
    cs: ConstraintSet,
    pool: asyncpg.Pool,
    limit: int,
) -> list[dict]:
    """Return active future events ordered by start_time within the date window."""
    conditions: list[str] = ["is_active = TRUE"]
    params: list = []

    if cs.date_from is not None:
        params.append(cs.date_from)
        conditions.append(f"start_time >= ${len(params)}")
    else:
        params.append(datetime.now(timezone.utc))
        conditions.append(f"start_time >= ${len(params)}")

    if cs.date_to is not None:
        params.append(cs.date_to)
        conditions.append(f"start_time <= ${len(params)}")

    if cs.is_free is not None:
        params.append(cs.is_free)
        conditions.append(f"is_free = ${len(params)}")

    params.append(limit)
    where = " AND ".join(conditions)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                id, title, start_time, end_time,
                venue, address, city, state,
                price, is_free,
                ticket_url, source_url, source_name, image_url,
                event_summary, description, categories
            FROM kickflip_events
            WHERE {where}
            ORDER BY start_time ASC
            LIMIT ${len(params)}
            """,
            *params,
        )

    return [dict(r) for r in rows]
