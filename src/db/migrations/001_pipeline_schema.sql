-- OpenClaw Multi-Agent Pipeline Schema
-- This migration creates the core tables for pipeline state management.
--
-- Tables:
--   work_items    - Epics, tasks, and other work units
--   agent_runs    - Execution history of agent work
--   pipeline_events - Audit log of all pipeline events

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Work item status enum
CREATE TYPE work_status AS ENUM (
  'pending',      -- Waiting to be picked up
  'in_progress',  -- Currently being worked on
  'review',       -- Awaiting review
  'blocked',      -- Blocked by dependencies
  'done',         -- Successfully completed
  'failed'        -- Failed (will be retried or escalated)
);

-- Work item type enum
CREATE TYPE work_type AS ENUM (
  'project',      -- Top-level container
  'epic',         -- Feature/story grouping
  'task'          -- Individual implementation unit
);

-- Agent role enum
CREATE TYPE agent_role AS ENUM (
  'pm',
  'domain-expert',
  'architect',
  'cto-review',
  'senior-dev',
  'staff-engineer',
  'code-simplifier',
  'ui-review',
  'ci-agent'
);

-- Agent run status enum
CREATE TYPE run_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

-- =============================================================================
-- WORK ITEMS TABLE
-- =============================================================================
-- Stores epics, tasks, and their hierarchical relationships.
-- Each work item has a status, can be assigned to an agent, and references
-- a spec file in the .flow/ directory.

CREATE TABLE work_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Type and hierarchy
  type work_type NOT NULL,
  parent_id UUID REFERENCES work_items(id) ON DELETE CASCADE,

  -- Core fields
  title TEXT NOT NULL,
  description TEXT,
  status work_status NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,  -- Higher = more urgent

  -- Assignment
  assigned_agent agent_role,
  assigned_instance TEXT,  -- Unique agent instance ID for scaling

  -- File references
  spec_path TEXT,  -- Path to .flow/specs/<epic>.md or .flow/tasks/<epic>.<n>.md

  -- Retry tracking
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,

  -- Metadata
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX idx_work_items_status ON work_items(status);
CREATE INDEX idx_work_items_type ON work_items(type);
CREATE INDEX idx_work_items_parent ON work_items(parent_id);
CREATE INDEX idx_work_items_assigned ON work_items(assigned_agent, status);
CREATE INDEX idx_work_items_priority ON work_items(priority DESC, created_at ASC);
CREATE INDEX idx_work_items_pending ON work_items(status) WHERE status = 'pending';

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER work_items_updated_at
  BEFORE UPDATE ON work_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();


-- =============================================================================
-- AGENT RUNS TABLE
-- =============================================================================
-- Tracks each execution of an agent on a work item.
-- Useful for debugging, metrics, and replay.

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- What was worked on
  work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,

  -- Who did the work
  agent_role agent_role NOT NULL,
  agent_instance TEXT,  -- Unique instance ID for scaled agents

  -- Execution details
  status run_status NOT NULL DEFAULT 'pending',

  -- Timing
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Results
  result JSONB,          -- Agent output data
  error TEXT,            -- Error message if failed

  -- Tracing
  event_id TEXT,         -- Redis stream message ID that triggered this run
  parent_run_id UUID REFERENCES agent_runs(id),  -- For chained runs

  -- Metadata
  metadata JSONB DEFAULT '{}'
);

-- Indexes
CREATE INDEX idx_agent_runs_work_item ON agent_runs(work_item_id);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_role, status);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_agent_runs_queued ON agent_runs(queued_at DESC);


-- =============================================================================
-- PIPELINE EVENTS TABLE
-- =============================================================================
-- Audit log of all events in the pipeline.
-- Mirrors Redis stream events for durability and querying.

CREATE TABLE pipeline_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Event identification
  stream_id TEXT NOT NULL,  -- Redis stream message ID (ULID)
  event_type TEXT NOT NULL,

  -- Routing
  source_agent agent_role,
  target_agent agent_role,

  -- References
  work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,

  -- Payload
  payload JSONB NOT NULL DEFAULT '{}',

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency - prevent duplicate processing
  UNIQUE(stream_id)
);

-- Indexes
CREATE INDEX idx_pipeline_events_type ON pipeline_events(event_type);
CREATE INDEX idx_pipeline_events_work_item ON pipeline_events(work_item_id);
CREATE INDEX idx_pipeline_events_source ON pipeline_events(source_agent);
CREATE INDEX idx_pipeline_events_target ON pipeline_events(target_agent);
CREATE INDEX idx_pipeline_events_created ON pipeline_events(created_at DESC);


-- =============================================================================
-- AGENT HEARTBEATS TABLE
-- =============================================================================
-- Health monitoring for agent instances.
-- The orchestrator checks this to detect crashed agents.

CREATE TABLE agent_heartbeats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Agent identity
  agent_role agent_role NOT NULL,
  instance_id TEXT NOT NULL,

  -- Health status
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,

  -- Process info
  pid INTEGER,
  hostname TEXT,

  -- Metadata
  metadata JSONB DEFAULT '{}',

  -- Unique constraint per instance
  UNIQUE(agent_role, instance_id)
);

-- Index for health check queries
CREATE INDEX idx_heartbeats_stale ON agent_heartbeats(last_heartbeat);


-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Get pending work for a specific agent role
CREATE OR REPLACE FUNCTION get_pending_work(target_role agent_role, limit_count INTEGER DEFAULT 10)
RETURNS SETOF work_items AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM work_items
  WHERE status = 'pending'
    AND assigned_agent = target_role
    AND attempt_count < max_attempts
  ORDER BY priority DESC, created_at ASC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Claim work item for an agent instance (atomic)
CREATE OR REPLACE FUNCTION claim_work(
  item_id UUID,
  claiming_role agent_role,
  claiming_instance TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE work_items
  SET
    status = 'in_progress',
    assigned_instance = claiming_instance,
    started_at = NOW(),
    attempt_count = attempt_count + 1
  WHERE id = item_id
    AND status = 'pending'
    AND assigned_agent = claiming_role;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$ LANGUAGE plpgsql;

-- Complete work item
CREATE OR REPLACE FUNCTION complete_work(
  item_id UUID,
  success BOOLEAN,
  error_msg TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE work_items
  SET
    status = CASE WHEN success THEN 'done'::work_status ELSE 'failed'::work_status END,
    completed_at = NOW(),
    last_error = error_msg
  WHERE id = item_id;
END;
$$ LANGUAGE plpgsql;
