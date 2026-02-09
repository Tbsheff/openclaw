/**
 * PostToolUse and PostToolUseFailure hook integration.
 *
 * Fires after tool execution completes. Fire-and-forget, cannot block.
 * Tool results are sanitized before passing to hooks.
 */

import type {
  ClaudeHookPostToolUseInput,
  ClaudeHookPostToolUseFailureInput,
  ClaudeHooksConfig,
} from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";
import { matchHooks } from "../registry.js";
import { sanitizeForHook } from "../sanitize.js";
import { toClaudeStyleName } from "./pre-tool-use.js";

const log = createSubsystemLogger("hooks/claude/post-tool-use");

// =============================================================================
// Types
// =============================================================================

export type PostToolUseHookInput = {
  /** Session identifier. */
  session_id?: string;
  /** Tool name that was invoked. */
  tool_name: string;
  /** Tool input parameters. */
  tool_input: Record<string, unknown>;
  /** Tool result (will be sanitized). */
  tool_result: unknown;
  /** Working directory. */
  cwd?: string;
};

export type PostToolUseFailureHookInput = {
  /** Session identifier. */
  session_id?: string;
  /** Tool name that failed. */
  tool_name: string;
  /** Tool input parameters. */
  tool_input: Record<string, unknown>;
  /** Error message or details. */
  tool_error: string;
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
// PostToolUse Hook Execution
// =============================================================================

/**
 * Run all matching PostToolUse hooks for a completed tool.
 * Fire-and-forget: does not block, errors are logged but don't propagate.
 *
 * @param input - Hook input with session, tool name, params, result, and cwd
 */
export async function runPostToolUseHooks(input: PostToolUseHookInput): Promise<void> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return;
  }

  // Map to Claude-style name for matching (exec -> Bash, read -> Read, etc.)
  const claudeStyleName = toClaudeStyleName(input.tool_name);

  // Find matching handlers
  const handlers = matchHooks(config, "PostToolUse", claudeStyleName);
  if (handlers.length === 0) {
    return;
  }

  // Sanitize tool result before passing to hooks
  const sanitizedResult = sanitizeForHook(input.tool_result);

  // Build hook input
  const hookInput: ClaudeHookPostToolUseInput = {
    hook_event_name: "PostToolUse",
    session_id: input.session_id,
    tool_name: claudeStyleName,
    tool_input: input.tool_input,
    tool_result: sanitizedResult,
    cwd: input.cwd,
  };

  log.debug(`Running PostToolUse hooks: tool=${claudeStyleName} handlers=${handlers.length}`);

  // Run all hooks in parallel (fire-and-forget)
  const promises = handlers.map(async (handler) => {
    try {
      const result = await runClaudeHook(handler, hookInput);

      if ("error" in result && result.error) {
        log.warn(`PostToolUse hook error: tool=${claudeStyleName} error=${result.message}`);
      } else if ("blocked" in result && result.blocked) {
        // PostToolUse hooks cannot block, but log it
        log.debug(`PostToolUse hook returned block (ignored): tool=${claudeStyleName}`);
      } else {
        log.debug(`PostToolUse hook completed: tool=${claudeStyleName}`);
      }
    } catch (err) {
      log.warn(`PostToolUse hook exception: tool=${claudeStyleName} error=${String(err)}`);
    }
  });

  // Wait for all hooks to complete (but don't propagate errors)
  await Promise.allSettled(promises);
}

// =============================================================================
// PostToolUseFailure Hook Execution
// =============================================================================

/**
 * Run all matching PostToolUseFailure hooks for a failed tool.
 * Fire-and-forget: does not block, errors are logged but don't propagate.
 *
 * @param input - Hook input with session, tool name, params, error, and cwd
 */
export async function runPostToolUseFailureHooks(
  input: PostToolUseFailureHookInput,
): Promise<void> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return;
  }

  // Map to Claude-style name for matching
  const claudeStyleName = toClaudeStyleName(input.tool_name);

  // Find matching handlers
  const handlers = matchHooks(config, "PostToolUseFailure", claudeStyleName);
  if (handlers.length === 0) {
    return;
  }

  // Build hook input
  const hookInput: ClaudeHookPostToolUseFailureInput = {
    hook_event_name: "PostToolUseFailure",
    session_id: input.session_id,
    tool_name: claudeStyleName,
    tool_input: input.tool_input,
    tool_error: input.tool_error,
    cwd: input.cwd,
  };

  log.debug(
    `Running PostToolUseFailure hooks: tool=${claudeStyleName} handlers=${handlers.length}`,
  );

  // Run all hooks in parallel (fire-and-forget)
  const promises = handlers.map(async (handler) => {
    try {
      const result = await runClaudeHook(handler, hookInput);

      if ("error" in result && result.error) {
        log.warn(`PostToolUseFailure hook error: tool=${claudeStyleName} error=${result.message}`);
      } else if ("blocked" in result && result.blocked) {
        // PostToolUseFailure hooks cannot block, but log it
        log.debug(`PostToolUseFailure hook returned block (ignored): tool=${claudeStyleName}`);
      } else {
        log.debug(`PostToolUseFailure hook completed: tool=${claudeStyleName}`);
      }
    } catch (err) {
      log.warn(`PostToolUseFailure hook exception: tool=${claudeStyleName} error=${String(err)}`);
    }
  });

  // Wait for all hooks to complete (but don't propagate errors)
  await Promise.allSettled(promises);
}

// =============================================================================
// Convenience Checks
// =============================================================================

/**
 * Check if any PostToolUse hooks are configured for a tool.
 */
export function hasPostToolUseHooks(toolName: string): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const claudeStyleName = toClaudeStyleName(toolName);
  const handlers = matchHooks(config, "PostToolUse", claudeStyleName);
  return handlers.length > 0;
}

/**
 * Check if any PostToolUseFailure hooks are configured for a tool.
 */
export function hasPostToolUseFailureHooks(toolName: string): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const claudeStyleName = toClaudeStyleName(toolName);
  const handlers = matchHooks(config, "PostToolUseFailure", claudeStyleName);
  return handlers.length > 0;
}
