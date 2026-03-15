-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013: Fix RPC past-event bug in both search functions
--
-- BUG: The previous WHERE clause used a CASE that checked expires_at FIRST.
-- If expires_at was set to any future date, start_time was never checked.
-- Result: events with past start_time (e.g. Mar 8) but future expires_at
-- (e.g. Dec 31) were returned as "upcoming" — even if the event already happened.
--
-- FIX: Replace the CASE with two independent conditions:
--   1. Event must not be expired: expires_at IS NULL OR expires_at > NOW()
--   2. Event must not have a past start_time: start_time IS NULL OR start_time > NOW()-4h
--      (4-hour buffer so in-progress events are still visible)
--
-- Affects: search_events_chronological, search_events_by_embedding
-- Safe to run multiple times (CREATE OR REPLACE).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION search_events_chronological(
  result_limit   INT         DEFAULT 10,
  date_from      TIMESTAMPTZ DEFAULT NULL,
  date_to        TIMESTAMPTZ DEFAULT NULL,
  filter_is_free BOOLEAN     DEFAULT NULL
)
RETURNS TABLE (
  id      TEXT,
  payload JSONB
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    COALESCE(
      e.payload,
      jsonb_build_object(
        'title',           e.title,
        'startDate',       TO_CHAR(NULLIF(e.start_time,'')::TIMESTAMPTZ, 'YYYY-MM-DD'),
        'date',            TO_CHAR(NULLIF(e.start_time,'')::TIMESTAMPTZ, 'YYYY-MM-DD'),
        'startTime',       TO_CHAR(NULLIF(e.start_time,'')::TIMESTAMPTZ, 'HH24:MI'),
        'location',        COALESCE(e.venue, e.city, 'Seattle'),
        'locationName',    e.venue,
        'address',         e.address,
        'city',            COALESCE(e.city, 'Seattle'),
        'description',     COALESCE(e.event_summary, ''),
        'vibeDescription', e.event_summary,
        'imageUrl',        e.image_url,
        'link',            COALESCE(e.event_url, e.source_url),
        'source_url',      e.source_url,
        'price',           COALESCE(e.price, 'Free'),
        'isFree',          COALESCE(e.is_free, e.price = 'Free' OR e.price = '0'),
        'category',        COALESCE(e.category, 'other'),
        'organizer',       e.organizer,
        'origin',          e.origin,
        'crawl_method',    e.crawl_method
      )
    ) AS payload
  FROM kickflip_events e
  WHERE
    -- Must not be expired
    (e.expires_at IS NULL OR e.expires_at > NOW())
    -- Must not have already started (4h buffer for in-progress events)
    AND (
      e.start_time IS NULL
      OR NULLIF(e.start_time,'') IS NULL
      OR NULLIF(e.start_time,'')::TIMESTAMPTZ > NOW() - INTERVAL '4 hours'
    )
    AND e.is_active = TRUE
    AND (date_from IS NULL OR
         COALESCE(NULLIF(e.start_time,'')::TIMESTAMPTZ,
                  (e.payload->>'startDate')::TIMESTAMPTZ) >= date_from)
    AND (date_to IS NULL OR
         COALESCE(NULLIF(e.start_time,'')::TIMESTAMPTZ,
                  (e.payload->>'startDate')::TIMESTAMPTZ) <= date_to)
    AND (filter_is_free IS NULL OR e.is_free = filter_is_free)
  ORDER BY COALESCE(NULLIF(e.start_time,'')::TIMESTAMPTZ,
                    (e.payload->>'startDate')::TIMESTAMPTZ) ASC NULLS LAST
  LIMIT result_limit;
END;
$$;


CREATE OR REPLACE FUNCTION search_events_by_embedding(
  query_embedding   VECTOR(1024),
  match_threshold   FLOAT       DEFAULT 0.72,
  match_count       INT         DEFAULT 10,
  date_from         TIMESTAMPTZ DEFAULT NULL,
  date_to           TIMESTAMPTZ DEFAULT NULL,
  filter_is_free    BOOLEAN     DEFAULT NULL
)
RETURNS TABLE (
  id          TEXT,
  similarity  FLOAT,
  payload     JSONB
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity,
    COALESCE(
      e.payload,
      jsonb_build_object(
        'title',           e.title,
        'startDate',       TO_CHAR(NULLIF(e.start_time,'')::TIMESTAMPTZ, 'YYYY-MM-DD'),
        'date',            TO_CHAR(NULLIF(e.start_time,'')::TIMESTAMPTZ, 'YYYY-MM-DD'),
        'startTime',       TO_CHAR(NULLIF(e.start_time,'')::TIMESTAMPTZ, 'HH24:MI'),
        'location',        COALESCE(e.venue, e.city, 'Seattle'),
        'locationName',    e.venue,
        'address',         e.address,
        'city',            COALESCE(e.city, 'Seattle'),
        'description',     COALESCE(e.event_summary, ''),
        'vibeDescription', e.event_summary,
        'imageUrl',        e.image_url,
        'link',            COALESCE(e.event_url, e.source_url),
        'source_url',      e.source_url,
        'price',           COALESCE(e.price, 'Free'),
        'isFree',          COALESCE(e.is_free, e.price = 'Free' OR e.price = '0'),
        'category',        COALESCE(e.category, 'other'),
        'organizer',       e.organizer,
        'origin',          e.origin,
        'crawl_method',    e.crawl_method
      )
    ) AS payload
  FROM kickflip_events e
  WHERE
    -- Must not be expired
    (e.expires_at IS NULL OR e.expires_at > NOW())
    -- Must not have already started (4h buffer for in-progress events)
    AND (
      e.start_time IS NULL
      OR NULLIF(e.start_time,'') IS NULL
      OR NULLIF(e.start_time,'')::TIMESTAMPTZ > NOW() - INTERVAL '4 hours'
    )
    AND e.is_active = TRUE
    AND (date_from IS NULL OR
         COALESCE(NULLIF(e.start_time,'')::TIMESTAMPTZ,
                  (e.payload->>'startDate')::TIMESTAMPTZ) >= date_from)
    AND (date_to   IS NULL OR
         COALESCE(NULLIF(e.start_time,'')::TIMESTAMPTZ,
                  (e.payload->>'startDate')::TIMESTAMPTZ) <= date_to)
    AND (filter_is_free IS NULL OR e.is_free = filter_is_free)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
