/**
 * PreToolUse hook integration.
 *
 * Fires before tool execution to allow blocking or modifying tool parameters.
 */

import type { ClaudeHookPreToolUseInput, ClaudeHooksConfig } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";
import { matchHooks } from "../registry.js";

const log = createSubsystemLogger("hooks/claude/pre-tool-use");

// =============================================================================
// Types
// =============================================================================

export type PreToolUseHookInput = {
  /** Session identifier. */
  session_id?: string;
  /** Tool name being invoked. */
  tool_name: string;
  /** Tool input parameters. */
  tool_input: Record<string, unknown>;
  /** Working directory. */
  cwd?: string;
};

export type PreToolUseHookResult = {
  /** Decision from hook: allow, deny, or ask. */
  decision: "allow" | "deny" | "ask";
  /** Reason for deny decision. */
  reason?: string;
  /** Modified tool input (merged with original). */
  updatedInput?: Record<string, unknown>;
};

// =============================================================================
// Config Access
// =============================================================================

/**
 * Get Claude hooks config from settings.
 * Returns undefined if feature flag is disabled.
 */
export function getClaudeHooksConfig(): ClaudeHooksConfig | undefined {
  if (!isClaudeHooksEnabled()) {
    return undefined;
  }
  try {
    const config = loadConfig();
    return config.hooks?.claude;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Hook Execution
// =============================================================================

/**
 * Run all matching PreToolUse hooks for a tool.
 *
 * @param input - Hook input with session, tool name, params, and cwd
 * @returns Result with decision (allow/deny), optional reason, and optional updatedInput
 */
export async function runPreToolUseHooks(
  input: PreToolUseHookInput,
): Promise<PreToolUseHookResult> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return { decision: "allow" };
  }

  // Find matching handlers for this tool
  const handlers = matchHooks(config, "PreToolUse", input.tool_name);
  if (handlers.length === 0) {
    return { decision: "allow" };
  }

  // Build hook input
  const hookInput: ClaudeHookPreToolUseInput = {
    hook_event_name: "PreToolUse",
    session_id: input.session_id,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    cwd: input.cwd,
  };

  // Track accumulated param modifications
  let accumulatedUpdates: Record<string, unknown> | undefined;

  // Run each handler in order (first deny wins, params accumulate)
  for (const handler of handlers) {
    // Only command handlers supported currently
    if (handler.type !== "command") {
      log.debug(`Skipping unsupported handler type: ${handler.type}`);
      continue;
    }

    const result = await runClaudeHook(handler, hookInput);

    // Handle different result types
    if ("blocked" in result && result.blocked) {
      log.info(`PreToolUse hook denied: tool=${input.tool_name} reason=${result.reason}`);
      return { decision: "deny", reason: result.reason };
    }

    if ("error" in result && result.error) {
      log.warn(`PreToolUse hook error: tool=${input.tool_name} error=${result.message}`);
      // Continue on error (don't block the tool)
      continue;
    }

    if ("success" in result && result.success) {
      const output = result.output;

      // Check explicit decision
      if (output.decision === "deny") {
        log.info(
          `PreToolUse hook denied via output: tool=${input.tool_name} reason=${output.reason}`,
        );
        return { decision: "deny", reason: output.reason };
      }

      // Accumulate param modifications
      if (output.updatedInput) {
        accumulatedUpdates = { ...accumulatedUpdates, ...output.updatedInput };
      }
    }
  }

  // All hooks passed
  return {
    decision: "allow",
    updatedInput: accumulatedUpdates,
  };
}

// =============================================================================
// Convenience Check
// =============================================================================

/**
 * Check if any PreToolUse hooks are configured for a tool.
 */
export function hasPreToolUseHooks(toolName: string): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const handlers = matchHooks(config, "PreToolUse", toolName);
  return handlers.length > 0;
}
