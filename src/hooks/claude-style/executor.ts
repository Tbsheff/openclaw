/**
 * Claude Code-style hook executor.
 *
 * Executes command handlers with:
 * - execFile for safe subprocess execution (no shell injection)
 * - AbortController for timeouts
 * - Circuit breaker after 3 consecutive failures
 */

import { execFile } from "node:child_process";
import { parse as parseShellQuote } from "shell-quote";
import type { ClaudeHookCommandHandler, ClaudeHookInput, ClaudeHookOutput } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of running a command hook.
 */
export type CommandHookResult =
  | { success: true; output: ClaudeHookOutput }
  | { blocked: true; reason: string }
  | { error: true; message: string };

/**
 * Circuit breaker state per hook handler.
 */
type CircuitBreakerState = {
  failures: number;
  disabled: boolean;
};

// =============================================================================
// Default Timeouts (seconds)
// =============================================================================

export const DEFAULT_TIMEOUTS = {
  command: 600,
  prompt: 30,
  agent: 60,
} as const;

// =============================================================================
// Circuit Breaker
// =============================================================================

const circuitBreakers = new Map<string, CircuitBreakerState>();
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Get or create circuit breaker state for a handler.
 */
function getCircuitBreaker(handlerId: string): CircuitBreakerState {
  let state = circuitBreakers.get(handlerId);
  if (!state) {
    state = { failures: 0, disabled: false };
    circuitBreakers.set(handlerId, state);
  }
  return state;
}

/**
 * Record a success, resetting the failure count.
 */
export function recordSuccess(handlerId: string): void {
  const state = getCircuitBreaker(handlerId);
  state.failures = 0;
}

/**
 * Record a failure, potentially disabling the hook.
 */
export function recordFailure(handlerId: string): boolean {
  const state = getCircuitBreaker(handlerId);
  state.failures++;
  if (state.failures >= MAX_CONSECUTIVE_FAILURES) {
    state.disabled = true;
    return true; // hook is now disabled
  }
  return false;
}

/**
 * Check if a hook is disabled by the circuit breaker.
 */
export function isDisabled(handlerId: string): boolean {
  return circuitBreakers.get(handlerId)?.disabled ?? false;
}

/**
 * Reset circuit breaker state (for testing).
 */
export function resetCircuitBreaker(handlerId: string): void {
  circuitBreakers.delete(handlerId);
}

/**
 * Reset all circuit breakers (for testing).
 */
export function resetAllCircuitBreakers(): void {
  circuitBreakers.clear();
}

// =============================================================================
// Command Parsing
// =============================================================================

/**
 * Parse a command string into argv using shell-quote.
 * Validates that all tokens are strings (no operators/redirects).
 */
export function parseCommand(command: string | string[]): { argv: string[] } | { error: string } {
  // Array commands are used directly
  if (Array.isArray(command)) {
    if (command.length === 0) {
      return { error: "Command array is empty" };
    }
    return { argv: command };
  }

  // String commands are parsed via shell-quote
  const tokens = parseShellQuote(command);

  // Validate all tokens are strings (no operators like |, >, etc.)
  const argv = tokens.filter((t): t is string => typeof t === "string");
  if (argv.length !== tokens.length) {
    return { error: "Command contains unsupported operators" };
  }

  if (argv.length === 0) {
    return { error: "Command string is empty" };
  }

  return { argv };
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Generate a unique handler ID for circuit breaker tracking.
 */
export function getHandlerId(handler: ClaudeHookCommandHandler): string {
  const cmd = Array.isArray(handler.command) ? handler.command.join(" ") : handler.command;
  return `command:${cmd}`;
}

/**
 * Run a command hook handler.
 *
 * @param handler - The command handler to execute
 * @param input - The hook input to send via stdin
 * @returns The result of the hook execution
 */
export async function runCommandHook(
  handler: ClaudeHookCommandHandler,
  input: ClaudeHookInput,
): Promise<CommandHookResult> {
  const handlerId = getHandlerId(handler);

  // Check circuit breaker
  if (isDisabled(handlerId)) {
    return {
      error: true,
      message: `Hook disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
    };
  }

  // Parse command
  const parsed = parseCommand(handler.command);
  if ("error" in parsed) {
    return { blocked: true, reason: parsed.error };
  }

  const [cmd, ...args] = parsed.argv;
  const timeoutMs = (handler.timeout ?? DEFAULT_TIMEOUTS.command) * 1000;
  const inputJson = JSON.stringify(input);

  return new Promise((resolve) => {
    const abortController = new AbortController();

    // Set up timeout with SIGTERM -> SIGKILL escalation
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const mainTimeout = setTimeout(() => {
      // Send SIGTERM first
      child.kill("SIGTERM");

      // After 5 seconds, send SIGKILL
      killTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    const child = execFile(
      cmd,
      args,
      {
        signal: abortController.signal,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: 0, // We handle timeout ourselves
      },
      (error, stdout, stderr) => {
        clearTimeout(mainTimeout);
        if (killTimeout) {
          clearTimeout(killTimeout);
        }

        // Handle abort/timeout
        if (error && error.killed) {
          recordFailure(handlerId);
          resolve({ error: true, message: "Hook timed out" });
          return;
        }

        // Handle exit codes
        const exitCode = error?.code ?? 0;

        if (exitCode === 0) {
          // Success - parse stdout as JSON
          try {
            const output = stdout.trim() ? (JSON.parse(stdout) as ClaudeHookOutput) : {};
            recordSuccess(handlerId);
            resolve({ success: true, output });
          } catch {
            // Invalid JSON counts as failure for circuit breaker
            const wasDisabled = recordFailure(handlerId);
            const message = wasDisabled
              ? `Invalid JSON output (disabled after ${MAX_CONSECUTIVE_FAILURES} failures): ${stdout}`
              : `Invalid JSON output: ${stdout}`;
            resolve({ error: true, message });
          }
          return;
        }

        if (exitCode === 2) {
          // Blocked - stderr contains reason
          recordSuccess(handlerId);
          resolve({ blocked: true, reason: stderr.trim() || "Hook denied" });
          return;
        }

        // Other exit codes - log and continue
        const wasDisabled = recordFailure(handlerId);
        const message = wasDisabled
          ? `Hook failed (exit ${exitCode}), disabled after ${MAX_CONSECUTIVE_FAILURES} failures: ${stderr}`
          : `Hook failed (exit ${exitCode}): ${stderr}`;
        resolve({ error: true, message });
      },
    );

    // Write input to stdin (ignore EPIPE if process exits quickly)
    if (child.stdin) {
      child.stdin.on("error", () => {
        // Ignore EPIPE errors - process may exit before reading all input
      });
      child.stdin.write(inputJson);
      child.stdin.end();
    }
  });
}

/**
 * Run a Claude hook (currently only command handlers supported).
 * Prompt and agent handlers will be implemented in future tasks.
 */
export async function runClaudeHook(
  handler: ClaudeHookCommandHandler,
  input: ClaudeHookInput,
): Promise<CommandHookResult> {
  return runCommandHook(handler, input);
}
