import { describe, it, expect, beforeEach } from "vitest";
import type {
  ClaudeHookCommandHandler,
  ClaudeHookPreToolUseInput,
  ClaudeHooksConfig,
} from "./types.js";
import {
  parseCommand,
  runCommandHook,
  getHandlerId,
  recordSuccess,
  recordFailure,
  isDisabled,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  DEFAULT_TIMEOUTS,
} from "./executor.js";
import {
  matchHooks,
  matchesPattern,
  getRulesForEvent,
  hasHooksForEvent,
  getPatternsForEvent,
  countHandlersForEvent,
  getClaudeHooksFromSettings,
} from "./registry.js";

// =============================================================================
// parseCommand tests
// =============================================================================

describe("parseCommand", () => {
  it("returns argv directly for array commands", () => {
    const result = parseCommand(["node", "script.js", "--flag"]);
    expect(result).toEqual({ argv: ["node", "script.js", "--flag"] });
  });

  it("returns error for empty array", () => {
    const result = parseCommand([]);
    expect(result).toEqual({ error: "Command array is empty" });
  });

  it("parses simple string command", () => {
    const result = parseCommand("node script.js --flag");
    expect(result).toEqual({ argv: ["node", "script.js", "--flag"] });
  });

  it("parses quoted string command", () => {
    const result = parseCommand('echo "hello world"');
    expect(result).toEqual({ argv: ["echo", "hello world"] });
  });

  it("rejects commands with pipe operators", () => {
    const result = parseCommand("cat file.txt | grep pattern");
    expect(result).toEqual({ error: "Command contains unsupported operators" });
  });

  it("rejects commands with redirect operators", () => {
    const result = parseCommand("echo hello > output.txt");
    expect(result).toEqual({ error: "Command contains unsupported operators" });
  });

  it("rejects commands with semicolon", () => {
    const result = parseCommand("echo hello; echo world");
    expect(result).toEqual({ error: "Command contains unsupported operators" });
  });

  it("returns error for empty string", () => {
    const result = parseCommand("");
    expect(result).toEqual({ error: "Command string is empty" });
  });

  it("returns error for whitespace-only string", () => {
    const result = parseCommand("   ");
    expect(result).toEqual({ error: "Command string is empty" });
  });
});

// =============================================================================
// Circuit breaker tests
// =============================================================================

describe("circuit breaker", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  it("starts not disabled", () => {
    expect(isDisabled("test-hook")).toBe(false);
  });

  it("records success and resets failures", () => {
    recordFailure("test-hook");
    recordFailure("test-hook");
    recordSuccess("test-hook");
    expect(isDisabled("test-hook")).toBe(false);
  });

  it("disables after 3 consecutive failures", () => {
    expect(recordFailure("test-hook")).toBe(false);
    expect(recordFailure("test-hook")).toBe(false);
    expect(recordFailure("test-hook")).toBe(true);
    expect(isDisabled("test-hook")).toBe(true);
  });

  it("resets circuit breaker", () => {
    recordFailure("test-hook");
    recordFailure("test-hook");
    recordFailure("test-hook");
    expect(isDisabled("test-hook")).toBe(true);
    resetCircuitBreaker("test-hook");
    expect(isDisabled("test-hook")).toBe(false);
  });
});

// =============================================================================
// getHandlerId tests
// =============================================================================

describe("getHandlerId", () => {
  it("generates ID from string command", () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: "node script.js",
    };
    expect(getHandlerId(handler)).toBe("command:node script.js");
  });

  it("generates ID from array command", () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: ["node", "script.js"],
    };
    expect(getHandlerId(handler)).toBe("command:node script.js");
  });
});

// =============================================================================
// runCommandHook tests
// =============================================================================

describe("runCommandHook", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  it("returns blocked for invalid command", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: "echo hello | cat",
    };
    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "test",
      tool_input: {},
    };

    const result = await runCommandHook(handler, input);
    expect(result).toEqual({
      blocked: true,
      reason: "Command contains unsupported operators",
    });
  });

  it("returns error when circuit breaker is disabled", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: "echo test",
    };
    const handlerId = getHandlerId(handler);

    // Disable the circuit breaker
    recordFailure(handlerId);
    recordFailure(handlerId);
    recordFailure(handlerId);

    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "test",
      tool_input: {},
    };

    const result = await runCommandHook(handler, input);
    expect(result).toMatchObject({
      error: true,
      message: expect.stringContaining("disabled"),
    });
  });

  it("parses JSON output on exit 0", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: ["node", "-e", 'console.log(JSON.stringify({ decision: "allow" }))'],
    };
    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "test",
      tool_input: {},
    };

    const result = await runCommandHook(handler, input);
    expect(result).toEqual({
      success: true,
      output: { decision: "allow" },
    });
  });

  it("returns empty output for empty stdout on exit 0", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: ["node", "-e", ""],
    };
    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "test",
      tool_input: {},
    };

    const result = await runCommandHook(handler, input);
    expect(result).toEqual({
      success: true,
      output: {},
    });
  });

  it("returns blocked on exit 2 with stderr reason", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: ["node", "-e", 'console.error("Blocked by policy"); process.exit(2)'],
    };
    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "test",
      tool_input: {},
    };

    const result = await runCommandHook(handler, input);
    expect(result).toEqual({
      blocked: true,
      reason: "Blocked by policy",
    });
  });

  it("returns error on other exit codes", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: ["node", "-e", 'console.error("Something went wrong"); process.exit(1)'],
    };
    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "test",
      tool_input: {},
    };

    const result = await runCommandHook(handler, input);
    expect(result).toMatchObject({
      error: true,
      message: expect.stringContaining("exit 1"),
    });
  });

  it("receives JSON input via stdin", async () => {
    const handler: ClaudeHookCommandHandler = {
      type: "command",
      command: [
        "node",
        "-e",
        `
        let data = "";
        process.stdin.on("data", (chunk) => data += chunk);
        process.stdin.on("end", () => {
          const input = JSON.parse(data);
          console.log(JSON.stringify({ received_tool: input.tool_name }));
        });
        `,
      ],
    };
    const input: ClaudeHookPreToolUseInput = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };

    const result = await runCommandHook(handler, input);
    expect(result).toEqual({
      success: true,
      output: { received_tool: "Bash" },
    });
  });
});

// =============================================================================
// DEFAULT_TIMEOUTS tests
// =============================================================================

describe("DEFAULT_TIMEOUTS", () => {
  it("has correct default values", () => {
    expect(DEFAULT_TIMEOUTS.command).toBe(600);
    expect(DEFAULT_TIMEOUTS.prompt).toBe(30);
    expect(DEFAULT_TIMEOUTS.agent).toBe(60);
  });
});

// =============================================================================
// matchesPattern tests
// =============================================================================

describe("matchesPattern", () => {
  it("matches exact pattern", () => {
    expect(matchesPattern("Bash", "Bash")).toBe(true);
  });

  it("matches wildcard", () => {
    expect(matchesPattern("*", "Bash")).toBe(true);
    expect(matchesPattern("*", "any-tool")).toBe(true);
  });

  it("matches glob with star", () => {
    expect(matchesPattern("mcp__*", "mcp__slack__send")).toBe(true);
    expect(matchesPattern("mcp__*", "Bash")).toBe(false);
  });

  it("matches glob with question mark", () => {
    expect(matchesPattern("Test?", "Test1")).toBe(true);
    expect(matchesPattern("Test?", "Test")).toBe(false);
  });

  it("matches glob with braces", () => {
    expect(matchesPattern("{Bash,Read,Write}", "Bash")).toBe(true);
    expect(matchesPattern("{Bash,Read,Write}", "Write")).toBe(true);
    expect(matchesPattern("{Bash,Read,Write}", "Edit")).toBe(false);
  });

  it("does not match non-matching pattern", () => {
    expect(matchesPattern("Bash", "Read")).toBe(false);
  });
});

// =============================================================================
// matchHooks tests
// =============================================================================

describe("matchHooks", () => {
  const testConfig: ClaudeHooksConfig = {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "validate-bash.sh" }],
      },
      {
        matcher: "mcp__*",
        hooks: [{ type: "command", command: "log-mcp.sh" }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command: "log-all.sh" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Read",
        hooks: [{ type: "command", command: "post-read.sh" }],
      },
    ],
  };

  it("returns empty array for undefined config", () => {
    expect(matchHooks(undefined, "PreToolUse", "Bash")).toEqual([]);
  });

  it("returns empty array for unconfigured event", () => {
    expect(matchHooks(testConfig, "Stop", "test")).toEqual([]);
  });

  it("matches exact pattern", () => {
    const handlers = matchHooks(testConfig, "PreToolUse", "Bash");
    expect(handlers).toHaveLength(2); // Bash + *
    expect(handlers[0]).toEqual({ type: "command", command: "validate-bash.sh" });
  });

  it("matches glob pattern", () => {
    const handlers = matchHooks(testConfig, "PreToolUse", "mcp__slack__send");
    expect(handlers).toHaveLength(2); // mcp__* + *
  });

  it("matches wildcard pattern", () => {
    const handlers = matchHooks(testConfig, "PreToolUse", "unknown-tool");
    expect(handlers).toHaveLength(1); // only *
    expect(handlers[0]).toEqual({ type: "command", command: "log-all.sh" });
  });

  it("returns handlers from multiple matching rules", () => {
    const handlers = matchHooks(testConfig, "PreToolUse", "Bash");
    expect(handlers).toHaveLength(2);
  });
});

// =============================================================================
// Registry utility tests
// =============================================================================

describe("getRulesForEvent", () => {
  const testConfig: ClaudeHooksConfig = {
    PreToolUse: [{ matcher: "Bash", hooks: [] }],
  };

  it("returns rules for configured event", () => {
    const rules = getRulesForEvent(testConfig, "PreToolUse");
    expect(rules).toHaveLength(1);
  });

  it("returns empty array for unconfigured event", () => {
    expect(getRulesForEvent(testConfig, "Stop")).toEqual([]);
  });

  it("returns empty array for undefined config", () => {
    expect(getRulesForEvent(undefined, "PreToolUse")).toEqual([]);
  });
});

describe("hasHooksForEvent", () => {
  const testConfig: ClaudeHooksConfig = {
    PreToolUse: [{ matcher: "Bash", hooks: [] }],
    PostToolUse: [],
  };

  it("returns true for event with rules", () => {
    expect(hasHooksForEvent(testConfig, "PreToolUse")).toBe(true);
  });

  it("returns false for empty rules array", () => {
    expect(hasHooksForEvent(testConfig, "PostToolUse")).toBe(false);
  });

  it("returns false for unconfigured event", () => {
    expect(hasHooksForEvent(testConfig, "Stop")).toBe(false);
  });

  it("returns false for undefined config", () => {
    expect(hasHooksForEvent(undefined, "PreToolUse")).toBe(false);
  });
});

describe("getPatternsForEvent", () => {
  const testConfig: ClaudeHooksConfig = {
    PreToolUse: [
      { matcher: "Bash", hooks: [] },
      { matcher: "*", hooks: [] },
      { matcher: "Bash", hooks: [] }, // duplicate
    ],
  };

  it("returns unique patterns", () => {
    const patterns = getPatternsForEvent(testConfig, "PreToolUse");
    expect(patterns).toEqual(["Bash", "*"]);
  });

  it("returns empty array for unconfigured event", () => {
    expect(getPatternsForEvent(testConfig, "Stop")).toEqual([]);
  });
});

describe("countHandlersForEvent", () => {
  const testConfig: ClaudeHooksConfig = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }] },
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "b.sh" },
          { type: "command", command: "c.sh" },
        ],
      },
    ],
  };

  it("counts total handlers", () => {
    expect(countHandlersForEvent(testConfig, "PreToolUse")).toBe(3);
  });

  it("returns 0 for unconfigured event", () => {
    expect(countHandlersForEvent(testConfig, "Stop")).toBe(0);
  });
});

// =============================================================================
// getClaudeHooksFromSettings tests
// =============================================================================

describe("getClaudeHooksFromSettings", () => {
  it("returns undefined for undefined settings", () => {
    expect(getClaudeHooksFromSettings(undefined)).toBeUndefined();
  });

  it("returns undefined when hooks not present", () => {
    expect(getClaudeHooksFromSettings({})).toBeUndefined();
  });

  it("returns undefined when hooks.claude not present", () => {
    expect(getClaudeHooksFromSettings({ hooks: {} })).toBeUndefined();
  });

  it("returns claude hooks config", () => {
    const settings = {
      hooks: {
        claude: {
          PreToolUse: [{ matcher: "Bash", hooks: [] }],
        },
      },
    };
    const config = getClaudeHooksFromSettings(settings);
    expect(config).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [] }],
    });
  });
});
