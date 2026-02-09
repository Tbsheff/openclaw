/**
 * UserPromptSubmit hook integration.
 *
 * Fires when user submits a prompt. Can block or modify the prompt content.
 * Covers ALL channels: WhatsApp, Telegram, CLI, HTTP, etc.
 */

import type { ClaudeHookUserPromptSubmitInput, ClaudeHooksConfig } from "../types.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";
import { matchHooks } from "../registry.js";

const log = createSubsystemLogger("hooks/claude/user-prompt");

// =============================================================================
// Types
// =============================================================================

export type UserPromptSubmitHookInput = {
  /** Session identifier. */
  session_id?: string;
  /** The user's prompt text. */
  prompt: string;
  /** Channel the prompt came from. */
  channel?: string;
  /** Working directory. */
  cwd?: string;
};

export type UserPromptSubmitHookResult = {
  /** Decision from hook: allow, deny, or ask. */
  decision: "allow" | "deny" | "ask";
  /** Reason for deny decision. */
  reason?: string;
  /** Modified prompt content. */
  modifiedPrompt?: string;
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
 * Run all matching UserPromptSubmit hooks.
 *
 * @param input - Hook input with session, prompt, channel, and cwd
 * @returns Result with decision (allow/deny), optional reason, and optional modifiedPrompt
 */
export async function runUserPromptSubmitHooks(
  input: UserPromptSubmitHookInput,
): Promise<UserPromptSubmitHookResult> {
  // Get config (returns undefined if feature disabled or no config)
  const config = getClaudeHooksConfig();
  if (!config) {
    return { decision: "allow" };
  }

  // UserPromptSubmit hooks use "*" as the default matcher (matches all prompts)
  const handlers = matchHooks(config, "UserPromptSubmit", "*");
  if (handlers.length === 0) {
    return { decision: "allow" };
  }

  // Build hook input
  const hookInput: ClaudeHookUserPromptSubmitInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: input.session_id,
    prompt: input.prompt,
    channel: input.channel,
    cwd: input.cwd,
  };

  log.debug(`Running UserPromptSubmit hooks: handlers=${handlers.length}`);

  // Track modified prompt across handlers
  let currentPrompt = input.prompt;

  // Run each handler in order (first deny wins, prompt modifications accumulate)
  for (const handler of handlers) {
    // Only command handlers supported currently
    if (handler.type !== "command") {
      log.debug(`Skipping unsupported handler type: ${handler.type}`);
      continue;
    }

    // Update hookInput with current prompt for each handler
    hookInput.prompt = currentPrompt;

    const result = await runClaudeHook(handler, hookInput);

    // Handle different result types
    if ("blocked" in result && result.blocked) {
      log.info(`UserPromptSubmit hook denied: reason=${result.reason}`);
      return { decision: "deny", reason: result.reason };
    }

    if ("error" in result && result.error) {
      log.warn(`UserPromptSubmit hook error: error=${result.message}`);
      // Continue on error (don't block the prompt)
      continue;
    }

    if ("success" in result && result.success) {
      const output = result.output;
      console.error(`[DEBUG] UserPromptSubmit hook output:`, JSON.stringify(output));

      // Check explicit decision
      if (output.decision === "deny") {
        log.info(`UserPromptSubmit hook denied via output: reason=${output.reason}`);
        return { decision: "deny", reason: output.reason };
      }

      if (output.decision === "ask") {
        log.debug(`UserPromptSubmit hook returned "ask"`);
        return { decision: "ask", reason: output.reason };
      }

      // Apply prompt modification if present (allow empty string rewrites)
      if (typeof output.prompt === "string" && output.prompt !== currentPrompt) {
        log.debug(`UserPromptSubmit hook modified prompt`);
        currentPrompt = output.prompt;
      }
    }
  }

  // All hooks passed
  const modified = currentPrompt !== input.prompt;
  return {
    decision: "allow",
    modifiedPrompt: modified ? currentPrompt : undefined,
  };
}

// =============================================================================
// Convenience Check
// =============================================================================

/**
 * Check if any UserPromptSubmit hooks are configured.
 */
export function hasUserPromptSubmitHooks(): boolean {
  const config = getClaudeHooksConfig();
  if (!config) {
    return false;
  }
  const handlers = matchHooks(config, "UserPromptSubmit", "*");
  return handlers.length > 0;
}
