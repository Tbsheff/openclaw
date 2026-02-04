/**
 * Scaler
 *
 * Dynamically scales agent instances based on queue depth.
 */

import { EventEmitter } from "node:events";
import type { AgentRole } from "../events/types.js";
import type { Spawner } from "./spawner.js";
import { type RedisStreams, getRedis } from "../events/redis-streams.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ScalingConfig {
  role: AgentRole;
  minInstances: number;
  maxInstances: number;
  scaleUpThreshold: number; // Queue depth to trigger scale up
  scaleDownDelay: number; // Idle time before scale down (ms)
}

export interface ScalerConfig {
  checkIntervalMs?: number;
  scalingConfigs?: Partial<Record<AgentRole, Partial<ScalingConfig>>>;
}

// =============================================================================
// DEFAULTS
// =============================================================================

const DEFAULT_SCALING: Record<AgentRole, ScalingConfig> = {
  pm: { role: "pm", minInstances: 1, maxInstances: 1, scaleUpThreshold: 5, scaleDownDelay: 300000 },
  "domain-expert": {
    role: "domain-expert",
    minInstances: 0,
    maxInstances: 2,
    scaleUpThreshold: 3,
    scaleDownDelay: 300000,
  },
  architect: {
    role: "architect",
    minInstances: 1,
    maxInstances: 3,
    scaleUpThreshold: 3,
    scaleDownDelay: 300000,
  },
  "cto-review": {
    role: "cto-review",
    minInstances: 1,
    maxInstances: 2,
    scaleUpThreshold: 5,
    scaleDownDelay: 300000,
  },
  "senior-dev": {
    role: "senior-dev",
    minInstances: 1,
    maxInstances: 10,
    scaleUpThreshold: 2,
    scaleDownDelay: 60000,
  },
  "staff-engineer": {
    role: "staff-engineer",
    minInstances: 1,
    maxInstances: 5,
    scaleUpThreshold: 3,
    scaleDownDelay: 120000,
  },
  "code-simplifier": {
    role: "code-simplifier",
    minInstances: 1,
    maxInstances: 3,
    scaleUpThreshold: 5,
    scaleDownDelay: 180000,
  },
  "ui-review": {
    role: "ui-review",
    minInstances: 0,
    maxInstances: 2,
    scaleUpThreshold: 3,
    scaleDownDelay: 300000,
  },
  "ci-agent": {
    role: "ci-agent",
    minInstances: 1,
    maxInstances: 3,
    scaleUpThreshold: 3,
    scaleDownDelay: 180000,
  },
};

// =============================================================================
// SCALER
// =============================================================================

export class Scaler extends EventEmitter {
  private redis: RedisStreams;
  private spawner: Spawner;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private scalingConfigs: Record<AgentRole, ScalingConfig>;
  private idleTimers: Map<string, Date> = new Map(); // instanceId -> idle start time

  private readonly checkIntervalMs: number;

  constructor(spawner: Spawner, config: ScalerConfig = {}) {
    super();
    this.redis = getRedis();
    this.spawner = spawner;
    this.checkIntervalMs = config.checkIntervalMs ?? 30000; // 30s

    // Merge custom configs with defaults
    this.scalingConfigs = { ...DEFAULT_SCALING };
    if (config.scalingConfigs) {
      for (const [role, custom] of Object.entries(config.scalingConfigs)) {
        this.scalingConfigs[role as AgentRole] = {
          ...this.scalingConfigs[role as AgentRole],
          ...custom,
        };
      }
    }
  }

  /**
   * Start scaling checks.
   */
  start(): void {
    console.log("[scaler] Starting scaler");
    this.checkInterval = setInterval(() => this.checkScaling(), this.checkIntervalMs);
    // Initial check
    void this.checkScaling();
  }

  /**
   * Stop scaling checks.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[scaler] Scaler stopped");
  }

  /**
   * Check if scaling is needed for all roles.
   */
  private async checkScaling(): Promise<void> {
    for (const role of Object.keys(this.scalingConfigs) as AgentRole[]) {
      try {
        await this.checkRoleScaling(role);
      } catch (err) {
        console.error(`[scaler] Error checking ${role}:`, (err as Error).message);
      }
    }
  }

  /**
   * Check scaling for a specific role.
   */
  private async checkRoleScaling(role: AgentRole): Promise<void> {
    const config = this.scalingConfigs[role];
    const currentCount = this.spawner.countByRole(role);
    // Use pending + lag for scaling decisions
    // - pending = messages being processed by workers
    // - lag = messages not yet delivered (waiting to be read)
    const backlog = await this.redis.getQueueBacklog(role);
    const totalWork = backlog.pending + backlog.lag;

    // Scale up if queue is deep and we're under max
    // For roles with minInstances: 0, scale up if there's ANY work (pending or lag)
    // This prevents pipeline stalls when work arrives for idle-by-default roles
    const shouldScaleUp =
      (totalWork > config.scaleUpThreshold ||
        (config.minInstances === 0 && currentCount === 0 && totalWork > 0)) &&
      currentCount < config.maxInstances;

    if (shouldScaleUp) {
      const toSpawn = Math.min(
        config.maxInstances - currentCount,
        Math.max(1, Math.ceil(totalWork / config.scaleUpThreshold)),
      );

      for (let i = 0; i < toSpawn; i++) {
        const instanceId = `${role}-${Date.now()}-${i}`;
        this.spawner.spawn(role, instanceId);
        this.emit("scaleUp", { role, instanceId, totalWork, newCount: currentCount + i + 1 });
        console.log(
          `[scaler] Scaled up ${role} (total=${totalWork}, pending=${backlog.pending}, lag=${backlog.lag}, instances=${currentCount + i + 1})`,
        );
      }
    }

    // Scale down if queue is empty and we're over min
    if (totalWork === 0 && currentCount > config.minInstances) {
      const agents = this.spawner.getByRole(role);

      for (const agent of agents) {
        if (currentCount <= config.minInstances) {
          break;
        }

        // Track idle time
        if (!this.idleTimers.has(agent.instanceId)) {
          this.idleTimers.set(agent.instanceId, new Date());
        }

        const idleStart = this.idleTimers.get(agent.instanceId)!;
        const idleTime = Date.now() - idleStart.getTime();

        if (idleTime > config.scaleDownDelay) {
          await this.spawner.stop(agent.instanceId);
          this.idleTimers.delete(agent.instanceId);
          this.emit("scaleDown", { role, instanceId: agent.instanceId, idleTime });
          console.log(`[scaler] Scaled down ${role} (idle=${Math.round(idleTime / 1000)}s)`);
        }
      }
    } else {
      // Clear idle timers if queue is not empty
      for (const agent of this.spawner.getByRole(role)) {
        this.idleTimers.delete(agent.instanceId);
      }
    }
  }

  /**
   * Get current scaling status.
   */
  getStatus(): Record<AgentRole, { current: number; min: number; max: number }> {
    const status: Record<string, { current: number; min: number; max: number }> = {};

    for (const role of Object.keys(this.scalingConfigs) as AgentRole[]) {
      const config = this.scalingConfigs[role];
      status[role] = {
        current: this.spawner.countByRole(role),
        min: config.minInstances,
        max: config.maxInstances,
      };
    }

    return status as Record<AgentRole, { current: number; min: number; max: number }>;
  }
}
