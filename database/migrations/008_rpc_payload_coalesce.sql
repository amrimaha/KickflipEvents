-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: Fix RPCs to return usable payload for both crawlers
--
-- Problem:
--   Amrita's crawler stores event data in the `payload` JSONB column.
--   Ravi's crawler stores data in individual columns (title, start_time,
--   venue, image_url, etc.) and never writes to `payload`.
--   The Node.js server spreads `row.payload` — so Ravi's events returned
--   null payload and showed up as empty cards on the frontend.
--
-- Fix:
--   Both RPCs now return COALESCE(payload, constructed_json) so Ravi's
--   events get a payload built from their individual columns, and Amrita's
--   events continue to use their existing payload unchanged.
--
-- Safe to run multiple times (CREATE OR REPLACE).
-- Run in: Supabase SQL Editor → paste → Run
-- ─────────────────────────────────────────────────────────────────────────────

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
    -- Return existing payload for Amrita's events, or construct one for Ravi's
    COALESCE(
      e.payload,
      jsonb_build_object(
        'title',           e.title,
        'startDate',       TO_CHAR(e.start_time, 'YYYY-MM-DD'),
        'date',            TO_CHAR(e.start_time, 'YYYY-MM-DD'),
        'startTime',       TO_CHAR(e.start_time, 'HH24:MI'),
        'location',        COALESCE(e.venue, e.city, 'Seattle'),
        'locationName',    e.venue,
        'address',         e.address,
        'city',            COALESCE(e.city, 'Seattle'),
        'description',     COALESCE(e.event_summary, e.description, ''),
        'vibeDescription', e.event_summary,
        'imageUrl',        e.image_url,
        'link',            COALESCE(e.event_url, e.source_url),
        'source_url',      e.source_url,
        'price',           COALESCE(e.price, 'Free'),
        'isFree',          COALESCE(e.is_free, e.price = 'Free' OR e.price = '0'),
        'category',        COALESCE(e.categories->0, '"other"'::jsonb),
        'organizer',       e.organizer,
        'origin',          e.origin,
        'crawl_method',    e.crawl_method
      )
    ) AS payload
  FROM kickflip_events e
  WHERE
    CASE
      WHEN e.expires_at IS NOT NULL THEN e.expires_at > NOW()
      WHEN e.start_time IS NOT NULL THEN e.start_time > NOW()
      ELSE TRUE
    END
    AND e.is_active = TRUE
    AND (date_from IS NULL OR
         COALESCE(e.start_time, (e.payload->>'startDate')::TIMESTAMPTZ) >= date_from)
    AND (date_to   IS NULL OR
         COALESCE(e.start_time, (e.payload->>'startDate')::TIMESTAMPTZ) <= date_to)
    AND (filter_is_free IS NULL OR e.is_free = filter_is_free)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;


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
        'startDate',       TO_CHAR(e.start_time, 'YYYY-MM-DD'),
        'date',            TO_CHAR(e.start_time, 'YYYY-MM-DD'),
        'startTime',       TO_CHAR(e.start_time, 'HH24:MI'),
        'location',        COALESCE(e.venue, e.city, 'Seattle'),
        'locationName',    e.venue,
        'address',         e.address,
        'city',            COALESCE(e.city, 'Seattle'),
        'description',     COALESCE(e.event_summary, e.description, ''),
        'vibeDescription', e.event_summary,
        'imageUrl',        e.image_url,
        'link',            COALESCE(e.event_url, e.source_url),
        'source_url',      e.source_url,
        'price',           COALESCE(e.price, 'Free'),
        'isFree',          COALESCE(e.is_free, e.price = 'Free' OR e.price = '0'),
        'category',        COALESCE(e.categories->0, '"other"'::jsonb),
        'organizer',       e.organizer,
        'origin',          e.origin,
        'crawl_method',    e.crawl_method
      )
    ) AS payload
  FROM kickflip_events e
  WHERE
    CASE
      WHEN e.expires_at IS NOT NULL THEN e.expires_at > NOW()
      WHEN e.start_time IS NOT NULL THEN e.start_time > NOW()
      ELSE TRUE
    END
    AND e.is_active = TRUE
    AND (date_from IS NULL OR
         COALESCE(e.start_time, (e.payload->>'startDate')::TIMESTAMPTZ) >= date_from)
    AND (date_to IS NULL OR
         COALESCE(e.start_time, (e.payload->>'startDate')::TIMESTAMPTZ) <= date_to)
    AND (filter_is_free IS NULL OR e.is_free = filter_is_free)
  ORDER BY COALESCE(e.start_time, (e.payload->>'startDate')::TIMESTAMPTZ) ASC NULLS LAST
  LIMIT result_limit;
END;
$$;
