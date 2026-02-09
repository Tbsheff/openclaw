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
import type {
  ClaudeHookCommandHandler,
  ClaudeHookPromptHandler,
  ClaudeHookHandler,
  ClaudeHookInput,
  ClaudeHookOutput,
} from "./types.js";
import { createMultiProviderLLM } from "../../llm/multi-provider.js";

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
export function getHandlerId(handler: ClaudeHookHandler): string {
  if (handler.type === "command") {
    const cmd = Array.isArray(handler.command) ? handler.command.join(" ") : handler.command;
    return `command:${cmd}`;
  }
  if (handler.type === "prompt") {
    return `prompt:${handler.prompt.slice(0, 50)}`;
  }
  if (handler.type === "agent") {
    return `agent:${handler.agent}`;
  }
  return `unknown:${JSON.stringify(handler)}`;
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
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        // Ignore EPIPE/ERR_STREAM_DESTROYED - process may exit before reading all input
        if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") {
          // Log unexpected stdin errors for debugging
          console.error(`[hook executor] stdin error: ${err.code} ${err.message}`);
        }
      });
      child.stdin.write(inputJson);
      child.stdin.end();
    }
  });
}

/**
 * Run a prompt hook handler using an LLM.
 *
 * @param handler - The prompt handler to execute
 * @param input - The hook input context
 * @returns The result of the hook execution
 */
export async function runPromptHook(
  handler: ClaudeHookPromptHandler,
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

  const timeoutMs = (handler.timeout ?? DEFAULT_TIMEOUTS.prompt) * 1000;

  try {
    // Create LLM client with optional model override
    const llm = createMultiProviderLLM({
      model: handler.model ?? "anthropic/claude-haiku-4-5",
      maxTokens: 500,
      temperature: 0,
    });

    // Build the prompt with context
    const systemPrompt = `You are a hook handler for an AI agent system. Your job is to evaluate tool usage and return a decision.

You must respond with valid JSON in this exact format:
{
  "decision": "allow" | "deny" | "ask",
  "reason": "optional explanation",
  "updatedInput": {} // optional modified tool parameters
}

Rules:
- "allow": Proceed with the tool call
- "deny": Block the tool call (provide reason)
- "ask": Prompt for user confirmation
- Keep responses concise and focused`;

    const userPrompt = `${handler.prompt}

Hook Context:
- Event: ${input.hook_event_name}
- Tool: ${"tool_name" in input ? input.tool_name : "N/A"}
- Tool Input: ${JSON.stringify("tool_input" in input ? input.tool_input : {}, null, 2)}

Respond with JSON only.`;

    // Call LLM with timeout
    const llmPromise = llm.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    });

    const response = await Promise.race([llmPromise, timeoutPromise]);

    // Parse the response as JSON
    try {
      // Extract JSON from markdown code blocks if present
      let jsonText = response.content.trim();
      const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
      }

      const output = JSON.parse(jsonText) as ClaudeHookOutput;
      recordSuccess(handlerId);
      return { success: true, output };
    } catch (parseError) {
      const wasDisabled = recordFailure(handlerId);
      const message = wasDisabled
        ? `Invalid JSON from LLM (disabled after ${MAX_CONSECUTIVE_FAILURES} failures): ${response.content}`
        : `Invalid JSON from LLM: ${response.content}`;
      return { error: true, message };
    }
  } catch (error) {
    const wasDisabled = recordFailure(handlerId);
    const errorMsg = error instanceof Error ? error.message : String(error);
    const message = wasDisabled
      ? `Prompt hook failed (disabled after ${MAX_CONSECUTIVE_FAILURES} failures): ${errorMsg}`
      : `Prompt hook failed: ${errorMsg}`;
    return { error: true, message };
  }
}

/**
 * Run a Claude hook with support for command, prompt, and agent handlers.
 */
export async function runClaudeHook(
  handler: ClaudeHookHandler,
  input: ClaudeHookInput,
): Promise<CommandHookResult> {
  switch (handler.type) {
    case "command":
      return runCommandHook(handler, input);
    case "prompt":
      return runPromptHook(handler, input);
    case "agent":
      // Agent handlers not yet implemented - treat as error
      return { error: true, message: "Agent handlers not yet implemented" };
    default:
      return {
        error: true,
        message: `Unknown handler type: ${(handler as { type: string }).type}`,
      };
  }
}
