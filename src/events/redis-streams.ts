/**
 * Redis Streams wrapper for multi-agent pipeline communication.
 *
 * Provides typed event publishing and consumption with:
 * - Consumer groups per agent role
 * - Automatic retries with exponential backoff
 * - Dead letter queue for failed messages
 * - Orphan message reclamation
 */

import Redis from "ioredis";
import { ulid } from "ulid";
import {
  type AgentRole,
  type EventType,
  type PublishEventInput,
  type StreamMessage,
  BLOCK_TIMEOUT_MS,
  DLQ_STREAM,
  MAX_RETRIES,
  ORPHAN_THRESHOLD_MS,
  RETRY_DELAYS_MS,
  STREAM_NAME,
  StreamMessageSchema,
  getConsumerGroup,
} from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface RedisStreamsConfig {
  host?: string;
  port?: number;
  password?: string;
  maxReconnectAttempts?: number;
}

export type MessageHandler = (message: StreamMessage) => Promise<void>;

interface PendingMessage {
  id: string;
  consumer: string;
  idleTime: number;
  deliveryCount: number;
}

// =============================================================================
// REDIS STREAMS CLIENT
// =============================================================================

export class RedisStreams {
  private redis: Redis;
  private subscriber: Redis | null = null;
  private closed = false;
  private consumerName: string;

  constructor(config: RedisStreamsConfig = {}) {
    const host = config.host ?? process.env.REDIS_HOST ?? "localhost";
    const port = config.port ?? parseInt(process.env.REDIS_PORT ?? "6380", 10);

    this.redis = new Redis({
      host,
      port,
      password: config.password,
      maxRetriesPerRequest: config.maxReconnectAttempts ?? 3,
      retryStrategy: (times) => {
        if (times > (config.maxReconnectAttempts ?? 10)) {
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      },
    });

    // Unique consumer name for this instance
    this.consumerName = `consumer-${ulid()}`;

    this.redis.on("error", (err) => {
      console.error("[RedisStreams] Connection error:", err.message);
    });
  }

  /**
   * Test Redis connectivity.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.subscriber) {
      await this.subscriber.quit();
    }
    await this.redis.quit();
  }

  // ===========================================================================
  // STREAM SETUP
  // ===========================================================================

  /**
   * Ensure consumer group exists for a role.
   * Creates stream if it doesn't exist.
   */
  async ensureConsumerGroup(role: AgentRole): Promise<void> {
    const group = getConsumerGroup(role);
    try {
      // MKSTREAM creates the stream if it doesn't exist
      // $ means start reading new messages only
      await this.redis.xgroup("CREATE", STREAM_NAME, group, "$", "MKSTREAM");
    } catch (err) {
      // BUSYGROUP means group already exists - that's fine
      if (!(err as Error).message.includes("BUSYGROUP")) {
        throw err;
      }
    }
  }

  /**
   * Ensure all consumer groups exist.
   */
  async ensureAllGroups(): Promise<void> {
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
    await Promise.all(roles.map((role) => this.ensureConsumerGroup(role)));
  }

  // ===========================================================================
  // PUBLISHING
  // ===========================================================================

  /**
   * Publish an event to the pipeline stream.
   * Returns the stream message ID.
   */
  async publish(input: PublishEventInput): Promise<string> {
    const messageId = ulid();
    const message: StreamMessage = {
      id: messageId,
      work_item_id: input.work_item_id,
      event_type: input.event_type,
      source_role: input.source_role,
      target_role: input.target_role,
      attempt: 1,
      payload: JSON.stringify(input.payload),
      created_at: new Date().toISOString(),
    };

    // XADD with * lets Redis generate stream entry ID
    const streamEntryId = await this.redis.xadd(
      STREAM_NAME,
      "*",
      "id",
      message.id,
      "work_item_id",
      message.work_item_id,
      "event_type",
      message.event_type,
      "source_role",
      message.source_role,
      "target_role",
      message.target_role,
      "attempt",
      message.attempt.toString(),
      "payload",
      message.payload,
      "created_at",
      message.created_at,
    );

    return streamEntryId as string;
  }

  // ===========================================================================
  // CONSUMING
  // ===========================================================================

  /**
   * Subscribe to events for a specific agent role.
   * Calls handler for each message. Handler should throw to trigger retry.
   * Also processes pending messages (recovered from crashes) on each loop iteration.
   */
  async subscribe(role: AgentRole, handler: MessageHandler): Promise<void> {
    await this.ensureConsumerGroup(role);
    const group = getConsumerGroup(role);

    // Use separate connection for blocking reads
    this.subscriber = this.redis.duplicate();
    let loopCount = 0;

    while (!this.closed) {
      try {
        // Every 10 iterations, also check for pending messages (crash recovery)
        // This handles messages that were delivered to this consumer but not acked
        if (loopCount % 10 === 0) {
          await this.processPendingMessages(role, handler);
        }
        loopCount++;

        // XREADGROUP with BLOCK for efficient waiting
        // > means only new messages not yet delivered to any consumer in this group
        const result = await this.subscriber.xreadgroup(
          "GROUP",
          group,
          this.consumerName,
          "BLOCK",
          BLOCK_TIMEOUT_MS,
          "COUNT",
          10,
          "STREAMS",
          STREAM_NAME,
          ">",
        );

        if (!result) continue; // Timeout, no new messages

        for (const [, messages] of result) {
          for (const [streamId, fields] of messages) {
            const message = this.parseMessage(fields as string[]);
            if (!message) {
              // Invalid message, ack and skip
              await this.ack(role, streamId);
              continue;
            }

            // Only process if targeted at this role
            if (message.target_role !== role) {
              await this.ack(role, streamId);
              continue;
            }

            try {
              await handler(message);
              await this.ack(role, streamId);
            } catch (err) {
              console.error(
                `[RedisStreams] Handler error for ${streamId}:`,
                (err as Error).message,
              );
              await this.retry(role, streamId, message);
            }
          }
        }
      } catch (err) {
        if (this.closed) break;
        console.error("[RedisStreams] Subscribe error:", (err as Error).message);
        // Brief pause before retry
        await this.sleep(1000);
      }
    }
  }

  /**
   * Process pending messages for this consumer (crash recovery).
   */
  private async processPendingMessages(role: AgentRole, handler: MessageHandler): Promise<void> {
    const pending = await this.readPendingWithIds(role, 50);
    if (pending.length === 0) return;

    console.log(`[RedisStreams] Processing ${pending.length} pending messages for ${role}`);

    for (const { streamId, message } of pending) {
      try {
        await handler(message);
        await this.ack(role, streamId);
      } catch (err) {
        console.error(
          `[RedisStreams] Handler error for pending ${streamId}:`,
          (err as Error).message,
        );
        await this.retry(role, streamId, message);
      }
    }
  }

  /**
   * Read pending messages (for recovery after restart).
   */
  async readPending(role: AgentRole, count = 100): Promise<StreamMessage[]> {
    const group = getConsumerGroup(role);

    // 0 means read from start of pending entries
    const result = await this.redis.xreadgroup(
      "GROUP",
      group,
      this.consumerName,
      "COUNT",
      count,
      "STREAMS",
      STREAM_NAME,
      "0",
    );

    if (!result) return [];

    const messages: StreamMessage[] = [];
    for (const [, entries] of result) {
      for (const [, fields] of entries) {
        const message = this.parseMessage(fields as string[]);
        if (message && message.target_role === role) {
          messages.push(message);
        }
      }
    }
    return messages;
  }

  // ===========================================================================
  // ACKNOWLEDGMENT
  // ===========================================================================

  /**
   * Acknowledge a message as processed.
   */
  async ack(role: AgentRole, streamId: string): Promise<void> {
    const group = getConsumerGroup(role);
    await this.redis.xack(STREAM_NAME, group, streamId);
  }

  // ===========================================================================
  // RETRY LOGIC
  // ===========================================================================

  /**
   * Retry a failed message with backoff.
   * Moves to DLQ after max retries.
   * Re-publishes BEFORE ack to prevent message loss on crash.
   */
  async retry(role: AgentRole, streamId: string, message: StreamMessage): Promise<void> {
    const newAttempt = message.attempt + 1;

    if (newAttempt > MAX_RETRIES) {
      await this.moveToDLQ(role, streamId, message, "max_retries_exceeded");
      return;
    }

    // Wait for backoff delay
    const delay = RETRY_DELAYS_MS[newAttempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    await this.sleep(delay);

    // Re-publish with incremented attempt FIRST (before ack)
    // This ensures message isn't lost if process crashes during retry
    await this.redis.xadd(
      STREAM_NAME,
      "*",
      "id",
      message.id,
      "work_item_id",
      message.work_item_id,
      "event_type",
      message.event_type,
      "source_role",
      message.source_role,
      "target_role",
      message.target_role,
      "attempt",
      newAttempt.toString(),
      "payload",
      message.payload,
      "created_at",
      message.created_at,
    );

    // Only ack AFTER successful re-publish
    await this.ack(role, streamId);
  }

  /**
   * Move a message to the dead letter queue.
   */
  async moveToDLQ(
    role: AgentRole,
    streamId: string,
    message: StreamMessage,
    reason: string,
  ): Promise<void> {
    // Ack from main stream
    await this.ack(role, streamId);

    // Add to DLQ with failure metadata
    await this.redis.xadd(
      DLQ_STREAM,
      "*",
      "id",
      message.id,
      "work_item_id",
      message.work_item_id,
      "event_type",
      message.event_type,
      "source_role",
      message.source_role,
      "target_role",
      message.target_role,
      "attempt",
      message.attempt.toString(),
      "payload",
      message.payload,
      "created_at",
      message.created_at,
      "dlq_reason",
      reason,
      "dlq_at",
      new Date().toISOString(),
    );

    console.warn(`[RedisStreams] Message ${message.id} moved to DLQ: ${reason}`);
  }

  // ===========================================================================
  // ORPHAN RECOVERY
  // ===========================================================================

  /**
   * Reclaim orphaned messages (stuck with crashed consumers).
   * Returns the reclaimed messages so they can be processed.
   */
  async reclaimOrphans(
    role: AgentRole,
  ): Promise<Array<{ streamId: string; message: StreamMessage }>> {
    const group = getConsumerGroup(role);
    const reclaimed: Array<{ streamId: string; message: StreamMessage }> = [];

    try {
      // XAUTOCLAIM: claim messages idle for > threshold
      // Returns [next_start_id, claimed_messages, deleted_ids]
      const result = await this.redis.xautoclaim(
        STREAM_NAME,
        group,
        this.consumerName,
        ORPHAN_THRESHOLD_MS,
        "0-0", // Start from beginning
        "COUNT",
        100,
      );

      if (result && Array.isArray(result) && result.length >= 2) {
        const claimed = result[1] as Array<[string, string[]]>;

        for (const [streamId, fields] of claimed) {
          const message = this.parseMessage(fields);
          if (message && message.target_role === role) {
            reclaimed.push({ streamId, message });
          }
        }

        if (reclaimed.length > 0) {
          console.log(`[RedisStreams] Reclaimed ${reclaimed.length} orphaned messages for ${role}`);
        }
      }
    } catch (err) {
      console.error("[RedisStreams] Orphan reclaim error:", (err as Error).message);
    }

    return reclaimed;
  }

  /**
   * Get info about pending messages for a role.
   */
  async getPendingInfo(role: AgentRole): Promise<{
    count: number;
    messages: PendingMessage[];
  }> {
    const group = getConsumerGroup(role);

    try {
      // XPENDING with detailed view
      const result = await this.redis.xpending(STREAM_NAME, group, "-", "+", 100);

      const messages: PendingMessage[] = [];
      if (Array.isArray(result)) {
        for (const entry of result) {
          if (Array.isArray(entry) && entry.length >= 4) {
            messages.push({
              id: entry[0] as string,
              consumer: entry[1] as string,
              idleTime: entry[2] as number,
              deliveryCount: entry[3] as number,
            });
          }
        }
      }

      return { count: messages.length, messages };
    } catch {
      return { count: 0, messages: [] };
    }
  }

  /**
   * Get total queue backlog for a role (pending + undelivered).
   * Uses XINFO GROUPS to get lag (undelivered messages).
   */
  async getQueueBacklog(role: AgentRole): Promise<{
    pending: number;
    lag: number;
    total: number;
  }> {
    const group = getConsumerGroup(role);

    try {
      // XINFO GROUPS returns info about consumer groups including lag
      const result = await this.redis.xinfo("GROUPS", STREAM_NAME);

      let lag = 0;
      let pending = 0;

      if (Array.isArray(result)) {
        for (const groupInfo of result) {
          // groupInfo is an array of [key, value, key, value, ...]
          if (Array.isArray(groupInfo)) {
            const info: Record<string, unknown> = {};
            for (let i = 0; i < groupInfo.length; i += 2) {
              info[groupInfo[i] as string] = groupInfo[i + 1];
            }
            if (info.name === group) {
              lag = (info.lag as number) ?? 0;
              pending = (info.pending as number) ?? 0;
              break;
            }
          }
        }
      }

      return { pending, lag, total: pending + lag };
    } catch {
      // Fallback to just pending count
      const pendingInfo = await this.getPendingInfo(role);
      return { pending: pendingInfo.count, lag: 0, total: pendingInfo.count };
    }
  }

  /**
   * Read pending messages with their stream IDs (for recovery).
   */
  async readPendingWithIds(
    role: AgentRole,
    count = 100,
  ): Promise<Array<{ streamId: string; message: StreamMessage }>> {
    const group = getConsumerGroup(role);
    const results: Array<{ streamId: string; message: StreamMessage }> = [];

    // 0 means read from start of pending entries
    const result = await this.redis.xreadgroup(
      "GROUP",
      group,
      this.consumerName,
      "COUNT",
      count,
      "STREAMS",
      STREAM_NAME,
      "0",
    );

    if (!result) return results;

    for (const [, entries] of result) {
      for (const [streamId, fields] of entries) {
        const message = this.parseMessage(fields as string[]);
        if (message && message.target_role === role) {
          results.push({ streamId, message });
        }
      }
    }
    return results;
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  /**
   * Parse Redis hash fields into StreamMessage.
   */
  private parseMessage(fields: string[]): StreamMessage | null {
    try {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }

      return StreamMessageSchema.parse({
        id: obj.id,
        work_item_id: obj.work_item_id,
        event_type: obj.event_type,
        source_role: obj.source_role,
        target_role: obj.target_role,
        attempt: parseInt(obj.attempt, 10),
        payload: obj.payload,
        created_at: obj.created_at,
      });
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let defaultInstance: RedisStreams | null = null;

/**
 * Get or create the default RedisStreams instance.
 */
export function getRedis(config?: RedisStreamsConfig): RedisStreams {
  if (!defaultInstance) {
    defaultInstance = new RedisStreams(config);
  }
  return defaultInstance;
}

/**
 * Close the default instance.
 */
export async function closeRedis(): Promise<void> {
  if (defaultInstance) {
    await defaultInstance.close();
    defaultInstance = null;
  }
}
