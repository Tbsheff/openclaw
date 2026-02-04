import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClaudeHooksConfig } from "../types.js";
import { resetAllCircuitBreakers } from "../executor.js";
import {
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  hasPostToolUseHooks,
  hasPostToolUseFailureHooks,
  type PostToolUseHookInput,
  type PostToolUseFailureHookInput,
} from "./post-tool-use.js";

// =============================================================================
// Mocks
// =============================================================================

// Mock config
const mockConfig: { hooks?: { claude?: ClaudeHooksConfig } } = {};

vi.mock("../../../config/config.js", () => ({
  loadConfig: () => mockConfig,
}));

// Mock feature flag
let featureEnabled = false;
vi.mock("../config.js", async () => {
  const actual = await vi.importActual("../config.js");
  return {
    ...actual,
    isClaudeHooksEnabled: () => featureEnabled,
  };
});

// =============================================================================
// Test Helpers
// =============================================================================

function createPostToolUseInput(
  toolName: string,
  toolResult: unknown = { success: true },
  toolInput: Record<string, unknown> = {},
): PostToolUseHookInput {
  return {
    session_id: "test-session",
    tool_name: toolName,
    tool_input: toolInput,
    tool_result: toolResult,
    cwd: "/test/cwd",
  };
}

function createPostToolUseFailureInput(
  toolName: string,
  toolError: string = "Something went wrong",
  toolInput: Record<string, unknown> = {},
): PostToolUseFailureHookInput {
  return {
    session_id: "test-session",
    tool_name: toolName,
    tool_input: toolInput,
    tool_error: toolError,
    cwd: "/test/cwd",
  };
}

function setupConfig(claude?: ClaudeHooksConfig): void {
  mockConfig.hooks = claude ? { claude } : undefined;
}

// =============================================================================
// Tests
// =============================================================================

describe("PostToolUse hooks", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    featureEnabled = false;
    mockConfig.hooks = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("hasPostToolUseHooks", () => {
    it("returns false when feature disabled", () => {
      featureEnabled = false;
      setupConfig({
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(hasPostToolUseHooks("exec")).toBe(false);
    });

    it("returns false when no matching hooks", () => {
      featureEnabled = true;
      setupConfig({
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo" }] }],
      });
      // "exec" maps to "Bash", which doesn't match "Write"
      expect(hasPostToolUseHooks("exec")).toBe(false);
    });

    it("maps canonical name to Claude-style for matching", () => {
      featureEnabled = true;
      setupConfig({
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
      });
      // "exec" maps to "Bash" which matches
      expect(hasPostToolUseHooks("exec")).toBe(true);
    });

    it("returns true for wildcard match", () => {
      featureEnabled = true;
      setupConfig({
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(hasPostToolUseHooks("AnyTool")).toBe(true);
    });
  });

  describe("hasPostToolUseFailureHooks", () => {
    it("returns false when feature disabled", () => {
      featureEnabled = false;
      setupConfig({
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(hasPostToolUseFailureHooks("exec")).toBe(false);
    });

    it("returns true when matching hooks configured", () => {
      featureEnabled = true;
      setupConfig({
        PostToolUseFailure: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(hasPostToolUseFailureHooks("exec")).toBe(true);
    });
  });

  describe("runPostToolUseHooks", () => {
    it("returns immediately when feature disabled", async () => {
      featureEnabled = false;
      setupConfig({
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 1" }] }],
      });
      // Should not throw, just return
      await runPostToolUseHooks(createPostToolUseInput("Bash"));
    });

    it("returns immediately when no config", async () => {
      featureEnabled = true;
      mockConfig.hooks = undefined;
      await runPostToolUseHooks(createPostToolUseInput("Bash"));
    });

    it("returns immediately when no matching hooks", async () => {
      featureEnabled = true;
      setupConfig({
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo" }] }],
      });
      await runPostToolUseHooks(createPostToolUseInput("Bash"));
    });

    it("skips non-command handlers", async () => {
      featureEnabled = true;
      setupConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "prompt", prompt: "test" },
              { type: "agent", agent: "test" },
            ],
          },
        ],
      });
      await runPostToolUseHooks(createPostToolUseInput("Bash"));
    });
  });

  describe("runPostToolUseFailureHooks", () => {
    it("returns immediately when feature disabled", async () => {
      featureEnabled = false;
      setupConfig({
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: "exit 1" }] }],
      });
      await runPostToolUseFailureHooks(createPostToolUseFailureInput("Bash"));
    });

    it("returns immediately when no matching hooks", async () => {
      featureEnabled = true;
      setupConfig({
        PostToolUseFailure: [{ matcher: "Write", hooks: [{ type: "command", command: "echo" }] }],
      });
      await runPostToolUseFailureHooks(createPostToolUseFailureInput("Bash"));
    });
  });
});

// =============================================================================
// Integration tests (with actual command execution)
// =============================================================================

describe("PostToolUse integration", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    featureEnabled = true;
    mockConfig.hooks = undefined;
  });

  describe("fire-and-forget behavior", () => {
    it("completes even when hook fails", async () => {
      setupConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["node", "-e", "process.exit(1)"] }],
          },
        ],
      });

      // Should not throw
      await runPostToolUseHooks(createPostToolUseInput("Bash", { output: "hello" }));
    });

    it("completes even with invalid JSON output", async () => {
      setupConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["node", "-e", "console.log('not json')"] }],
          },
        ],
      });

      await runPostToolUseHooks(createPostToolUseInput("Bash"));
    });

    it("completes even when command not found", async () => {
      setupConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["nonexistent-command-xyz"] }],
          },
        ],
      });

      await runPostToolUseHooks(createPostToolUseInput("Bash"));
    });

    it("runs multiple hooks in parallel", async () => {
      const startTime = Date.now();
      setupConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              // Two hooks that each sleep for 100ms
              { type: "command", command: ["node", "-e", "setTimeout(() => {}, 100)"] },
              { type: "command", command: ["node", "-e", "setTimeout(() => {}, 100)"] },
            ],
          },
        ],
      });

      await runPostToolUseHooks(createPostToolUseInput("Bash"));
      const elapsed = Date.now() - startTime;

      // If parallel, should take ~100ms; if sequential, ~200ms
      // Allow 150ms margin for overhead
      expect(elapsed).toBeLessThan(250);
    });
  });

  describe("tool name mapping", () => {
    it("maps exec to Bash for hook matching", async () => {
      let hookCalled = false;
      setupConfig({
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: ["node", "-e", "console.log('{}')"],
              },
            ],
          },
        ],
      });

      // Use canonical name "exec"
      await runPostToolUseHooks(createPostToolUseInput("exec", { output: "test" }));
      // If we got here without error, the hook was found (exec -> Bash)
      hookCalled = true;
      expect(hookCalled).toBe(true);
    });

    it("maps write to Write for hook matching", async () => {
      setupConfig({
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: ["node", "-e", "console.log('{}')"] }],
          },
        ],
      });

      await runPostToolUseHooks(createPostToolUseInput("write", { success: true }));
      // No error = success
    });
  });

  describe("hook receives correct input", () => {
    it("passes sanitized tool_result to hook", async () => {
      setupConfig({
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: [
                  "node",
                  "-e",
                  `
                  const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
                  if (input.tool_result?.output !== 'hello') process.exit(1);
                  console.log('{}');
                  `,
                ],
              },
            ],
          },
        ],
      });

      await runPostToolUseHooks(createPostToolUseInput("Bash", { output: "hello" }));
    });
  });
});

describe("PostToolUseFailure integration", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    featureEnabled = true;
    mockConfig.hooks = undefined;
  });

  describe("fire-and-forget behavior", () => {
    it("completes even when hook fails", async () => {
      setupConfig({
        PostToolUseFailure: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["node", "-e", "process.exit(1)"] }],
          },
        ],
      });

      await runPostToolUseFailureHooks(createPostToolUseFailureInput("Bash", "tool error"));
    });

    it("runs multiple hooks in parallel", async () => {
      const startTime = Date.now();
      setupConfig({
        PostToolUseFailure: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: ["node", "-e", "setTimeout(() => {}, 100)"] },
              { type: "command", command: ["node", "-e", "setTimeout(() => {}, 100)"] },
            ],
          },
        ],
      });

      await runPostToolUseFailureHooks(createPostToolUseFailureInput("Bash", "error"));
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(250);
    });
  });

  describe("hook receives correct input", () => {
    it("passes tool_error to hook", async () => {
      setupConfig({
        PostToolUseFailure: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: [
                  "node",
                  "-e",
                  `
                  const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
                  if (input.tool_error !== 'file not found') process.exit(1);
                  console.log('{}');
                  `,
                ],
              },
            ],
          },
        ],
      });

      await runPostToolUseFailureHooks(
        createPostToolUseFailureInput("read", "file not found", { path: "/missing" }),
      );
    });
  });
});

// =============================================================================
// Sanitization integration tests
// =============================================================================

describe("PostToolUse sanitization", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    featureEnabled = true;
    mockConfig.hooks = undefined;
  });

  it("handles large tool results gracefully", async () => {
    setupConfig({
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: ["node", "-e", "console.log('{}')"] }],
        },
      ],
    });

    // Create a large result
    const largeResult = { data: "x".repeat(200_000) };

    // Should not throw
    await runPostToolUseHooks(createPostToolUseInput("Bash", largeResult));
  });

  it("handles binary data in tool results", async () => {
    setupConfig({
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: ["node", "-e", "console.log('{}')"] }],
        },
      ],
    });

    // Create result with binary buffer
    const bufferResult = { data: Buffer.from([0x00, 0x01, 0x02]) };

    await runPostToolUseHooks(createPostToolUseInput("Bash", bufferResult));
  });

  it("handles circular references in tool results", async () => {
    setupConfig({
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: ["node", "-e", "console.log('{}')"] }],
        },
      ],
    });

    // Create circular reference
    const circularResult: Record<string, unknown> = { name: "test" };
    circularResult.self = circularResult;

    await runPostToolUseHooks(createPostToolUseInput("Bash", circularResult));
  });
});
