/**
 * SubagentStart and SubagentStop hook integrations.
 *
 * SubagentStart: Fires before subagent spawns. Can inject additional context.
 * SubagentStop: Fires when subagent completes. Observe-only (fire-and-forget).
 */

import type {
  ClaudeHookSubagentStartInput,
  ClaudeHookSubagentStopInput,
  ClaudeHooksConfig,
} from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";
import { matchHooks } from "../registry.js";

const log = createSubsystemLogger("hooks/claude/subagent");

// =============================================================================
// Types
// =============================================================================

export type SubagentStartHookInput = {
  /** Parent session identifier. */
  session_id?: string;
  /** Subagent session key (child). */
  subagent_id: string;
  /** Type of subagent (e.g., "task", "background"). */
  subagent_type?: string;
  /** Task/message being sent to the subagent. */
  task?: string;
  /** Working directory. */
  cwd?: string;
};

export type SubagentStartHookResult = {
  /** Decision from hook: allow or deny. */
  decision: "allow" | "deny";
  /** Reason for deny decision. */
  reason?: string;
  /** Additional context to inject into subagent's task. */
  additionalContext?: string;
};

export type SubagentStopHookInput = {
  /** Parent session identifier. */
  session_id?: string;
  /** Subagent session key (child). */
  subagent_id: string;
  /** Subagent outcome/result. */
  subagent_outcome?: unknown;
  /** Working directory. */
  cwd?: string;
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
// SubagentStart Hook
// =============================================================================

/**
 * Run all matching SubagentStart hooks.
 *
 * @param input - Hook input with parent session, subagent ID, type, and task
 * @returns Result with decision (allow/deny), optional reason, and optional additionalContext
 */
export async function runSubagentStartHooks(
  input: SubagentStartHookInput,
): Promise<SubagentStartHookResult> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return { decision: "allow" };
  }

  // SubagentStart hooks use "*" as the default matcher
  const handlers = matchHooks(config, "SubagentStart", "*");
  if (handlers.length === 0) {
    return { decision: "allow" };
  }

  // Build hook input
  const hookInput: ClaudeHookSubagentStartInput = {
    hook_event_name: "SubagentStart",
    session_id: input.session_id,
    subagent_id: input.subagent_id,
    subagent_type: input.subagent_type,
    cwd: input.cwd,
  };

  log.debug(`Running SubagentStart hooks: handlers=${handlers.length}`);

  // Track accumulated context across handlers
  let accumulatedContext: string | undefined;

  // Run each handler in order (first deny wins, context accumulates)
  for (const handler of handlers) {
    // Only command handlers supported currently
    if (handler.type !== "command") {
      log.debug(`Skipping unsupported handler type: ${handler.type}`);
      continue;
    }

    const result = await runClaudeHook(handler, hookInput);

    // Handle different result types
    if ("blocked" in result && result.blocked) {
      log.info(`SubagentStart hook denied: reason=${result.reason}`);
      return { decision: "deny", reason: result.reason };
    }

    if ("error" in result && result.error) {
      log.warn(`SubagentStart hook error: error=${result.message}`);
      // Continue on error (don't block the subagent)
      continue;
    }

    if ("success" in result && result.success) {
      const output = result.output;

      // Check explicit decision
      if (output.decision === "deny") {
        log.info(`SubagentStart hook denied via output: reason=${output.reason}`);
        return { decision: "deny", reason: output.reason };
      }

      // Accumulate additional context
      if (typeof output.additionalContext === "string" && output.additionalContext.trim()) {
        if (accumulatedContext) {
          accumulatedContext += "\n" + output.additionalContext.trim();
        } else {
          accumulatedContext = output.additionalContext.trim();
        }
        log.debug(`SubagentStart hook injected context`);
      }
    }
  }

  // All hooks passed
  return {
    decision: "allow",
    additionalContext: accumulatedContext,
  };
}

// =============================================================================
// SubagentStop Hook (Observe-Only)
// =============================================================================

/**
 * Run all matching SubagentStop hooks.
 * This is fire-and-forget / observe-only - cannot reject or retry.
 *
 * @param input - Hook input with parent session, subagent ID, and outcome
 */
export async function runSubagentStopHooks(input: SubagentStopHookInput): Promise<void> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return;
  }

  // SubagentStop hooks use "*" as the default matcher
  const handlers = matchHooks(config, "SubagentStop", "*");
  if (handlers.length === 0) {
    return;
  }

  // Build hook input
  const hookInput: ClaudeHookSubagentStopInput = {
    hook_event_name: "SubagentStop",
    session_id: input.session_id,
    subagent_id: input.subagent_id,
    subagent_outcome: input.subagent_outcome,
    cwd: input.cwd,
  };

  log.debug(`Running SubagentStop hooks: handlers=${handlers.length}`);

  // Fire all handlers (fire-and-forget, no decision returned)
  for (const handler of handlers) {
    // Only command handlers supported currently
    if (handler.type !== "command") {
      log.debug(`Skipping unsupported handler type: ${handler.type}`);
      continue;
    }

    try {
      const result = await runClaudeHook(handler, hookInput);

      if ("error" in result && result.error) {
        log.warn(`SubagentStop hook error: error=${result.message}`);
      } else if ("blocked" in result && result.blocked) {
        // SubagentStop is observe-only, ignore block attempts
        log.debug(`SubagentStop hook returned blocked (ignored): reason=${result.reason}`);
      } else if ("success" in result && result.success) {
        log.debug(`SubagentStop hook completed successfully`);
      }
    } catch (err) {
      // Fire-and-forget: log and continue
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`SubagentStop hook exception: ${message}`);
    }
  }
}

// =============================================================================
// Convenience Checks
// =============================================================================

/**
 * Check if any SubagentStart hooks are configured.
 */
export function hasSubagentStartHooks(): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const handlers = matchHooks(config, "SubagentStart", "*");
  return handlers.length > 0;
}

/**
 * Check if any SubagentStop hooks are configured.
 */
export function hasSubagentStopHooks(): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const handlers = matchHooks(config, "SubagentStop", "*");
  return handlers.length > 0;
}
