import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClaudeHooksConfig } from "../types.js";
import { resetAllCircuitBreakers } from "../executor.js";
import {
  runPreToolUseHooks,
  hasPreToolUseHooks,
  getClaudeHooksConfig,
  toClaudeStyleName,
  type PreToolUseHookInput,
} from "./pre-tool-use.js";

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

function createTestInput(
  toolName: string,
  toolInput: Record<string, unknown> = {},
): PreToolUseHookInput {
  return {
    session_id: "test-session",
    tool_name: toolName,
    tool_input: toolInput,
    cwd: "/test/cwd",
  };
}

function setupConfig(claude?: ClaudeHooksConfig): void {
  mockConfig.hooks = claude ? { claude } : undefined;
}

// =============================================================================
// Tests
// =============================================================================

describe("PreToolUse hooks", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    featureEnabled = false;
    mockConfig.hooks = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("toClaudeStyleName", () => {
    it("maps canonical names to Claude-style names", () => {
      expect(toClaudeStyleName("exec")).toBe("Bash");
      expect(toClaudeStyleName("read")).toBe("Read");
      expect(toClaudeStyleName("write")).toBe("Write");
      expect(toClaudeStyleName("edit")).toBe("Edit");
      expect(toClaudeStyleName("glob")).toBe("Glob");
      expect(toClaudeStyleName("grep")).toBe("Grep");
    });

    it("returns original name if no mapping exists", () => {
      expect(toClaudeStyleName("mcp__custom__tool")).toBe("mcp__custom__tool");
      expect(toClaudeStyleName("unknown_tool")).toBe("unknown_tool");
    });
  });

  describe("getClaudeHooksConfig", () => {
    it("returns undefined when feature flag is disabled", () => {
      featureEnabled = false;
      setupConfig({
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(getClaudeHooksConfig()).toBeUndefined();
    });

    it("returns undefined when no claude config", () => {
      featureEnabled = true;
      mockConfig.hooks = undefined;
      expect(getClaudeHooksConfig()).toBeUndefined();
    });

    it("returns config when feature enabled and config present", () => {
      featureEnabled = true;
      const config: ClaudeHooksConfig = {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      };
      setupConfig(config);
      expect(getClaudeHooksConfig()).toEqual(config);
    });
  });

  describe("hasPreToolUseHooks", () => {
    it("returns false when feature disabled", () => {
      featureEnabled = false;
      setupConfig({
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(hasPreToolUseHooks("exec")).toBe(false);
    });

    it("returns false when no matching hooks", () => {
      featureEnabled = true;
      setupConfig({
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo" }] }],
      });
      // "exec" maps to "Bash", which doesn't match "Write"
      expect(hasPreToolUseHooks("exec")).toBe(false);
    });

    it("maps canonical name to Claude-style for matching", () => {
      featureEnabled = true;
      setupConfig({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }],
      });
      // "exec" maps to "Bash" which matches
      expect(hasPreToolUseHooks("exec")).toBe(true);
    });

    it("returns true for glob match", () => {
      featureEnabled = true;
      setupConfig({
        PreToolUse: [{ matcher: "Bash*", hooks: [{ type: "command", command: "echo" }] }],
      });
      // "exec" maps to "Bash" which matches "Bash*"
      expect(hasPreToolUseHooks("exec")).toBe(true);
    });

    it("returns true for wildcard match", () => {
      featureEnabled = true;
      setupConfig({
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
      });
      expect(hasPreToolUseHooks("AnyTool")).toBe(true);
    });
  });

  describe("runPreToolUseHooks", () => {
    it("returns allow when feature disabled", async () => {
      featureEnabled = false;
      setupConfig({
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 2" }] }],
      });
      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });

    it("returns allow when no config", async () => {
      featureEnabled = true;
      mockConfig.hooks = undefined;
      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });

    it("returns allow when no matching hooks", async () => {
      featureEnabled = true;
      setupConfig({
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "exit 2" }] }],
      });
      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });

    it("skips non-command handlers", async () => {
      featureEnabled = true;
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "prompt", prompt: "test" },
              { type: "agent", agent: "test" },
            ],
          },
        ],
      });
      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });
  });

  describe("glob matching", () => {
    const dummyHook = { type: "command" as const, command: "echo" };

    beforeEach(() => {
      featureEnabled = true;
    });

    it("matches exact tool name", async () => {
      setupConfig({ PreToolUse: [{ matcher: "Bash", hooks: [dummyHook] }] });
      expect(hasPreToolUseHooks("Bash")).toBe(true);
      expect(hasPreToolUseHooks("Write")).toBe(false);
    });

    it("matches with * wildcard at end", async () => {
      setupConfig({ PreToolUse: [{ matcher: "mcp__*", hooks: [dummyHook] }] });
      expect(hasPreToolUseHooks("mcp__filesystem__read")).toBe(true);
      expect(hasPreToolUseHooks("Bash")).toBe(false);
    });

    it("matches with * wildcard anywhere", async () => {
      setupConfig({ PreToolUse: [{ matcher: "*Tool*", hooks: [dummyHook] }] });
      expect(hasPreToolUseHooks("MyToolHelper")).toBe(true);
      expect(hasPreToolUseHooks("Bash")).toBe(false);
    });

    it("matches catch-all *", async () => {
      setupConfig({ PreToolUse: [{ matcher: "*", hooks: [dummyHook] }] });
      expect(hasPreToolUseHooks("Anything")).toBe(true);
    });
  });

  describe("input building", () => {
    it("passes correct fields to hook input", async () => {
      featureEnabled = true;
      // This is a structural test - we can't easily verify input without
      // actually running a command, but we ensure the function doesn't crash
      setupConfig({ PreToolUse: [] });
      const input = createTestInput("Bash", { command: "ls" });
      const result = await runPreToolUseHooks(input);
      expect(result.decision).toBe("allow");
    });
  });
});

// =============================================================================
// Integration tests (with actual command execution)
// =============================================================================

describe("PreToolUse integration", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    featureEnabled = true;
    mockConfig.hooks = undefined;
  });

  describe("blocking hooks", () => {
    it("blocks tool when exit code 2 (using canonical name)", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "Bash", // Claude-style name in config
            hooks: [
              {
                type: "command",
                command: ["node", "-e", "console.error('rm -rf blocked'); process.exit(2)"],
              },
            ],
          },
        ],
      });

      // Use canonical name "exec" - it maps to "Bash" for matching
      const result = await runPreToolUseHooks(createTestInput("exec", { command: "rm -rf /" }));
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("rm -rf blocked");
    });

    it("blocks tool when output decision is deny", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: [
                  "node",
                  "-e",
                  'console.log(JSON.stringify({decision:"deny",reason:"policy violation"}))',
                ],
              },
            ],
          },
        ],
      });

      // Use canonical name "write" - it maps to "Write"
      const result = await runPreToolUseHooks(createTestInput("write"));
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("policy violation");
    });

    it("returns ask decision when hook outputs ask", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: [
                  "node",
                  "-e",
                  'console.log(JSON.stringify({decision:"ask",reason:"needs approval"}))',
                ],
              },
            ],
          },
        ],
      });

      const result = await runPreToolUseHooks(createTestInput("exec"));
      expect(result.decision).toBe("ask");
      expect(result.reason).toBe("needs approval");
    });
  });

  describe("param modification", () => {
    it("merges updatedInput into result", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "Bash", // Claude-style name in config
            hooks: [
              {
                type: "command",
                command: [
                  "node",
                  "-e",
                  "console.log(JSON.stringify({updatedInput:{timeout:5000}}))",
                ],
              },
            ],
          },
        ],
      });

      // "exec" maps to "Bash"
      const result = await runPreToolUseHooks(createTestInput("exec", { command: "ls" }));
      expect(result.decision).toBe("allow");
      expect(result.updatedInput).toEqual({ timeout: 5000 });
    });

    it("accumulates updates from multiple hooks", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: ["node", "-e", 'console.log(JSON.stringify({updatedInput:{field1:"a"}}))'],
              },
              {
                type: "command",
                command: ["node", "-e", 'console.log(JSON.stringify({updatedInput:{field2:"b"}}))'],
              },
            ],
          },
        ],
      });

      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
      expect(result.updatedInput).toEqual({ field1: "a", field2: "b" });
    });
  });

  describe("error handling", () => {
    it("continues on hook error (non-zero exit, not 2)", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["node", "-e", "process.exit(1)"] }],
          },
        ],
      });

      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });

    it("continues on invalid JSON output", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["node", "-e", "console.log('not json')"] }],
          },
        ],
      });

      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });

    it("continues when command not found", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: ["nonexistent-command-xyz"] }],
          },
        ],
      });

      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("allow");
    });
  });

  describe("first deny wins", () => {
    it("stops at first deny", async () => {
      setupConfig({
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: [
                  "node",
                  "-e",
                  'console.log(JSON.stringify({decision:"deny",reason:"first"}))',
                ],
              },
              {
                type: "command",
                command: ["node", "-e", 'console.log(JSON.stringify({decision:"allow"}))'],
              },
            ],
          },
        ],
      });

      const result = await runPreToolUseHooks(createTestInput("Bash"));
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("first");
    });
  });
});
