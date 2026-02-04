/**
 * Orchestrator
 *
 * Main entry point for the multi-agent pipeline.
 * Coordinates spawning, health monitoring, scaling, and orphan detection.
 */

import type { AgentRole } from "../events/types.js";
import { getDB, closeDB } from "../db/postgres.js";
import { getRedis, closeRedis } from "../events/redis-streams.js";
import { HealthMonitor } from "./health.js";
import { OrphanDetector } from "./orphan.js";
import { Scaler } from "./scaler.js";
import { Spawner } from "./spawner.js";

// =============================================================================
// TYPES
// =============================================================================

export interface OrchestratorConfig {
  autoSpawnAgents?: boolean;
  agentRunnerPath?: string;
}

// =============================================================================
// ORCHESTRATOR
// =============================================================================

export class Orchestrator {
  private spawner: Spawner;
  private healthMonitor: HealthMonitor;
  private scaler: Scaler;
  private orphanDetector: OrphanDetector;
  private shutdownRequested = false;

  constructor(config: OrchestratorConfig = {}) {
    this.spawner = new Spawner({
      agentRunnerPath: config.agentRunnerPath,
    });
    this.healthMonitor = new HealthMonitor(this.spawner);
    this.scaler = new Scaler(this.spawner);
    this.orphanDetector = new OrphanDetector();

    // Wire up events
    this.spawner.on("exit", ({ role: _role, instanceId, code }) => {
      console.log(`[orchestrator] Agent ${instanceId} exited with code ${code}`);
    });

    this.healthMonitor.on("restarted", ({ role, oldInstanceId, newInstanceId }) => {
      console.log(`[orchestrator] Restarted ${role}: ${oldInstanceId} -> ${newInstanceId}`);
    });

    this.healthMonitor.on("restartFailed", ({ role, instanceId: _instanceId, attempts }) => {
      console.error(`[orchestrator] Failed to restart ${role} after ${attempts} attempts`);
    });

    this.scaler.on("scaleUp", ({ role, instanceId: _instanceId, queueDepth }) => {
      console.log(`[orchestrator] Scaled up ${role} (queue depth: ${queueDepth})`);
    });

    this.scaler.on("scaleDown", ({ role, instanceId: _instanceId, idleTime }) => {
      console.log(`[orchestrator] Scaled down ${role} (idle: ${Math.round(idleTime / 1000)}s)`);
    });

    // Setup shutdown handlers
    this.setupShutdownHandlers();
  }

  /**
   * Start the orchestrator.
   */
  async start(): Promise<void> {
    console.log("[orchestrator] Starting...");

    // Verify connections
    const redis = getRedis();
    const db = getDB();

    const redisPing = await redis.ping();
    if (!redisPing) {
      throw new Error("Failed to connect to Redis");
    }
    console.log("[orchestrator] Redis connected");

    const dbPing = await db.ping();
    if (!dbPing) {
      throw new Error("Failed to connect to PostgreSQL");
    }
    console.log("[orchestrator] PostgreSQL connected");

    // Ensure consumer groups exist
    await redis.ensureAllGroups();
    console.log("[orchestrator] Consumer groups ready");

    // Spawn initial agents (min instances for each role)
    await this.spawnInitialAgents();

    // Start monitoring
    this.healthMonitor.start();
    this.scaler.start();
    this.orphanDetector.start();

    console.log("[orchestrator] Started");
  }

  /**
   * Spawn initial agent instances.
   */
  private async spawnInitialAgents(): Promise<void> {
    const initialRoles: Array<{ role: AgentRole; count: number }> = [
      { role: "pm", count: 1 },
      { role: "architect", count: 1 },
      { role: "cto-review", count: 1 },
      { role: "senior-dev", count: 1 },
      { role: "staff-engineer", count: 1 },
      { role: "code-simplifier", count: 1 },
      { role: "ci-agent", count: 1 },
    ];

    for (const { role, count } of initialRoles) {
      for (let i = 0; i < count; i++) {
        const instanceId = `${role}-${Date.now()}-${i}`;
        this.spawner.spawn(role, instanceId);
      }
    }

    console.log(`[orchestrator] Spawned ${initialRoles.length} initial agents`);
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownRequested) {
      return;
    }
    this.shutdownRequested = true;

    console.log("[orchestrator] Shutting down...");

    // Stop monitoring
    this.healthMonitor.stop();
    this.scaler.stop();
    this.orphanDetector.stop();

    // Stop all agents
    await this.spawner.stopAll(10000);

    // Close connections
    await closeRedis();
    await closeDB();

    console.log("[orchestrator] Shutdown complete");
  }

  /**
   * Get orchestrator status.
   */
  getStatus(): {
    running: boolean;
    agents: ReturnType<Spawner["getRunning"]>;
    scaling: ReturnType<Scaler["getStatus"]>;
  } {
    return {
      running: !this.shutdownRequested,
      agents: this.spawner.getRunning(),
      scaling: this.scaler.getStatus(),
    };
  }

  private setupShutdownHandlers(): void {
    const handler = async (signal: string) => {
      console.log(`[orchestrator] Received ${signal}`);
      await this.shutdown();
      process.exit(0);
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const orchestrator = new Orchestrator();
  await orchestrator.start();

  // Keep running
  console.log("[orchestrator] Running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[orchestrator] Fatal error:", err);
  process.exit(1);
});
