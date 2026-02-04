/**
 * Orchestrator CLI
 *
 * Commands for managing the multi-agent pipeline orchestrator.
 * - start: Start the orchestrator daemon
 * - stop: Graceful shutdown
 * - status: Show agent health and queue depths
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRole } from "../events/types.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable, type TableColumn } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { createCliProgress } from "./progress.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const ORCHESTRATOR_PID_FILE = join(homedir(), ".openclaw", "orchestrator.pid");
const ORCHESTRATOR_LOG_FILE = join(homedir(), ".openclaw", "orchestrator.log");
const ORCHESTRATOR_ENTRY = "src/orchestrator/index.ts";

// =============================================================================
// HELPERS
// =============================================================================

function getPidFromFile(): number | null {
  try {
    if (!existsSync(ORCHESTRATOR_PID_FILE)) {
      return null;
    }
    const content = readFileSync(ORCHESTRATOR_PID_FILE, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pid: number): void {
  const dir = join(homedir(), ".openclaw");
  if (!existsSync(dir)) {
    const { mkdirSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(ORCHESTRATOR_PID_FILE, pid.toString(), "utf-8");
}

function removePidFile(): void {
  try {
    if (existsSync(ORCHESTRATOR_PID_FILE)) {
      unlinkSync(ORCHESTRATOR_PID_FILE);
    }
  } catch {
    // Ignore
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getOrchestratorStatus(): Promise<{
  running: boolean;
  pid: number | null;
  agents: Array<{ role: AgentRole; instanceId: string; pid: number; uptime: string }>;
  queues: Array<{ role: AgentRole; pending: number; lag: number; total: number }>;
  scaling: Record<AgentRole, { current: number; min: number; max: number }>;
}> {
  const pid = getPidFromFile();
  const running = pid !== null && isProcessRunning(pid);

  if (!running) {
    return {
      running: false,
      pid: null,
      agents: [],
      queues: [],
      scaling: {} as Record<AgentRole, { current: number; min: number; max: number }>,
    };
  }

  // Try to get live status via Redis and DB
  try {
    const { getRedis, closeRedis } = await import("../events/redis-streams.js");
    const { getDB, closeDB } = await import("../db/postgres.js");

    const redis = getRedis();
    const db = getDB();

    const roles: AgentRole[] = [
      "pm",
      "domain-expert",
      "architect",
      "cto-review",
      "senior-dev",
      "staff-engineer",
      "code-simplifier",
      "ui-review",
      "ci-agent",
    ];

    // Get queue backlogs
    const queues = await Promise.all(
      roles.map(async (role) => {
        const backlog = await redis.getQueueBacklog(role);
        return { role, ...backlog };
      }),
    );

    // Get agent heartbeats (active agents)
    const heartbeatsFormatted = await db.getAllHeartbeats();

    const now = Date.now();
    const agents = heartbeatsFormatted.map((h) => {
      const uptimeMs = now - new Date(h.last_heartbeat).getTime();
      const uptimeMin = Math.floor(uptimeMs / 60000);
      const uptime =
        uptimeMin < 60 ? `${uptimeMin}m` : `${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m`;
      return {
        role: h.agent_role,
        instanceId: h.instance_id,
        pid: h.pid ?? 0,
        uptime,
      };
    });

    // Build scaling status from heartbeats
    const scaling: Record<string, { current: number; min: number; max: number }> = {};
    for (const role of roles) {
      const count = agents.filter((a) => a.role === role).length;
      // Use default scaling configs (same as scaler.ts)
      const defaults: Record<AgentRole, { min: number; max: number }> = {
        pm: { min: 1, max: 1 },
        "domain-expert": { min: 0, max: 2 },
        architect: { min: 1, max: 3 },
        "cto-review": { min: 1, max: 2 },
        "senior-dev": { min: 1, max: 10 },
        "staff-engineer": { min: 1, max: 5 },
        "code-simplifier": { min: 1, max: 3 },
        "ui-review": { min: 0, max: 2 },
        "ci-agent": { min: 1, max: 3 },
      };
      scaling[role] = {
        current: count,
        min: defaults[role]?.min ?? 0,
        max: defaults[role]?.max ?? 1,
      };
    }

    await closeRedis();
    await closeDB();

    return {
      running: true,
      pid,
      agents,
      queues,
      scaling: scaling as Record<AgentRole, { current: number; min: number; max: number }>,
    };
  } catch {
    // Connections failed, but orchestrator process may still be running
    return {
      running: true,
      pid,
      agents: [],
      queues: [],
      scaling: {} as Record<AgentRole, { current: number; min: number; max: number }>,
    };
  }
}

// =============================================================================
// COMMANDS
// =============================================================================

async function runOrchestratorStart(opts: { json: boolean; foreground: boolean }): Promise<void> {
  const existingPid = getPidFromFile();
  if (existingPid && isProcessRunning(existingPid)) {
    if (opts.json) {
      console.log(
        JSON.stringify({ success: false, error: "Orchestrator already running", pid: existingPid }),
      );
    } else {
      console.log(theme.warn(`Orchestrator already running (PID: ${existingPid})`));
    }
    return;
  }

  // Clean up stale PID file
  removePidFile();

  if (opts.foreground) {
    // Run in foreground (blocking)
    if (!opts.json) {
      console.log(theme.accent("Starting orchestrator in foreground..."));
    }
    const { Orchestrator } = await import("../orchestrator/index.js");
    const orchestrator = new Orchestrator();
    await orchestrator.start();
    return;
  }

  // Start as background daemon
  const progress = createCliProgress({ label: "Starting orchestrator..." });

  try {
    const child = spawn("node", ["--import", "tsx", ORCHESTRATOR_ENTRY], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
      },
    });

    if (!child.pid) {
      throw new Error("Failed to spawn orchestrator process");
    }

    // Capture initial output for error detection
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Wait a moment to see if it crashes immediately
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (!isProcessRunning(child.pid)) {
      throw new Error(`Orchestrator failed to start: ${stderr || "Unknown error"}`);
    }

    writePidFile(child.pid);
    child.unref();

    progress.done();

    if (opts.json) {
      console.log(JSON.stringify({ success: true, pid: child.pid }));
    } else {
      console.log(theme.success(`Orchestrator started (PID: ${child.pid})`));
      console.log(theme.muted(`Logs: ${ORCHESTRATOR_LOG_FILE}`));
    }
  } catch (err) {
    progress.done();
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: (err as Error).message }));
    } else {
      console.error(theme.error(`Failed to start orchestrator: ${(err as Error).message}`));
    }
    process.exit(1);
  }
}

async function runOrchestratorStop(opts: { json: boolean; force: boolean }): Promise<void> {
  const pid = getPidFromFile();

  if (!pid || !isProcessRunning(pid)) {
    removePidFile();
    if (opts.json) {
      console.log(JSON.stringify({ success: true, message: "Orchestrator not running" }));
    } else {
      console.log(theme.muted("Orchestrator not running"));
    }
    return;
  }

  const progress = createCliProgress({ label: "Stopping orchestrator..." });

  try {
    // Send signal
    const signal = opts.force ? "SIGKILL" : "SIGTERM";
    process.kill(pid, signal);

    // Wait for process to exit
    const timeout = opts.force ? 1000 : 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isProcessRunning(pid)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Force kill if still running
    if (isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    removePidFile();
    progress.done();

    if (opts.json) {
      console.log(JSON.stringify({ success: true, pid }));
    } else {
      console.log(theme.success("Orchestrator stopped"));
    }
  } catch (err) {
    progress.done();
    removePidFile();
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: (err as Error).message }));
    } else {
      console.error(theme.error(`Failed to stop orchestrator: ${(err as Error).message}`));
    }
  }
}

async function runOrchestratorStatus(opts: { json: boolean }): Promise<void> {
  const progress = createCliProgress({ label: "Checking orchestrator status..." });
  const status = await getOrchestratorStatus();
  progress.done();

  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Header
  if (status.running) {
    console.log(theme.success(`Orchestrator running (PID: ${status.pid})`));
  } else {
    console.log(theme.warn("Orchestrator not running"));
    console.log(theme.muted("\nRun 'openclaw orchestrator start' to start the orchestrator."));
    return;
  }

  // Agent health table
  if (status.agents.length > 0) {
    console.log("\n" + theme.accent("Agent Health:"));
    const agentColumns: TableColumn[] = [
      { key: "role", header: "Role", minWidth: 15 },
      { key: "instanceId", header: "Instance", minWidth: 20, flex: true },
      { key: "pid", header: "PID", align: "right", minWidth: 8 },
      { key: "uptime", header: "Uptime", align: "right", minWidth: 10 },
    ];
    const agentRows = status.agents.map((a) => ({
      role: a.role,
      instanceId: a.instanceId,
      pid: a.pid.toString(),
      uptime: a.uptime,
    }));
    console.log(
      renderTable({ columns: agentColumns, rows: agentRows, width: process.stdout.columns || 80 }),
    );
  }

  // Queue depths table
  if (status.queues.length > 0) {
    console.log(theme.accent("Queue Depths:"));
    const queueColumns: TableColumn[] = [
      { key: "role", header: "Queue", minWidth: 15 },
      { key: "pending", header: "Pending", align: "right", minWidth: 10 },
      { key: "lag", header: "Lag", align: "right", minWidth: 10 },
      { key: "total", header: "Total", align: "right", minWidth: 10 },
    ];
    const queueRows = status.queues.map((q) => ({
      role: q.role,
      pending: q.pending.toString(),
      lag: q.lag.toString(),
      total: q.total.toString(),
    }));
    console.log(
      renderTable({ columns: queueColumns, rows: queueRows, width: process.stdout.columns || 80 }),
    );
  }

  // Scaling status
  if (Object.keys(status.scaling).length > 0) {
    console.log(theme.accent("Scaling Status:"));
    const scalingColumns: TableColumn[] = [
      { key: "role", header: "Role", minWidth: 15 },
      { key: "current", header: "Current", align: "right", minWidth: 10 },
      { key: "min", header: "Min", align: "right", minWidth: 8 },
      { key: "max", header: "Max", align: "right", minWidth: 8 },
    ];
    const scalingRows = Object.entries(status.scaling).map(([role, s]) => ({
      role,
      current: s.current.toString(),
      min: s.min.toString(),
      max: s.max.toString(),
    }));
    console.log(
      renderTable({
        columns: scalingColumns,
        rows: scalingRows,
        width: process.stdout.columns || 80,
      }),
    );
  }
}

// =============================================================================
// REGISTRATION
// =============================================================================

export function registerOrchestratorCli(program: Command): void {
  const orchestrator = program
    .command("orchestrator")
    .description("Manage the multi-agent pipeline orchestrator")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/multi-agent-pipeline", "docs.openclaw.ai/multi-agent-pipeline")}\n`,
    );

  orchestrator
    .command("start")
    .description("Start the orchestrator daemon")
    .option("--json", "Output JSON", false)
    .option("--foreground", "Run in foreground (blocking)", false)
    .action(async (opts) => {
      await runOrchestratorStart(opts);
    });

  orchestrator
    .command("stop")
    .description("Graceful shutdown of the orchestrator")
    .option("--json", "Output JSON", false)
    .option("--force", "Force kill immediately", false)
    .action(async (opts) => {
      await runOrchestratorStop(opts);
    });

  orchestrator
    .command("status")
    .description("Show agent health and queue depths")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runOrchestratorStatus(opts);
    });
}
