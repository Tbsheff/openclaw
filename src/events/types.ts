/**
 * Event types for the multi-agent pipeline.
 *
 * Uses Redis Streams for event-driven communication between agents.
 * Each agent role has its own consumer group for work distribution.
 */

import { z } from "zod";

// =============================================================================
// AGENT ROLES (mirrors postgres.ts)
// =============================================================================

export const AgentRoleSchema = z.enum([
  "pm",
  "domain-expert",
  "architect",
  "cto-review",
  "senior-dev",
  "staff-engineer",
  "code-simplifier",
  "ui-review",
  "ci-agent",
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;

// =============================================================================
// EVENT TYPES
// =============================================================================

export const EventTypeSchema = z.enum([
  "goal_submitted",
  "work_created",
  "work_assigned",
  "work_completed",
  "review_requested",
  "review_completed",
  "ci_status",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

// =============================================================================
// STREAM MESSAGE
// =============================================================================

export const StreamMessageSchema = z.object({
  id: z.string(), // ULID
  work_item_id: z.string().uuid(),
  event_type: EventTypeSchema,
  source_role: AgentRoleSchema,
  target_role: AgentRoleSchema,
  attempt: z.number().int().min(1).default(1),
  payload: z.string(), // JSON-encoded
  created_at: z.string().datetime(),
});

export type StreamMessage = z.infer<typeof StreamMessageSchema>;

// =============================================================================
// PUBLISH EVENT INPUT
// =============================================================================

export const PublishEventSchema = z.object({
  work_item_id: z.string().uuid(),
  event_type: EventTypeSchema,
  source_role: AgentRoleSchema,
  target_role: AgentRoleSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type PublishEventInput = z.infer<typeof PublishEventSchema>;

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Get queue name for an agent role.
 * Each role has its own dedicated stream for direct routing.
 */
export function getQueueName(role: AgentRole): string {
  return `openclaw:queue:${role}`;
}

export const DLQ_STREAM = "openclaw:dlq";
export const MAX_RETRIES = 3;
export const RETRY_DELAYS_MS = [1000, 5000, 30000]; // 1s, 5s, 30s
export const ORPHAN_THRESHOLD_MS = 60000; // 60s
export const BLOCK_TIMEOUT_MS = 5000; // 5s blocking read

/**
 * Consumer group name (same for all queues - workers compete within a role).
 */
export const CONSUMER_GROUP = "group:workers";

/**
 * Get consumer group name for an agent role.
 * @deprecated Use CONSUMER_GROUP constant instead - all queues use the same group name.
 */
export function getConsumerGroup(_role: AgentRole): string {
  return CONSUMER_GROUP;
}
