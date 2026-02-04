/**
 * Pipeline auto-start for gateway.
 *
 * When pipeline.autoStart is enabled, this module:
 * 1. Checks if Docker containers (Postgres + Redis) are running
 * 2. Starts them via docker compose if not running
 * 3. Starts the orchestrator daemon if not already running
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { loadConfig } from "../config/config.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const ORCHESTRATOR_PID_FILE = join(homedir(), ".openclaw", "orchestrator.pid");
const ORCHESTRATOR_LOG_FILE = join(homedir(), ".openclaw", "orchestrator.log");
const DEFAULT_COMPOSE_FILE = "docker-compose.pipeline.yml";

// =============================================================================
// TYPES
// =============================================================================

export interface PipelineStartResult {
  started: boolean;
  reason?: string;
  dockerStarted?: boolean;
  orchestratorStarted?: boolean;
  orchestratorPid?: number;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// =============================================================================
// HELPERS
// =============================================================================

function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function isDockerComposeAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["compose", "version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function areContainersRunning(composeFile: string, cwd: string): boolean {
  try {
    const result = spawnSync("docker", ["compose", "-f", composeFile, "ps", "--format", "json"], {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });

    if (result.status !== 0) {
      return false;
    }

    // Parse each line as JSON (docker compose outputs one JSON object per line)
    const output = result.stdout.trim();
    if (!output) {
      return false;
    }

    const lines = output.split("\n").filter(Boolean);
    if (lines.length === 0) {
      return false;
    }

    // Check if all containers are running
    for (const line of lines) {
      try {
        const container = JSON.parse(line);
        if (container.State !== "running") {
          return false;
        }
      } catch {
        // Line might not be JSON (e.g., header), skip
      }
    }

    return lines.length >= 2; // Expect at least postgres + redis
  } catch {
    return false;
  }
}

function startDockerContainers(composeFile: string, cwd: string, log: Logger): boolean {
  try {
    log.info(`starting pipeline containers via ${composeFile}`);

    const result = spawnSync("docker", ["compose", "-f", composeFile, "up", "-d"], {
      cwd,
      encoding: "utf-8",
      timeout: 60000, // 60s timeout for pulling images
    });

    if (result.status !== 0) {
      log.error(`failed to start containers: ${result.stderr || result.stdout}`);
      return false;
    }

    // Wait for containers to be healthy
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds
    while (attempts < maxAttempts) {
      if (areContainersRunning(composeFile, cwd)) {
        log.info("pipeline containers started");
        return true;
      }
      attempts++;
      // Sync sleep (acceptable during startup)
      spawnSync("sleep", ["1"]);
    }

    log.warn("containers started but not all are running");
    return false;
  } catch (err) {
    log.error(`docker compose failed: ${String(err)}`);
    return false;
  }
}

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

function getOrchestratorEntry(cwd: string): { entry: string; useTsx: boolean } {
  const distEntry = join(cwd, "dist", "orchestrator", "index.js");
  if (existsSync(distEntry)) {
    return { entry: distEntry, useTsx: false };
  }
  return { entry: join(cwd, "src", "orchestrator", "index.ts"), useTsx: true };
}

async function startOrchestrator(cwd: string, log: Logger): Promise<number | null> {
  try {
    const existingPid = getPidFromFile();
    if (existingPid && isProcessRunning(existingPid)) {
      log.info(`orchestrator already running (PID: ${existingPid})`);
      return existingPid;
    }

    // Clean up stale PID file
    removePidFile();

    const { entry, useTsx } = getOrchestratorEntry(cwd);

    if (!existsSync(entry.replace(".ts", ".ts")) && !existsSync(entry)) {
      log.warn(`orchestrator entry not found: ${entry}`);
      return null;
    }

    const args = useTsx ? ["--import", "tsx", entry] : [entry];

    // Ensure log directory exists
    const logDir = join(homedir(), ".openclaw");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const logFd = openSync(ORCHESTRATOR_LOG_FILE, "a");

    log.info("starting orchestrator daemon");

    const child = spawn("node", args, {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
      },
    });

    if (!child.pid) {
      log.error("failed to spawn orchestrator process");
      return null;
    }

    // Wait a moment to see if it crashes immediately
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (!isProcessRunning(child.pid)) {
      log.error(`orchestrator failed to start. Check logs: ${ORCHESTRATOR_LOG_FILE}`);
      return null;
    }

    writePidFile(child.pid);
    child.unref();

    log.info(`orchestrator started (PID: ${child.pid})`);
    return child.pid;
  } catch (err) {
    log.error(`failed to start orchestrator: ${String(err)}`);
    return null;
  }
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Start pipeline infrastructure and orchestrator if configured.
 */
export async function startPipelineIfEnabled(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: Logger;
  cwd?: string;
}): Promise<PipelineStartResult> {
  const { cfg, log } = params;
  const cwd = params.cwd ?? process.cwd();

  // Check if auto-start is enabled
  if (!cfg.pipeline?.autoStart) {
    return { started: false, reason: "pipeline.autoStart not enabled" };
  }

  // Check Docker availability
  if (!isDockerAvailable()) {
    log.warn("pipeline auto-start skipped: Docker not available");
    return { started: false, reason: "Docker not available" };
  }

  if (!isDockerComposeAvailable()) {
    log.warn("pipeline auto-start skipped: docker compose not available");
    return { started: false, reason: "docker compose not available" };
  }

  // Resolve compose file path
  const composeFile = cfg.pipeline?.composeFile ?? DEFAULT_COMPOSE_FILE;
  const composeFilePath = resolve(cwd, composeFile);

  if (!existsSync(composeFilePath)) {
    log.warn(`pipeline auto-start skipped: compose file not found: ${composeFilePath}`);
    return { started: false, reason: `compose file not found: ${composeFile}` };
  }

  let dockerStarted = false;
  let orchestratorStarted = false;
  let orchestratorPid: number | undefined;

  // Check if containers are already running
  if (!areContainersRunning(composeFile, cwd)) {
    dockerStarted = startDockerContainers(composeFile, cwd, log);
    if (!dockerStarted) {
      return {
        started: false,
        reason: "failed to start Docker containers",
        dockerStarted: false,
      };
    }
  } else {
    log.info("pipeline containers already running");
    dockerStarted = true;
  }

  // Start orchestrator
  const pid = await startOrchestrator(cwd, log);
  if (pid) {
    orchestratorStarted = true;
    orchestratorPid = pid;
  }

  return {
    started: dockerStarted && orchestratorStarted,
    dockerStarted,
    orchestratorStarted,
    orchestratorPid,
    reason: orchestratorStarted ? undefined : "orchestrator failed to start",
  };
}

/**
 * Stop pipeline orchestrator (containers are left running).
 */
export function stopPipelineOrchestrator(log: Logger): boolean {
  const pid = getPidFromFile();

  if (!pid || !isProcessRunning(pid)) {
    removePidFile();
    return true;
  }

  try {
    log.info("stopping orchestrator");
    process.kill(pid, "SIGTERM");

    // Wait for graceful shutdown
    let attempts = 0;
    while (attempts < 50) {
      // 10 seconds
      if (!isProcessRunning(pid)) {
        break;
      }
      attempts++;
      spawnSync("sleep", ["0.2"]);
    }

    // Force kill if still running
    if (isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
    }

    removePidFile();
    log.info("orchestrator stopped");
    return true;
  } catch (err) {
    log.error(`failed to stop orchestrator: ${String(err)}`);
    removePidFile();
    return false;
  }
}
