/**
 * Claude Code-style hook registry.
 *
 * Provides:
 * - matchHooks() - find matching handlers for an event using picomatch
 * - getHooksConfig() - read hooks config from settings
 */

import picomatch from "picomatch";
import type {
  ClaudeHookEvent,
  ClaudeHookHandler,
  ClaudeHookRule,
  ClaudeHooksConfig,
} from "./types.js";

// =============================================================================
// Hook Matching
// =============================================================================

/**
 * Match hooks for a given event and identifier.
 *
 * @param config - The Claude hooks configuration
 * @param event - The hook event type
 * @param identifier - The identifier to match against (e.g., tool name)
 * @returns Array of matching handlers
 */
export function matchHooks(
  config: ClaudeHooksConfig | undefined,
  event: ClaudeHookEvent,
  identifier: string,
): ClaudeHookHandler[] {
  if (!config) {
    return [];
  }

  const rules = config[event];
  if (!rules || rules.length === 0) {
    return [];
  }

  const handlers: ClaudeHookHandler[] = [];

  for (const rule of rules) {
    if (matchesPattern(rule.matcher, identifier)) {
      handlers.push(...rule.hooks);
    }
  }

  return handlers;
}

/**
 * Check if an identifier matches a glob pattern.
 * Uses picomatch for glob matching.
 */
export function matchesPattern(pattern: string, identifier: string): boolean {
  // Exact match (fast path)
  if (pattern === identifier || pattern === "*") {
    return true;
  }

  // Glob match via picomatch
  // Invalid patterns are treated as non-matching (config error logged elsewhere)
  try {
    const isMatch = picomatch(pattern);
    return isMatch(identifier);
  } catch {
    return false;
  }
}

/**
 * Get all rules for a specific event.
 */
export function getRulesForEvent(
  config: ClaudeHooksConfig | undefined,
  event: ClaudeHookEvent,
): ClaudeHookRule[] {
  if (!config) {
    return [];
  }
  return config[event] ?? [];
}

/**
 * Check if any hooks are configured for a specific event.
 */
export function hasHooksForEvent(
  config: ClaudeHooksConfig | undefined,
  event: ClaudeHookEvent,
): boolean {
  if (!config) {
    return false;
  }
  const rules = config[event];
  return rules !== undefined && rules.length > 0;
}

/**
 * Get all unique patterns for a specific event.
 */
export function getPatternsForEvent(
  config: ClaudeHooksConfig | undefined,
  event: ClaudeHookEvent,
): string[] {
  const rules = getRulesForEvent(config, event);
  return [...new Set(rules.map((r) => r.matcher))];
}

/**
 * Count total handlers for a specific event.
 */
export function countHandlersForEvent(
  config: ClaudeHooksConfig | undefined,
  event: ClaudeHookEvent,
): number {
  const rules = getRulesForEvent(config, event);
  return rules.reduce((sum, rule) => sum + rule.hooks.length, 0);
}

// =============================================================================
// Configuration Access
// =============================================================================

/**
 * Extract Claude hooks config from a settings object.
 * Looks for config at `hooks.claude` path.
 */
export function getClaudeHooksFromSettings(
  settings: Record<string, unknown> | undefined,
): ClaudeHooksConfig | undefined {
  if (!settings) {
    return undefined;
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) {
    return undefined;
  }

  return hooks.claude as ClaudeHooksConfig | undefined;
}

/**
 * Summary of hooks for a specific event (for system prompt).
 */
export type HookEventSummary = {
  event: ClaudeHookEvent;
  patterns: string[];
  handlerCount: number;
};

/**
 * Build a summary of all configured hooks for the system prompt.
 * This helps the agent understand what hooks are active.
 */
export function buildHooksInfo(config: ClaudeHooksConfig | undefined): {
  enabled: boolean;
  events: HookEventSummary[];
} {
  if (!config) {
    return { enabled: false, events: [] };
  }

  const allEvents: ClaudeHookEvent[] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
  ];

  const events: HookEventSummary[] = [];

  for (const event of allEvents) {
    const patterns = getPatternsForEvent(config, event);
    const handlerCount = countHandlersForEvent(config, event);

    if (handlerCount > 0) {
      events.push({ event, patterns, handlerCount });
    }
  }

  return {
    enabled: events.length > 0,
    events,
  };
}
