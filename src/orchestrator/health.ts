/**
 * Health Monitor
 *
 * Monitors agent heartbeats and restarts crashed agents.
 */

import { EventEmitter } from "node:events";
import type { AgentRole } from "../events/types.js";
import type { Spawner } from "./spawner.js";
import { type PipelineDB, getDB } from "../db/postgres.js";

// =============================================================================
// TYPES
// =============================================================================

export interface HealthConfig {
  checkIntervalMs?: number;
  staleThresholdMs?: number;
  maxRestartAttempts?: number;
}

interface RestartTracker {
  role: AgentRole;
  instanceId: string;
  attempts: number;
  lastAttempt: Date;
}

// =============================================================================
// HEALTH MONITOR
// =============================================================================

export class HealthMonitor extends EventEmitter {
  private db: PipelineDB;
  private spawner: Spawner;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private restartTrackers: Map<string, RestartTracker> = new Map();

  private readonly checkIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly maxRestartAttempts: number;

  constructor(spawner: Spawner, config: HealthConfig = {}) {
    super();
    this.db = getDB();
    this.spawner = spawner;
    this.checkIntervalMs = config.checkIntervalMs ?? 15000; // 15s
    this.staleThresholdMs = config.staleThresholdMs ?? 30000; // 30s
    this.maxRestartAttempts = config.maxRestartAttempts ?? 3;
  }

  /**
   * Start health monitoring.
   */
  start(): void {
    console.log("[health] Starting health monitor");
    this.checkInterval = setInterval(() => this.checkHealth(), this.checkIntervalMs);
    // Initial check
    void this.checkHealth();
  }

  /**
   * Stop health monitoring.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[health] Health monitor stopped");
  }

  /**
   * Perform health check on all agents.
   */
  private async checkHealth(): Promise<void> {
    try {
      // Get stale heartbeats
      const staleHeartbeats = await this.db.getStaleHeartbeats(this.staleThresholdMs);

      for (const heartbeat of staleHeartbeats) {
        const instanceId = heartbeat.instance_id;

        // Restart stale agents regardless of spawner state - hung agents report stale heartbeats
        // but may still appear running. Kill first if running, then restart.
        console.log(`[health] Agent ${instanceId} is stale, attempting restart`);
        await this.attemptRestart(heartbeat.agent_role, instanceId);
      }

      // Also check spawner's view of running processes
      const running = this.spawner.getRunning();
      for (const agent of running) {
        // Verify the process is still alive
        try {
          // Sending signal 0 checks if process exists without killing it
          process.kill(agent.pid, 0);
        } catch {
          // Process doesn't exist
          console.log(`[health] Agent ${agent.instanceId} (PID ${agent.pid}) is dead`);
          await this.attemptRestart(agent.role, agent.instanceId);
        }
      }
    } catch (err) {
      console.error("[health] Health check error:", (err as Error).message);
    }
  }

  /**
   * Attempt to restart a failed agent.
   */
  private async attemptRestart(role: AgentRole, instanceId: string): Promise<void> {
    const trackerId = `${role}:${instanceId}`;
    let tracker = this.restartTrackers.get(trackerId);

    if (!tracker) {
      tracker = {
        role,
        instanceId,
        attempts: 0,
        lastAttempt: new Date(0),
      };
      this.restartTrackers.set(trackerId, tracker);
    }

    // Check if we've exceeded max restart attempts
    const timeSinceLastAttempt = Date.now() - tracker.lastAttempt.getTime();
    if (timeSinceLastAttempt > 60000) {
      // Reset counter if it's been more than a minute
      tracker.attempts = 0;
    }

    if (tracker.attempts >= this.maxRestartAttempts) {
      console.error(`[health] Agent ${instanceId} exceeded max restart attempts`);
      this.emit("restartFailed", { role, instanceId, attempts: tracker.attempts });
      return;
    }

    // Remove stale heartbeat
    await this.db.removeHeartbeat(role, instanceId);

    // Stop existing process (if any)
    await this.spawner.stop(instanceId, 1000);

    // Spawn new instance
    tracker.attempts++;
    tracker.lastAttempt = new Date();

    try {
      const newInstanceId = `${role}-${Date.now()}`;
      this.spawner.spawn(role, newInstanceId);
      this.emit("restarted", { role, oldInstanceId: instanceId, newInstanceId });
      console.log(`[health] Restarted agent: ${role} as ${newInstanceId}`);
    } catch (err) {
      console.error(`[health] Failed to restart ${role}:`, (err as Error).message);
      this.emit("restartError", { role, instanceId, error: err });
    }
  }

  /**
   * Reset restart counter for an agent (call when agent is healthy).
   */
  resetRestartCounter(instanceId: string): void {
    for (const [key, tracker] of this.restartTrackers.entries()) {
      if (tracker.instanceId === instanceId) {
        this.restartTrackers.delete(key);
        break;
      }
    }
  }
}
