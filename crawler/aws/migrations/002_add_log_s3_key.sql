-- Migration 002: add log_s3_key column to kickflip_jobs
--
-- The ECS entrypoint uploads a JSONL log file to S3 at job completion and
-- stores the S3 object key here.  The get_job_logs Lambda reads from S3
-- using this key (falls back to log_content if absent).
--
-- Run in Supabase SQL Editor before deploying the new entrypoint image.

ALTER TABLE kickflip_jobs
    ADD COLUMN IF NOT EXISTS log_s3_key TEXT DEFAULT NULL;
