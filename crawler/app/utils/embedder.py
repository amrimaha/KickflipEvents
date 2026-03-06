"""
Multi-provider text embedding utility for kickflip events.

Supported providers:
  google  (default) — Google gemini-embedding-001, 3072-dim
                       Uses the google-genai SDK.
                       Set EMBEDDING_PROVIDER=google (or leave as default).
  openai            — OpenAI text-embedding-3-small, 1536-dim
                       Requires: pip install openai
                       Set EMBEDDING_PROVIDER=openai

Two public functions:

    build_event_text(event: dict) -> str
        Flatten an event row into a single embeddable string.

    embed_texts(texts, api_key, model, provider, batch_size) -> list[Optional[list[float]]]
        Call the embedding API in batches; return a parallel list of float
        vectors (None for items that failed).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

_log = logging.getLogger("kickflip.embedder")


# ── Text builder ──────────────────────────────────────────────────────────────

def build_event_text(event: dict) -> str:
    """
    Produce a compact, embeddable text representation of one event.

    Priority: title > event_summary/description > venue > city > categories.
    Parts are joined with " | " so the model captures all semantic dimensions.
    """
    cats = event.get("categories") or []
    if isinstance(cats, str):
        try:
            cats = json.loads(cats)
        except Exception:
            cats = [cats]
    categories_str = " ".join(str(c) for c in cats) if cats else ""

    summary = event.get("event_summary") or event.get("description") or ""
    if len(summary) > 300:
        summary = summary[:300]   # prevent one field from dominating the vector

    parts = [
        event.get("title") or "",
        summary,
        event.get("venue") or "",
        event.get("city") or "",
        categories_str,
    ]
    return " | ".join(p for p in parts if p).strip()


# ── Google embedding ──────────────────────────────────────────────────────────

async def _embed_google(
    texts: list[str],
    api_key: str,
    model: str,
    batch_size: int,
    task_type: str = "RETRIEVAL_DOCUMENT",
    output_dimensionality: Optional[int] = None,
) -> list[Optional[list[float]]]:
    """
    Embed texts using Google's gemini-embedding-001 (or compatible) model.

    Uses the google-genai SDK (async API) — no thread pool needed.
    Concurrency is capped at batch_size simultaneous calls via asyncio.gather.

    output_dimensionality: truncate vectors to this many dimensions (≤2000 for
    HNSW index support). gemini-embedding-001 natively outputs 3072-dim but
    can be truncated losslessly. Defaults to the model's native dimension.
    """
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise ImportError(
            "google-genai is required for EMBEDDING_PROVIDER=google. "
            "Run: pip install google-genai"
        )

    client = genai.Client(api_key=api_key)
    cfg = types.EmbedContentConfig(
        task_type=task_type,
        output_dimensionality=output_dimensionality,
    )

    async def _one(text: str) -> Optional[list[float]]:
        if not text:
            return None
        try:
            result = await client.aio.models.embed_content(
                model=model,
                contents=text,
                config=cfg,
            )
            return list(result.embeddings[0].values)
        except Exception as exc:
            _log.warning("embed_content failed for %r: %s", text[:60], exc)
            return None

    results: list[Optional[list[float]]] = [None] * len(texts)

    # Process in windows of batch_size to avoid hammering the API
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        batch_results = await asyncio.gather(*(_one(t) for t in batch))
        for j, r in enumerate(batch_results):
            results[i + j] = r

    return results


# ── OpenAI embedding ──────────────────────────────────────────────────────────

async def _embed_openai(
    texts: list[str],
    api_key: str,
    model: str,
    batch_size: int,
) -> list[Optional[list[float]]]:
    """
    Embed texts using OpenAI's embeddings API (text-embedding-3-small, 1536-dim).
    Processes in batches of batch_size (OpenAI accepts up to 2 048 per call).
    """
    try:
        from openai import AsyncOpenAI
    except ImportError:
        raise ImportError(
            "openai is required for EMBEDDING_PROVIDER=openai. "
            "Run: pip install openai"
        )

    client = AsyncOpenAI(api_key=api_key)
    results: list[Optional[list[float]]] = [None] * len(texts)

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        try:
            response = await client.embeddings.create(model=model, input=batch)
            for j, emb_obj in enumerate(response.data):
                results[i + j] = emb_obj.embedding
        except Exception as exc:
            _log.warning("OpenAI embed batch %d failed: %s", i // batch_size, exc)

    return results


# ── Public dispatcher ─────────────────────────────────────────────────────────

async def embed_texts(
    texts: list[str],
    api_key: str,
    model: str,
    provider: str = "google",
    batch_size: int = 100,
    task_type: str = "RETRIEVAL_DOCUMENT",
    output_dimensionality: Optional[int] = None,
) -> list[Optional[list[float]]]:
    """
    Embed *texts* using the specified provider.

    Args:
        texts:                Strings to embed (one vector returned per string).
        api_key:              Provider API key (Gemini key for google, OpenAI key for openai).
        model:                Model name — e.g. "models/gemini-embedding-001" or
                              "text-embedding-3-small".
        provider:             "google" (default) or "openai".
        batch_size:           Max concurrent requests (google) or items per batch (openai).
        task_type:            Google task type hint — "RETRIEVAL_DOCUMENT" for indexing,
                              "RETRIEVAL_QUERY" for search queries.  Ignored for openai.
        output_dimensionality: Truncate Google vectors to this many dimensions.
                              Must be ≤2000 to support an HNSW index.  Ignored for openai.

    Returns:
        Parallel list[Optional[list[float]]]; None for items that failed.
    """
    if provider == "google":
        return await _embed_google(
            texts, api_key, model, batch_size, task_type, output_dimensionality
        )
    elif provider == "openai":
        return await _embed_openai(texts, api_key, model, batch_size)
    else:
        raise ValueError(
            f"Unknown embedding provider: {provider!r}. "
            "Supported values: 'google', 'openai'."
        )
