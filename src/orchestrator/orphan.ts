/**
 * Orphan Detector
 *
 * Reclaims stuck work items via XAUTOCLAIM.
 */

import { EventEmitter } from "node:events";
import type { AgentRole } from "../events/types.js";
import { type RedisStreams, getRedis } from "../events/redis-streams.js";

// =============================================================================
// TYPES
// =============================================================================

export interface OrphanConfig {
  checkIntervalMs?: number;
}

// =============================================================================
// ORPHAN DETECTOR
// =============================================================================

export class OrphanDetector extends EventEmitter {
  private redis: RedisStreams;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  private readonly checkIntervalMs: number;
  private readonly roles: AgentRole[] = [
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

  constructor(config: OrphanConfig = {}) {
    super();
    this.redis = getRedis();
    this.checkIntervalMs = config.checkIntervalMs ?? 60000; // 60s
  }

  /**
   * Start orphan detection.
   */
  start(): void {
    console.log("[orphan] Starting orphan detector");
    this.checkInterval = setInterval(() => this.checkOrphans(), this.checkIntervalMs);
    // Initial check
    void this.checkOrphans();
  }

  /**
   * Stop orphan detection.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[orphan] Orphan detector stopped");
  }

  /**
   * Check for orphaned messages across all roles.
   * Reclaimed messages are requeued to the same queue and acked.
   */
  private async checkOrphans(): Promise<void> {
    let totalReclaimed = 0;

    for (const role of this.roles) {
      try {
        const reclaimed = await this.redis.reclaimOrphans(role);
        if (reclaimed.length > 0) {
          totalReclaimed += reclaimed.length;
          // Requeue each reclaimed message back to the same queue so workers can pick it up
          for (const { streamId, message } of reclaimed) {
            await this.redis.requeueMessage(role, streamId, message);
            this.emit("reclaimed", { role, streamId, message });
          }
        }
      } catch (err) {
        console.error(`[orphan] Error checking ${role}:`, (err as Error).message);
      }
    }

    if (totalReclaimed > 0) {
      console.log(`[orphan] Reclaimed ${totalReclaimed} orphaned messages`);
    }
  }

  /**
   * Force reclaim for a specific role.
   * Returns the reclaimed messages.
   */
  async reclaimForRole(role: AgentRole) {
    return this.redis.reclaimOrphans(role);
  }
}
