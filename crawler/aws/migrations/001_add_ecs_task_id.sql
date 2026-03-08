-- Migration: add ecs_task_id column to kickflip_jobs
--
-- Purpose: The Lambda log-streaming function needs to know which CloudWatch
-- log stream corresponds to a running ECS task.  The stream name is derived
-- from the ECS task ID:
--   {stream-prefix}/{container-name}/{task-id}
--
-- The crawler container reads its own ECS task ARN from the ECS container
-- metadata endpoint (ECS_CONTAINER_METADATA_URI_V4) on startup and stores
-- the short task ID here (last segment of the ARN).
--
-- Run this once against your Supabase database before deploying to AWS.
-- Safe to run multiple times (IF NOT EXISTS guard).

ALTER TABLE kickflip_jobs
    ADD COLUMN IF NOT EXISTS ecs_task_id TEXT DEFAULT NULL;

-- Index for the rare case where we query by task ID (e.g. EventBridge → Lambda
-- that maps ECS task state-change events back to job rows).
CREATE INDEX IF NOT EXISTS idx_kickflip_jobs_ecs_task_id
    ON kickflip_jobs (ecs_task_id)
    WHERE ecs_task_id IS NOT NULL;

COMMENT ON COLUMN kickflip_jobs.ecs_task_id IS
    'Short ECS task ID (last segment of task ARN). Set by the crawler on '
    'startup when running on ECS Fargate. Used by the log-streaming Lambda '
    'to locate the CloudWatch log stream for live log tailing.';
