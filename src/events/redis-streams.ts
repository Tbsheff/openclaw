/**
 * Redis Streams wrapper for multi-agent pipeline communication.
 *
 * Provides typed event publishing and consumption with:
 * - Consumer groups per agent role
 * - Automatic retries with exponential backoff
 * - Dead letter queue for failed messages
 * - Orphan message reclamation
 */

import { Redis } from "ioredis";
import { ulid } from "ulid";
import {
  type AgentRole,
  type PublishEventInput,
  type StreamMessage,
  BLOCK_TIMEOUT_MS,
  CONSUMER_GROUP,
  DLQ_STREAM,
  MAX_RETRIES,
  ORPHAN_THRESHOLD_MS,
  RETRY_DELAYS_MS,
  StreamMessageSchema,
  getQueueName,
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
  private orphanCursors: Map<string, string> = new Map(); // Track XAUTOCLAIM cursor per role

  constructor(config: RedisStreamsConfig = {}) {
    const host = config.host ?? process.env.REDIS_HOST ?? "localhost";
    const port = config.port ?? parseInt(process.env.REDIS_PORT ?? "6380", 10);

    this.redis = new Redis({
      host,
      port,
      password: config.password,
      maxRetriesPerRequest: config.maxReconnectAttempts ?? 3,
      retryStrategy: (times: number) => {
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
    if (this.closed) {
      return;
    }
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
   * Ensure consumer group exists for a role's dedicated queue.
   * Creates the queue (stream) if it doesn't exist.
   * @param startId - Where to start reading: "0" for all history, "$" for new only (default: "0")
   */
  async ensureConsumerGroup(role: AgentRole, startId: "0" | "$" = "0"): Promise<void> {
    const queueName = getQueueName(role);
    try {
      // MKSTREAM creates the stream if it doesn't exist
      // "0" reads from beginning (ensures messages published before group creation are delivered)
      // "$" reads only new messages (may miss messages if group created after publish)
      await this.redis.xgroup("CREATE", queueName, CONSUMER_GROUP, startId, "MKSTREAM");
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
   * Publish an event directly to the target role's queue.
   * Returns the stream message ID.
   *
   * Per-agent queue routing: messages are routed at publish time to the
   * target role's dedicated queue, eliminating wasted reads and filtering.
   */
  async publish(input: PublishEventInput): Promise<string> {
    const messageId = ulid();
    const queueName = getQueueName(input.target_role);
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

    // XADD directly to target role's queue (per-agent routing)
    const streamEntryId = await this.redis.xadd(
      queueName,
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
   *
   * Per-agent queue: reads directly from the role's dedicated queue.
   * No filtering needed - all messages in this queue are targeted at this role.
   */
  async subscribe(role: AgentRole, handler: MessageHandler): Promise<void> {
    await this.ensureConsumerGroup(role);
    const queueName = getQueueName(role);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await (this.subscriber as any).xreadgroup(
          "GROUP",
          CONSUMER_GROUP,
          this.consumerName,
          "BLOCK",
          BLOCK_TIMEOUT_MS,
          "COUNT",
          10,
          "STREAMS",
          queueName,
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!result) {
          continue; // Timeout, no new messages
        }

        for (const [, messages] of result) {
          for (const [streamId, fields] of messages) {
            const message = this.parseMessage(fields);
            if (!message) {
              // Invalid message, ack and skip
              await this.ack(role, streamId);
              continue;
            }

            // No target_role filtering needed - per-agent queue routing
            // ensures all messages in this queue are for this role

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
        if (this.closed) {
          break;
        }
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
    if (pending.length === 0) {
      return;
    }

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
   * Reads from role's dedicated queue - no filtering needed.
   */
  async readPending(role: AgentRole, count = 100): Promise<StreamMessage[]> {
    const queueName = getQueueName(role);

    // 0 means read from start of pending entries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (this.redis as any).xreadgroup(
      "GROUP",
      CONSUMER_GROUP,
      this.consumerName,
      "COUNT",
      count,
      "STREAMS",
      queueName,
      "0",
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) {
      return [];
    }

    const messages: StreamMessage[] = [];
    for (const [, entries] of result) {
      for (const [, fields] of entries) {
        const message = this.parseMessage(fields);
        if (message) {
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
   * Acknowledges on the role's dedicated queue.
   */
  async ack(role: AgentRole, streamId: string): Promise<void> {
    const queueName = getQueueName(role);
    await this.redis.xack(queueName, CONSUMER_GROUP, streamId);
  }

  // ===========================================================================
  // RETRY LOGIC
  // ===========================================================================

  /**
   * Retry a failed message with backoff.
   * Moves to DLQ after max retries.
   * Re-publishes to the same queue BEFORE ack to prevent message loss on crash.
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

    // Re-publish to the same queue with incremented attempt FIRST (before ack)
    // This ensures message isn't lost if process crashes during retry
    const queueName = getQueueName(role);
    await this.redis.xadd(
      queueName,
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
   * Writes to DLQ first, then ACKs to prevent message loss if XADD fails.
   */
  async moveToDLQ(
    role: AgentRole,
    streamId: string,
    message: StreamMessage,
    reason: string,
  ): Promise<void> {
    // Add to DLQ FIRST (before ack) to prevent message loss on failure
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

    // Ack from main stream only AFTER successful DLQ write
    await this.ack(role, streamId);

    console.warn(`[RedisStreams] Message ${message.id} moved to DLQ: ${reason}`);
  }

  // ===========================================================================
  // ORPHAN RECOVERY
  // ===========================================================================

  /**
   * Reclaim orphaned messages (stuck with crashed consumers).
   * Returns the reclaimed messages so they can be processed.
   * Reclaims from the role's dedicated queue - no filtering needed.
   * Tracks cursor per role to resume from next_start_id (avoids O(N) scans).
   */
  async reclaimOrphans(
    role: AgentRole,
  ): Promise<Array<{ streamId: string; message: StreamMessage }>> {
    const queueName = getQueueName(role);
    const reclaimed: Array<{ streamId: string; message: StreamMessage }> = [];

    try {
      // Resume from tracked cursor or start fresh
      const cursor = this.orphanCursors.get(role) ?? "0-0";

      // XAUTOCLAIM: claim messages idle for > threshold
      // Returns [next_start_id, claimed_messages, deleted_ids]
      const result = await this.redis.xautoclaim(
        queueName,
        CONSUMER_GROUP,
        this.consumerName,
        ORPHAN_THRESHOLD_MS,
        cursor,
        "COUNT",
        100,
      );

      if (result && Array.isArray(result) && result.length >= 2) {
        const nextStartId = result[0] as string;
        const claimed = result[1] as Array<[string, string[]]>;

        // Track next cursor; reset to "0-0" if we've scanned everything
        if (nextStartId === "0-0") {
          this.orphanCursors.delete(role);
        } else {
          this.orphanCursors.set(role, nextStartId);
        }

        for (const [streamId, fields] of claimed) {
          const message = this.parseMessage(fields);
          if (message) {
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
   * Requeue a reclaimed message back to the queue and ACK the original.
   * This ensures workers can pick up the message again.
   */
  async requeueMessage(role: AgentRole, streamId: string, message: StreamMessage): Promise<void> {
    const queueName = getQueueName(role);

    // XADD back to the same queue (message will get a new stream ID)
    await this.redis.xadd(
      queueName,
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

    // ACK the reclaimed message after successful requeue
    await this.ack(role, streamId);
  }

  /**
   * Get info about pending messages for a role.
   * Queries the role's dedicated queue.
   * Uses XPENDING summary form for accurate total count, then fetches details.
   */
  async getPendingInfo(role: AgentRole): Promise<{
    count: number;
    messages: PendingMessage[];
  }> {
    const queueName = getQueueName(role);

    try {
      // XPENDING summary form: returns [total, minId, maxId, [[consumer, count], ...]]
      const summary = await this.redis.xpending(queueName, CONSUMER_GROUP);
      if (!Array.isArray(summary) || summary.length < 1) {
        return { count: 0, messages: [] };
      }

      const totalCount = summary[0] as number;
      if (totalCount === 0) {
        return { count: 0, messages: [] };
      }

      // XPENDING range form for details (capped at 100 for detail view)
      const detailed = await this.redis.xpending(queueName, CONSUMER_GROUP, "-", "+", 100);

      const messages: PendingMessage[] = [];
      if (Array.isArray(detailed)) {
        for (const entry of detailed) {
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

      // Return actual total from summary, not capped details length
      return { count: totalCount, messages };
    } catch {
      return { count: 0, messages: [] };
    }
  }

  /**
   * Get total queue backlog for a role.
   * Uses XINFO GROUPS for accurate lag (undelivered messages) and XPENDING for pending count.
   */
  async getQueueBacklog(role: AgentRole): Promise<{
    pending: number;
    lag: number;
    total: number;
  }> {
    const queueName = getQueueName(role);

    try {
      // XPENDING summary for pending count
      const summary = await this.redis.xpending(queueName, CONSUMER_GROUP);
      const pending = Array.isArray(summary) && summary.length > 0 ? (summary[0] as number) : 0;

      // XINFO GROUPS for lag (undelivered messages not yet claimed by any consumer)
      let lag = 0;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const groups = (await (this.redis as any).xinfo("GROUPS", queueName)) as Array<
          Array<string | number>
        >;
        for (const group of groups) {
          // Group info is array: [field, value, field, value, ...]
          for (let i = 0; i < group.length; i += 2) {
            if (group[i] === "name" && group[i + 1] === CONSUMER_GROUP) {
              // Find lag field
              for (let j = 0; j < group.length; j += 2) {
                if (group[j] === "lag") {
                  lag = group[j + 1] as number;
                  break;
                }
              }
              break;
            }
          }
        }
      } catch {
        // XINFO may fail if stream doesn't exist; lag stays 0
      }

      // Total = pending (claimed but not acked) + lag (not yet delivered)
      const total = pending + lag;

      return { pending, lag, total };
    } catch {
      return { pending: 0, lag: 0, total: 0 };
    }
  }

  /**
   * Read pending messages with their stream IDs (for recovery).
   * Reads from role's dedicated queue - no filtering needed.
   */
  async readPendingWithIds(
    role: AgentRole,
    count = 100,
  ): Promise<Array<{ streamId: string; message: StreamMessage }>> {
    const queueName = getQueueName(role);
    const results: Array<{ streamId: string; message: StreamMessage }> = [];

    // 0 means read from start of pending entries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (this.redis as any).xreadgroup(
      "GROUP",
      CONSUMER_GROUP,
      this.consumerName,
      "COUNT",
      count,
      "STREAMS",
      queueName,
      "0",
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) {
      return results;
    }

    for (const [, entries] of result) {
      for (const [streamId, fields] of entries) {
        const message = this.parseMessage(fields);
        if (message) {
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
