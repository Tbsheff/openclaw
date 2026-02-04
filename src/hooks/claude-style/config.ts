/**
 * Zod schemas for Claude Code-style hook configuration.
 */

import { z } from "zod";

// =============================================================================
// Handler Schemas (discriminated union)
// =============================================================================

const ClaudeHookHandlerBaseSchema = z.object({
  timeout: z.number().int().positive().optional(),
});

export const ClaudeHookCommandHandlerSchema = ClaudeHookHandlerBaseSchema.extend({
  type: z.literal("command"),
  command: z.union([z.string(), z.array(z.string())]),
}).strict();

export const ClaudeHookPromptHandlerSchema = ClaudeHookHandlerBaseSchema.extend({
  type: z.literal("prompt"),
  prompt: z.string(),
  model: z.string().optional(),
}).strict();

export const ClaudeHookAgentHandlerSchema = ClaudeHookHandlerBaseSchema.extend({
  type: z.literal("agent"),
  agent: z.string(),
  instructions: z.string().optional(),
}).strict();

export const ClaudeHookHandlerSchema = z.discriminatedUnion("type", [
  ClaudeHookCommandHandlerSchema,
  ClaudeHookPromptHandlerSchema,
  ClaudeHookAgentHandlerSchema,
]);

// =============================================================================
// Rule Schema
// =============================================================================

export const ClaudeHookRuleSchema = z
  .object({
    matcher: z.string(),
    hooks: z.array(ClaudeHookHandlerSchema),
  })
  .strict();

export const ClaudeHookEventConfigSchema = z.array(ClaudeHookRuleSchema);

// =============================================================================
// Full Config Schema
// =============================================================================

export const ClaudeHooksConfigSchema = z
  .object({
    PreToolUse: ClaudeHookEventConfigSchema.optional(),
    PostToolUse: ClaudeHookEventConfigSchema.optional(),
    PostToolUseFailure: ClaudeHookEventConfigSchema.optional(),
    UserPromptSubmit: ClaudeHookEventConfigSchema.optional(),
    Stop: ClaudeHookEventConfigSchema.optional(),
    SubagentStart: ClaudeHookEventConfigSchema.optional(),
    SubagentStop: ClaudeHookEventConfigSchema.optional(),
    PreCompact: ClaudeHookEventConfigSchema.optional(),
  })
  .strict()
  .optional();

// =============================================================================
// Feature Flag Helper
// =============================================================================

/**
 * Check if Claude hooks feature is enabled via environment variable.
 */
export function isClaudeHooksEnabled(): boolean {
  return process.env.OPENCLAW_CLAUDE_HOOKS === "1";
}

/**
 * Conditionally parse Claude hooks config based on feature flag.
 * Returns undefined if feature is disabled.
 */
export function parseClaudeHooksConfig(
  value: unknown,
): z.infer<typeof ClaudeHooksConfigSchema> | undefined {
  if (!isClaudeHooksEnabled()) {
    return undefined;
  }
  return ClaudeHooksConfigSchema.parse(value);
}
