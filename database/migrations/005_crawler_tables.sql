-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Tables + columns required by the Python Playwright crawler
--
-- Creates:
--   kickflip_batch_runs  — one row per /run invocation (crawl stats)
--   kickflip_batch_locks — prevents concurrent crawl runs on the same day
--   kickflip_jobs        — job registry for GET /jobs + log streaming
--
-- Adds missing columns to kickflip_events that the crawler writes:
--   fingerprint, source_name, source_domain, organizer, vibe_tags,
--   confidence, extraction_method, evidence_snippets, raw_data,
--   first_seen_at, last_seen_at
--
-- Safe to run multiple times (all statements use IF NOT EXISTS).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. kickflip_batch_runs
--    Tracks each POST /run invocation: stats, duration, per-source breakdown.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kickflip_batch_runs (
    id             BIGSERIAL   PRIMARY KEY,
    run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    success        BOOLEAN     NOT NULL DEFAULT FALSE,
    error_msg      TEXT,
    duration_ms    INTEGER     DEFAULT 0,
    discovered     INT         NOT NULL DEFAULT 0,
    fetched        INT         NOT NULL DEFAULT 0,
    normalized     INT         NOT NULL DEFAULT 0,
    upserted       INT         NOT NULL DEFAULT 0,
    expired        INT                  DEFAULT 0,
    errors         INT                  DEFAULT 0,
    run_id         TEXT,
    source_results JSONB       NOT NULL DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kbr_run_id
    ON kickflip_batch_runs (run_id)
    WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kbr_run_at
    ON kickflip_batch_runs (run_at DESC);


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. kickflip_batch_locks
--    Advisory lock — one row per calendar day.
--    Prevents two concurrent crawl runs from interfering.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kickflip_batch_locks (
    run_date     DATE        PRIMARY KEY,
    status       TEXT        NOT NULL DEFAULT 'running',
    instance_id  TEXT        NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kbl_run_date
    ON kickflip_batch_locks (run_date);


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. kickflip_jobs
--    Job registry: tracks status, summary, and persisted log content
--    for GET /jobs and GET /jobs/{id}/logs endpoints.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kickflip_jobs (
    job_id         TEXT        PRIMARY KEY,
    status         TEXT        NOT NULL DEFAULT 'queued',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    duration_ms    INTEGER,
    run_id         TEXT,
    db_run_id      INTEGER,
    log_line_count INTEGER     NOT NULL DEFAULT 0,
    logs_expire_at TIMESTAMPTZ,
    summary        JSONB,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    log_content    TEXT
);

CREATE INDEX IF NOT EXISTS idx_kickflip_jobs_created_at
    ON kickflip_jobs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kickflip_jobs_status
    ON kickflip_jobs (status);


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Missing columns on kickflip_events (written by the Python crawler)
-- ═════════════════════════════════════════════════════════════════════════════

-- Content-based dedup hash: SHA-256(title + start_time + venue)
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS fingerprint        TEXT;

-- Canonical source name label (e.g. "Visit Seattle", "SIFF", "Eventbrite")
-- Amrita uses crawl_source for the same purpose; both are kept.
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS source_name        TEXT;

-- Domain extracted from source_url (e.g. "eventbrite.com")
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS source_domain      TEXT;

-- Organizer / promoter name
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS organizer          TEXT NOT NULL DEFAULT '';

-- Vibe/mood tags (e.g. ["outdoor", "family-friendly"])
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS vibe_tags          JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Extraction confidence score 0.0–1.0
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS confidence         FLOAT
                                                CHECK (confidence BETWEEN 0 AND 1);

-- Which parser layer produced the data
-- Values: jsonld | microdata | site_profile | heuristics | llm_fallback
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS extraction_method  TEXT;

-- Raw text snippets used as evidence for extracted fields
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS evidence_snippets  TEXT[] NOT NULL DEFAULT '{}';

-- Full raw JSONB blob from the parser
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS raw_data           JSONB;

-- When this event was first and last seen by any crawler
ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE kickflip_events
    ADD COLUMN IF NOT EXISTS last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();


-- ─── Indexes on new kickflip_events columns ───────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_kfe_fingerprint
    ON kickflip_events (fingerprint)
    WHERE fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kfe_source_name
    ON kickflip_events (source_name);

CREATE INDEX IF NOT EXISTS idx_kfe_confidence
    ON kickflip_events (confidence)
    WHERE is_active = TRUE;
