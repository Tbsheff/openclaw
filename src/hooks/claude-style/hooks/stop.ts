/**
 * Stop hook integration.
 *
 * Fires when agent is about to stop. Can deny to request continuation.
 * Used for internal continuation loops in runEmbeddedAttempt().
 */

import type { ClaudeHookStopInput, ClaudeHooksConfig } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";
import { matchHooks } from "../registry.js";

const log = createSubsystemLogger("hooks/claude/stop");

// =============================================================================
// Types
// =============================================================================

export type StopHookInput = {
  /** Session identifier. */
  session_id?: string;
  /** Working directory. */
  cwd?: string;
  /** Reason for stopping (optional). */
  reason?: string;
  /** Last response from the agent (optional). */
  last_response?: string;
};

export type StopHookResult = {
  /** Decision from hook: allow (stop) or deny (continue). */
  decision: "allow" | "deny";
  /** Reason for the decision. */
  reason?: string;
  /** Continuation message if denying stop. */
  continuation_message?: string;
};

// =============================================================================
// Config Access
// =============================================================================

/**
 * Get Claude hooks config from settings.
 * Returns undefined if feature flag is disabled.
 */
function getClaudeHooksConfig(): ClaudeHooksConfig | undefined {
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
 * Run all matching Stop hooks.
 *
 * @param input - Hook input with session, cwd, reason, and last_response
 * @returns Result with decision (allow/deny), optional reason, and optional continuation_message
 */
export async function runStopHooks(input: StopHookInput): Promise<StopHookResult> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return { decision: "allow" };
  }

  // Stop hooks use "*" as the default matcher
  const handlers = matchHooks(config, "Stop", "*");
  if (handlers.length === 0) {
    return { decision: "allow" };
  }

  // Build hook input
  const hookInput: ClaudeHookStopInput = {
    hook_event_name: "Stop",
    session_id: input.session_id,
    cwd: input.cwd,
    reason: input.reason,
    last_response: input.last_response,
  };

  log.debug(`Running Stop hooks: handlers=${handlers.length}`);

  // Run each handler in order (first deny wins)
  for (const handler of handlers) {
    // Only command handlers supported currently
    if (handler.type !== "command") {
      log.debug(`Skipping unsupported handler type: ${handler.type}`);
      continue;
    }

    const result = await runClaudeHook(handler, hookInput);

    // Handle different result types
    if ("blocked" in result && result.blocked) {
      // "blocked" from command means deny stop (continue)
      log.info(`Stop hook denied (continue): reason=${result.reason}`);
      return {
        decision: "deny",
        reason: result.reason,
        continuation_message: result.reason,
      };
    }

    if ("error" in result && result.error) {
      log.warn(`Stop hook error: error=${result.message}`);
      // Continue on error (allow stop)
      continue;
    }

    if ("success" in result && result.success) {
      const output = result.output;

      // Check explicit decision
      if (output.decision === "deny") {
        log.info(`Stop hook denied via output: reason=${output.reason}`);
        return {
          decision: "deny",
          reason: output.reason,
          continuation_message: output.continuation_message ?? output.reason,
        };
      }

      // "allow" means let agent stop
      if (output.decision === "allow") {
        // Early return on explicit allow
        return { decision: "allow", reason: output.reason };
      }
    }
  }

  // All hooks passed without deny - allow stop
  return { decision: "allow" };
}

// =============================================================================
// Convenience Check
// =============================================================================

/**
 * Check if any Stop hooks are configured.
 */
export function hasStopHooks(): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const handlers = matchHooks(config, "Stop", "*");
  return handlers.length > 0;
}
