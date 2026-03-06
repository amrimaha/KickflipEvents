from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ── Database ─────────────────────────────────────────────────────────────
    # Transaction Pooler (PgBouncer port 6543) URL from Supabase — required.
    # asyncpg disables prepared-statement cache automatically when using pooler.
    database_url: str = ""

    # ── Timezone ──────────────────────────────────────────────────────────────
    timezone: str = "America/Los_Angeles"

    # ── LLM fallback ──────────────────────────────────────────────────────────
    # Off by default.  Set ENABLE_LLM_FALLBACK=true + LLM_API_KEY to enable.
    enable_llm_fallback: bool = False
    llm_provider: str = "gemini"            # gemini | openai | anthropic
    llm_model: str = "gemini-2.0-flash"
    llm_api_key: Optional[str] = None
    # Hard cap on LLM API calls per single /run invocation (cost guard)
    llm_max_calls_per_run: int = 20
    # Only call LLM when confidence is below this threshold
    llm_confidence_threshold: float = 0.45

    # ── Crawl concurrency ─────────────────────────────────────────────────────
    max_concurrent_sources: int = 5
    max_concurrent_pages_per_source: int = 3

    # ── Timeouts (seconds) ────────────────────────────────────────────────────
    fetch_timeout: int = 30
    render_timeout: int = 45

    # ── Retry behaviour ───────────────────────────────────────────────────────
    max_retries: int = 3
    retry_wait_min: float = 1.0
    retry_wait_max: float = 10.0

    # ── Sources / profiles ────────────────────────────────────────────────────
    sources_file: str = "sources.yaml"
    site_profiles_dir: str = "site_profiles"

    # ── Batch lock ────────────────────────────────────────────────────────────
    # Running locks older than this are considered stale and overridden.
    batch_lock_stale_hours: int = 6

    # ── Inactivity threshold ──────────────────────────────────────────────────
    mark_inactive_after_days: int = 30

    # ── Response tuning ───────────────────────────────────────────────────────
    sample_events_in_response: int = 3

    # ── Robots.txt ────────────────────────────────────────────────────────────
    respect_robots_txt: bool = True
    # Must match the User-Agent header sent in HTTP/Playwright requests so that
    # robots.txt rules are evaluated for the same identity we present to servers.
    robots_user_agent: str = "Mozilla/5.0 (compatible; KickflipBot/1.0; +https://kickflip.app/bot)"
    # Timeout for fetching robots.txt (seconds). On timeout: fail-open (allow).
    robots_fetch_timeout: float = 8.0

    # ── Embeddings (semantic search) ──────────────────────────────────────────
    # Off by default. Set ENABLE_EMBEDDINGS=true to enable.
    # Provider:  google  → gemini-embedding-001 (3072-dim, uses LLM_API_KEY / EMBEDDING_API_KEY)
    #            openai  → text-embedding-3-small (1536-dim, needs a separate OpenAI key)
    enable_embeddings: bool = True
    embedding_provider: str = "google"                        # google | openai
    embedding_model: str = "models/gemini-embedding-001"     # native 3072-dim, truncated to embedding_dimensions
    embedding_dimensions: int = 768                          # output dims (≤2000 for HNSW index)
    embedding_api_key: Optional[str] = None                  # falls back to llm_api_key if unset
    embedding_batch_size: int = 100                          # max concurrent embed calls

    # ── Search (POST /search) ─────────────────────────────────────────────────
    search_candidate_limit: int = 20   # semantic candidates fetched from DB
    search_result_limit: int = 8       # events returned in the /search response
    search_llm_max_tokens: int = 400   # cap for LLM response formatting (keep it short)

    # ── Job log retention ─────────────────────────────────────────────────────
    # How long job logs are retained after a job finishes.
    # Applies to both in-memory log_lines AND the DB-persisted log_content column.
    # GET /jobs/{id}/logs returns 410 Gone once this window has passed.
    log_retention_hours: int = 48

    # ── Supabase project ──────────────────────────────────────────────────────
    # Base URL of your Supabase project, e.g. https://<ref>.supabase.co
    # Required by the media upload endpoint to call the Storage REST API.
    supabase_url: str = ""
    # service_role key (never expose to clients).  Used for Storage uploads.
    supabase_service_key: str = ""
    # Storage bucket for uploaded event media.
    storage_bucket: str = "event-media"

    # ── Auth (Supabase JWT) ───────────────────────────────────────────────────
    # JWKS endpoint from your Supabase project (RS256 public keys).
    # Found at: https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
    # Required for admin endpoints.  Requests to protected endpoints return
    # 500 if this is unset (fail closed, never fail open).
    supabase_jwks_url: str = ""
    # Optional: paste the raw JWKS JSON here to skip the network fetch entirely.
    # Useful when supabase.co is blocked at the network level (e.g. ISP blocks).
    # curl https://<project>.supabase.co/auth/v1/.well-known/jwks.json
    supabase_jwks_json: Optional[str] = None

    # ── Chat (POST /chat) ─────────────────────────────────────────────────────
    # Conversational assistant endpoint.  Defaults to anthropic (claude-sonnet-4-6).
    # Falls back to llm_api_key when chat_api_key is unset.
    chat_provider: str = "gemini"          # anthropic | gemini | openai
    # chat_model: str = "claude-sonnet-4-6"
    chat_model: str = "gemini-2.0-flash"
    chat_api_key: Optional[str] = None        # falls back to llm_api_key if unset
    chat_max_tokens: int = 1024

    # ── Development — NEVER enable in production ──────────────────────────────
    # When debug_mode=true a static token bypasses all JWKS/DB auth checks.
    # Set in .env:  DEBUG_MODE=true  (omit or set false for any deployed env)
    debug_mode:         bool = False
    debug_bypass_token: str  = "kickflip-dev-token"

    # ── CORS ──────────────────────────────────────────────────────────────────
    # Comma-separated list of allowed origins, or * to allow all.
    # Example .env: CORS_ORIGINS=http://localhost:3000,http://localhost:5173
    cors_origins: str = "*"

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "case_sensitive": False, "extra": "ignore"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
