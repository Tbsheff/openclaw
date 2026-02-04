/**
 * Pipeline CLI
 *
 * Commands for interacting with the multi-agent pipeline.
 * - submit: Submit a goal to the PM agent
 * - status: Check pipeline status for a work item
 */

import type { Command } from "commander";
import type { WorkStatus } from "../db/postgres.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable, type TableColumn } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { createCliProgress } from "./progress.js";

// =============================================================================
// HELPERS
// =============================================================================

function formatStatus(status: WorkStatus): string {
  const colors: Record<WorkStatus, (s: string) => string> = {
    pending: theme.muted,
    in_progress: theme.accent,
    review: theme.warn,
    blocked: theme.error,
    done: theme.success,
    failed: theme.error,
  };
  const fn = colors[status] ?? theme.muted;
  return fn(status);
}

function formatDate(date: Date | null): string {
  if (!date) {
    return "-";
  }
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60000) {
    return "just now";
  }
  if (diff < 3600000) {
    return `${Math.floor(diff / 60000)}m ago`;
  }
  if (diff < 86400000) {
    return `${Math.floor(diff / 3600000)}h ago`;
  }
  return date.toISOString().split("T")[0];
}

// =============================================================================
// COMMANDS
// =============================================================================

async function runPipelineSubmit(
  goal: string,
  opts: { json: boolean; priority: string; type: string },
): Promise<void> {
  const progress = createCliProgress({ label: "Submitting goal to pipeline..." });

  try {
    const { getDB, closeDB } = await import("../db/postgres.js");
    const { getRedis, closeRedis } = await import("../events/redis-streams.js");

    const db = getDB();
    const redis = getRedis();

    // Verify connections
    const dbOk = await db.ping();
    const redisOk = await redis.ping();

    if (!dbOk || !redisOk) {
      throw new Error("Failed to connect to database or Redis. Is the pipeline running?");
    }

    // Create work item
    const priority = parseInt(opts.priority, 10);
    const workItem = await db.createWorkItem({
      type: opts.type as "project" | "epic" | "task",
      title: goal.slice(0, 100),
      description: goal,
      assigned_agent: "pm",
      priority: Number.isFinite(priority) ? priority : 0,
    });

    // Publish event to PM agent queue
    await redis.publish({
      work_item_id: workItem.id,
      event_type: "goal_submitted",
      source_role: "pm", // Self-assign for initial processing
      target_role: "pm",
      payload: { goal, priority: workItem.priority },
    });

    await closeRedis();
    await closeDB();

    progress.done();

    if (opts.json) {
      console.log(
        JSON.stringify({
          success: true,
          workItemId: workItem.id,
          status: workItem.status,
          createdAt: workItem.created_at.toISOString(),
        }),
      );
    } else {
      console.log(theme.success("Goal submitted successfully!"));
      console.log();
      console.log(`  ${theme.accent("Work Item ID:")} ${workItem.id}`);
      console.log(`  ${theme.accent("Status:")} ${formatStatus(workItem.status)}`);
      console.log(`  ${theme.accent("Assigned:")} ${workItem.assigned_agent ?? "pm"}`);
      console.log();
      console.log(theme.muted(`Check status with: openclaw pipeline status ${workItem.id}`));
    }
  } catch (err) {
    progress.done();
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: (err as Error).message }));
    } else {
      console.error(theme.error(`Failed to submit goal: ${(err as Error).message}`));
    }
    process.exit(1);
  }
}

async function runPipelineStatus(
  workItemId: string | undefined,
  opts: { json: boolean; deep: boolean },
): Promise<void> {
  const progress = createCliProgress({ label: "Fetching pipeline status..." });

  try {
    const { getDB, closeDB } = await import("../db/postgres.js");
    const db = getDB();

    // Verify connection
    const dbOk = await db.ping();
    if (!dbOk) {
      throw new Error("Failed to connect to database. Is the pipeline running?");
    }

    if (workItemId) {
      // Get specific work item
      const workItem = await db.getWorkItem(workItemId);
      if (!workItem) {
        throw new Error(`Work item not found: ${workItemId}`);
      }

      // Get child items
      const children = await db.getChildWorkItems(workItemId);

      // Get agent runs if deep
      const runs = opts.deep ? await db.getAgentRuns(workItemId) : [];

      await closeDB();
      progress.done();

      if (opts.json) {
        console.log(
          JSON.stringify({
            workItem,
            children,
            runs: opts.deep ? runs : undefined,
          }),
        );
        return;
      }

      // Display work item details
      console.log(theme.accent("Work Item:"));
      console.log(`  ${theme.muted("ID:")} ${workItem.id}`);
      console.log(`  ${theme.muted("Title:")} ${workItem.title}`);
      console.log(`  ${theme.muted("Type:")} ${workItem.type}`);
      console.log(`  ${theme.muted("Status:")} ${formatStatus(workItem.status)}`);
      console.log(`  ${theme.muted("Assigned:")} ${workItem.assigned_agent ?? "-"}`);
      console.log(`  ${theme.muted("Priority:")} ${workItem.priority}`);
      console.log(`  ${theme.muted("Created:")} ${formatDate(workItem.created_at)}`);
      if (workItem.started_at) {
        console.log(`  ${theme.muted("Started:")} ${formatDate(workItem.started_at)}`);
      }
      if (workItem.completed_at) {
        console.log(`  ${theme.muted("Completed:")} ${formatDate(workItem.completed_at)}`);
      }
      if (workItem.last_error) {
        console.log(`  ${theme.muted("Error:")} ${theme.error(workItem.last_error)}`);
      }

      // Display children
      if (children.length > 0) {
        console.log("\n" + theme.accent("Child Items:"));
        const childColumns: TableColumn[] = [
          { key: "id", header: "ID", minWidth: 10 },
          { key: "title", header: "Title", minWidth: 20, flex: true },
          { key: "type", header: "Type", minWidth: 8 },
          { key: "status", header: "Status", minWidth: 12 },
          { key: "assigned", header: "Assigned", minWidth: 15 },
        ];
        const childRows = children.map((c) => ({
          id: c.id.slice(0, 8),
          title: c.title.slice(0, 40),
          type: c.type,
          status: c.status,
          assigned: c.assigned_agent ?? "-",
        }));
        console.log(
          renderTable({
            columns: childColumns,
            rows: childRows,
            width: process.stdout.columns || 80,
          }),
        );
      }

      // Display agent runs if deep
      if (opts.deep && runs.length > 0) {
        console.log(theme.accent("Agent Runs:"));
        const runColumns: TableColumn[] = [
          { key: "agent", header: "Agent", minWidth: 15 },
          { key: "status", header: "Status", minWidth: 12 },
          { key: "started", header: "Started", minWidth: 12 },
          { key: "completed", header: "Completed", minWidth: 12 },
        ];
        const runRows = runs.map((r) => ({
          agent: r.agent_role,
          status: r.status,
          started: formatDate(r.started_at),
          completed: formatDate(r.completed_at),
        }));
        console.log(
          renderTable({ columns: runColumns, rows: runRows, width: process.stdout.columns || 80 }),
        );
      }
    } else {
      // List all recent work items
      const items = await db.getRecentWorkItems(20);

      await closeDB();
      progress.done();

      if (opts.json) {
        console.log(JSON.stringify({ items }));
        return;
      }

      if (items.length === 0) {
        console.log(theme.muted("No work items found."));
        console.log(theme.muted("\nSubmit a goal with: openclaw pipeline submit <goal>"));
        return;
      }

      console.log(theme.accent("Recent Work Items:"));
      const columns: TableColumn[] = [
        { key: "id", header: "ID", minWidth: 10 },
        { key: "title", header: "Title", minWidth: 30, flex: true },
        { key: "status", header: "Status", minWidth: 12 },
        { key: "assigned", header: "Assigned", minWidth: 15 },
        { key: "created", header: "Created", minWidth: 12 },
      ];
      const rows = items.map((item) => ({
        id: item.id.slice(0, 8),
        title: item.title.slice(0, 50),
        status: item.status,
        assigned: item.assigned_agent ?? "-",
        created: formatDate(item.created_at),
      }));
      console.log(renderTable({ columns, rows, width: process.stdout.columns || 80 }));
    }
  } catch (err) {
    progress.done();
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: (err as Error).message }));
    } else {
      console.error(theme.error(`Failed to get status: ${(err as Error).message}`));
    }
    process.exit(1);
  }
}

// =============================================================================
// REGISTRATION
// =============================================================================

export function registerPipelineCli(program: Command): void {
  const pipeline = program
    .command("pipeline")
    .description("Interact with the multi-agent pipeline")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/multi-agent-pipeline", "docs.openclaw.ai/multi-agent-pipeline")}\n`,
    );

  pipeline
    .command("submit <goal>")
    .description("Submit a goal to the PM agent")
    .option("--json", "Output JSON", false)
    .option("--priority <n>", "Priority (higher = more urgent)", "0")
    .option("--type <type>", "Work type (project, epic, task)", "project")
    .action(async (goal, opts) => {
      await runPipelineSubmit(goal, opts);
    });

  pipeline
    .command("status [work-item-id]")
    .description("Check pipeline status (optionally for a specific work item)")
    .option("--json", "Output JSON", false)
    .option("--deep", "Show agent runs and detailed history", false)
    .action(async (workItemId, opts) => {
      await runPipelineStatus(workItemId, opts);
    });
}
