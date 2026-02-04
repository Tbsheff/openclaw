/**
 * Base class for all pipeline agents.
 *
 * Provides:
 * - Redis Streams connection for event pub/sub
 * - PostgreSQL connection for state management
 * - Graceful shutdown handling
 * - Heartbeat reporting
 * - Work item lifecycle methods
 */

import { hostname } from "node:os";
import { type PipelineDB, type WorkItem, type WorkStatus, getDB, closeDB } from "../db/postgres.js";
import {
  type AgentRole,
  type EventType,
  type PublishEventInput,
  type StreamMessage,
  getRedis,
  closeRedis,
  type RedisStreams,
} from "../events/index.js";

// =============================================================================
// TYPES
// =============================================================================

export interface AgentConfig {
  role: AgentRole;
  instanceId?: string;
  heartbeatIntervalMs?: number;
  redisHost?: string;
  redisPort?: number;
  postgresHost?: string;
  postgresPort?: number;
}

// =============================================================================
// BASE AGENT
// =============================================================================

export abstract class BaseAgent {
  readonly role: AgentRole;
  readonly instanceId: string;

  protected redis: RedisStreams;
  protected db: PipelineDB;

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private currentWorkItemId: string | null = null;
  private shutdownRequested = false;

  constructor(config: AgentConfig) {
    this.role = config.role;
    this.instanceId = config.instanceId ?? `${config.role}-${Date.now()}`;

    // Initialize connections
    this.redis = getRedis({
      host: config.redisHost,
      port: config.redisPort,
    });

    this.db = getDB({
      host: config.postgresHost,
      port: config.postgresPort,
    });

    // Setup shutdown handlers
    this.setupShutdownHandlers();

    // Start heartbeat
    const intervalMs = config.heartbeatIntervalMs ?? 10000;
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  // ===========================================================================
  // ABSTRACT METHODS (implement in subclass)
  // ===========================================================================

  /**
   * Handle an assigned work item. Subclasses implement the actual work logic.
   * Throw to indicate failure (will trigger retry).
   */
  protected abstract onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void>;

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Start the agent - subscribe to events and process work.
   */
  async start(): Promise<void> {
    console.log(`[${this.role}] Starting agent ${this.instanceId}`);

    // Ensure consumer group exists
    await this.redis.ensureConsumerGroup(this.role);

    // Send initial heartbeat
    await this.sendHeartbeat();

    // Process any pending messages from previous run
    await this.processPendingMessages();

    // Subscribe to new events
    await this.redis.subscribe(this.role, async (message) => {
      await this.handleMessage(message);
    });
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    console.log(`[${this.role}] Shutting down agent ${this.instanceId}`);

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Remove heartbeat record
    await this.db.removeHeartbeat(this.role, this.instanceId);

    // Close connections
    await closeRedis();
    await closeDB();

    console.log(`[${this.role}] Agent ${this.instanceId} shutdown complete`);
  }

  // ===========================================================================
  // MESSAGE HANDLING
  // ===========================================================================

  /**
   * Handle incoming message - fetch work item and delegate to subclass.
   * @param streamId - optional stream ID for acking on success
   */
  private async handleMessage(message: StreamMessage, streamId?: string): Promise<void> {
    // Verify message is for this agent
    if (message.target_role !== this.role) {
      return;
    }

    // Get work item from database
    const workItem = await this.db.getWorkItem(message.work_item_id);
    if (!workItem) {
      console.warn(`[${this.role}] Work item not found: ${message.work_item_id}`);
      return;
    }

    // Track current work for heartbeat
    this.currentWorkItemId = workItem.id;
    let runId: string | null = null;

    try {
      // Create agent run record
      const run = await this.db.createAgentRun({
        work_item_id: workItem.id,
        agent_role: this.role,
        agent_instance: this.instanceId,
        event_id: message.id,
      });
      runId = run.id;

      // Start the run
      await this.db.startAgentRun(run.id);

      // Delegate to subclass
      await this.onWorkAssigned(message, workItem);

      // Mark run as completed
      await this.db.completeAgentRun(run.id, true);
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(`[${this.role}] Error processing ${workItem.id}:`, errorMsg);

      // Mark run as failed (NOT the work item - let retry mechanism handle that)
      if (runId) {
        await this.db.completeAgentRun(runId, false, undefined, errorMsg);
      }

      // Re-throw to trigger retry in Redis layer
      // Work item status will be set to failed only after max retries (in DLQ handler)
      throw err;
    } finally {
      this.currentWorkItemId = null;
    }
  }

  /**
   * Process pending messages from previous run.
   * These are messages that were delivered but not acked before the previous instance crashed.
   */
  private async processPendingMessages(): Promise<void> {
    const pending = await this.redis.readPendingWithIds(this.role);
    if (pending.length === 0) return;

    console.log(`[${this.role}] Processing ${pending.length} pending messages from previous run`);

    for (const { streamId, message } of pending) {
      try {
        await this.handleMessage(message, streamId);
        await this.redis.ack(this.role, streamId);
      } catch (err) {
        console.error(
          `[${this.role}] Failed to process pending message ${streamId}:`,
          (err as Error).message,
        );
        // Retry mechanism will handle it via the normal subscribe loop
      }
    }
  }

  // ===========================================================================
  // PUBLISHING
  // ===========================================================================

  /**
   * Publish an event to the pipeline.
   */
  protected async publish(params: {
    workItemId: string;
    eventType: EventType;
    targetRole: AgentRole;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const input: PublishEventInput = {
      work_item_id: params.workItemId,
      event_type: params.eventType,
      source_role: this.role,
      target_role: params.targetRole,
      payload: params.payload ?? {},
    };

    const streamId = await this.redis.publish(input);

    // Log to PostgreSQL for audit
    await this.db.logEvent({
      stream_id: streamId,
      event_type: params.eventType,
      source_agent: this.role,
      target_agent: params.targetRole,
      work_item_id: params.workItemId,
      payload: params.payload ?? {},
    });

    return streamId;
  }

  // ===========================================================================
  // WORK ITEM HELPERS
  // ===========================================================================

  /**
   * Claim a work item atomically.
   */
  protected async claimWork(itemId: string): Promise<boolean> {
    return this.db.claimWork(itemId, this.role, this.instanceId);
  }

  /**
   * Update work item status.
   */
  protected async updateWorkStatus(
    itemId: string,
    status: WorkStatus,
    error?: string,
  ): Promise<WorkItem | null> {
    return this.db.updateWorkStatus(itemId, status, error);
  }

  /**
   * Get pending work for this agent role.
   */
  protected async getPendingWork(limit = 10): Promise<WorkItem[]> {
    return this.db.getPendingWork(this.role, limit);
  }

  /**
   * Create child work items (e.g., tasks under an epic).
   */
  protected async createChildWork(params: {
    parentId: string;
    type: "task";
    title: string;
    description?: string;
    targetAgent?: AgentRole;
    specPath?: string;
    priority?: number;
  }): Promise<WorkItem> {
    return this.db.createWorkItem({
      type: params.type,
      parent_id: params.parentId,
      title: params.title,
      description: params.description,
      assigned_agent: params.targetAgent,
      spec_path: params.specPath,
      priority: params.priority,
    });
  }

  // ===========================================================================
  // HEARTBEAT
  // ===========================================================================

  /**
   * Send heartbeat to indicate agent is alive.
   */
  private async sendHeartbeat(): Promise<void> {
    try {
      await this.db.updateHeartbeat({
        agent_role: this.role,
        instance_id: this.instanceId,
        current_work_item_id: this.currentWorkItemId ?? undefined,
        pid: process.pid,
        hostname: hostname(),
      });
    } catch (err) {
      console.error(`[${this.role}] Heartbeat error:`, (err as Error).message);
    }
  }

  // ===========================================================================
  // SHUTDOWN HANDLERS
  // ===========================================================================

  private setupShutdownHandlers(): void {
    const handler = async (signal: string) => {
      console.log(`[${this.role}] Received ${signal}`);
      await this.shutdown();
      process.exit(0);
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }
}
