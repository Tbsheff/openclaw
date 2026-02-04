/**
 * Pipeline tool for main agent to interact with multi-agent pipeline.
 *
 * Provides actions to submit goals, check status, and list work items
 * without needing to shell out to CLI commands.
 */

import { Type } from "@sinclair/typebox";
import { getDB, type WorkType, type AgentRole } from "../../db/postgres.js";
import { getRedis } from "../../events/redis-streams.js";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const PIPELINE_ACTIONS = ["submit", "status", "list"] as const;
const WORK_TYPES = ["project", "epic", "task"] as const;

// =============================================================================
// SCHEMA
// =============================================================================

const PipelineToolSchema = Type.Object({
  action: stringEnum(PIPELINE_ACTIONS, {
    description: "Action to perform: submit, status, or list",
  }),
  // submit params
  goal: Type.Optional(
    Type.String({
      description: "Goal to submit to pipeline (required for submit action)",
    }),
  ),
  priority: Type.Optional(
    Type.Number({
      description: "Priority (higher = more urgent, default: 0)",
    }),
  ),
  type: optionalStringEnum(WORK_TYPES, {
    description: "Work item type (default: project)",
  }),
  // status params
  workItemId: Type.Optional(
    Type.String({
      description: "Work item ID to check status for (required for status action)",
    }),
  ),
  deep: Type.Optional(
    Type.Boolean({
      description: "Include agent runs history when checking status",
    }),
  ),
  // list params
  limit: Type.Optional(
    Type.Number({
      description: "Max items to return (default: 20)",
    }),
  ),
});

// =============================================================================
// TOOL IMPLEMENTATION
// =============================================================================

export function createPipelineTool(): AnyAgentTool {
  return {
    label: "Pipeline",
    name: "pipeline",
    description: `Interact with the multi-agent pipeline for complex implementations.

ACTIONS:
- submit: Submit a goal for specialist agents to implement
- status: Check status of a work item (with optional agent run history)
- list: List recent work items in the pipeline

The pipeline runs specialized agents (PM, Architect, Senior Dev, etc.)
that work autonomously to implement complex features with TDD and code review.

SUBMIT PARAMS:
- goal: The goal/feature to implement (required)
- priority: Higher = more urgent (optional, default: 0)
- type: "project" | "epic" | "task" (optional, default: "project")

STATUS PARAMS:
- workItemId: UUID of the work item to check (required)
- deep: Include agent runs history (optional, default: false)

LIST PARAMS:
- limit: Max items to return (optional, default: 20)

EXAMPLE USAGE:
1. Submit a new goal:
   { "action": "submit", "goal": "Add user authentication with OAuth" }

2. Check status of a work item:
   { "action": "status", "workItemId": "abc-123", "deep": true }

3. List recent work items:
   { "action": "list", "limit": 10 }`,
    parameters: PipelineToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "submit":
          return handleSubmit(params);
        case "status":
          return handleStatus(params);
        case "list":
          return handleList(params);
        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}

// =============================================================================
// ACTION HANDLERS
// =============================================================================

async function handleSubmit(params: Record<string, unknown>) {
  const goal = readStringParam(params, "goal", { required: true });
  const priority = readNumberParam(params, "priority") ?? 0;
  const typeParam = readStringParam(params, "type") ?? "project";
  const type = WORK_TYPES.includes(typeParam as WorkType) ? (typeParam as WorkType) : "project";

  try {
    const db = getDB();

    // Test connectivity first
    const isConnected = await db.ping();
    if (!isConnected) {
      return jsonResult({
        error: "Pipeline database not available. Is the pipeline infrastructure running?",
        hint: "Run: docker compose -f docker-compose.pipeline.yml up -d",
      });
    }

    // Create the work item
    const workItem = await db.createWorkItem({
      type,
      title: goal.slice(0, 100),
      description: goal,
      assigned_agent: "pm" as AgentRole,
      priority,
    });

    // Publish event to PM queue
    try {
      const redis = getRedis();
      const redisConnected = await redis.ping();
      if (redisConnected) {
        await redis.publish({
          work_item_id: workItem.id,
          event_type: "goal_submitted",
          source_role: "pm" as AgentRole,
          target_role: "pm" as AgentRole,
          payload: { goal, priority },
        });
      }
    } catch (redisErr) {
      // Redis publish is best-effort; PM agent can still poll DB
      console.warn("[pipeline-tool] Redis publish failed:", (redisErr as Error).message);
    }

    return jsonResult({
      success: true,
      workItemId: workItem.id,
      status: workItem.status,
      type: workItem.type,
      message: "Goal submitted to pipeline. The PM agent will process it.",
    });
  } catch (err) {
    return jsonResult({
      error: `Failed to submit goal: ${(err as Error).message}`,
      hint: "Ensure pipeline infrastructure is running: docker compose -f docker-compose.pipeline.yml up -d",
    });
  }
}

async function handleStatus(params: Record<string, unknown>) {
  const workItemId = readStringParam(params, "workItemId", { required: true });
  const deep = params.deep === true;

  try {
    const db = getDB();

    // Test connectivity first
    const isConnected = await db.ping();
    if (!isConnected) {
      return jsonResult({
        error: "Pipeline database not available. Is the pipeline infrastructure running?",
        hint: "Run: docker compose -f docker-compose.pipeline.yml up -d",
      });
    }

    const workItem = await db.getWorkItem(workItemId);
    if (!workItem) {
      return jsonResult({ error: `Work item not found: ${workItemId}` });
    }

    const children = await db.getChildWorkItems(workItemId);
    const runs = deep ? await db.getAgentRuns(workItemId) : undefined;

    return jsonResult({
      workItem: {
        id: workItem.id,
        type: workItem.type,
        title: workItem.title,
        status: workItem.status,
        assigned_agent: workItem.assigned_agent,
        priority: workItem.priority,
        attempt_count: workItem.attempt_count,
        last_error: workItem.last_error,
        created_at: workItem.created_at,
        updated_at: workItem.updated_at,
        started_at: workItem.started_at,
        completed_at: workItem.completed_at,
      },
      children: children.map((child) => ({
        id: child.id,
        type: child.type,
        title: child.title,
        status: child.status,
        assigned_agent: child.assigned_agent,
      })),
      runs: runs?.map((run) => ({
        id: run.id,
        agent_role: run.agent_role,
        status: run.status,
        started_at: run.started_at,
        completed_at: run.completed_at,
        error: run.error,
      })),
    });
  } catch (err) {
    return jsonResult({
      error: `Failed to get status: ${(err as Error).message}`,
      hint: "Ensure pipeline infrastructure is running: docker compose -f docker-compose.pipeline.yml up -d",
    });
  }
}

async function handleList(params: Record<string, unknown>) {
  const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
  const clampedLimit = Math.min(Math.max(1, limit), 100);

  try {
    const db = getDB();

    // Test connectivity first
    const isConnected = await db.ping();
    if (!isConnected) {
      return jsonResult({
        error: "Pipeline database not available. Is the pipeline infrastructure running?",
        hint: "Run: docker compose -f docker-compose.pipeline.yml up -d",
      });
    }

    const items = await db.getRecentWorkItems(clampedLimit);

    return jsonResult({
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        status: item.status,
        assigned_agent: item.assigned_agent,
        priority: item.priority,
        created_at: item.created_at,
        updated_at: item.updated_at,
      })),
      count: items.length,
    });
  } catch (err) {
    return jsonResult({
      error: `Failed to list work items: ${(err as Error).message}`,
      hint: "Ensure pipeline infrastructure is running: docker compose -f docker-compose.pipeline.yml up -d",
    });
  }
}
