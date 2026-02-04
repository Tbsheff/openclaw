/**
 * Tests for UserPromptSubmit hook integration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before imports
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../config.js", () => ({
  isClaudeHooksEnabled: vi.fn(),
}));

vi.mock("../executor.js", () => ({
  runClaudeHook: vi.fn(),
}));

vi.mock("../registry.js", () => ({
  matchHooks: vi.fn(),
}));

import { loadConfig } from "../../../config/config.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";
import { matchHooks } from "../registry.js";
import { hasUserPromptSubmitHooks, runUserPromptSubmitHooks } from "./user-prompt.js";

describe("UserPromptSubmit hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runUserPromptSubmitHooks", () => {
    it("should return allow when hooks disabled", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(false);

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Hello world",
        channel: "telegram",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
      expect(result.modifiedPrompt).toBeUndefined();
    });

    it("should return allow when no config", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([]);

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Hello world",
        channel: "telegram",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should return allow when no handlers match", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: { UserPromptSubmit: [] },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([]);

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Hello world",
        channel: "telegram",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should return deny when handler blocks with exit code 2", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        blocked: true,
        reason: "Forbidden content",
      });

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "bad content",
        channel: "whatsapp",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("Forbidden content");
    });

    it("should return deny when handler output has deny decision", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        success: true,
        output: { decision: "deny", reason: "Content policy violation" },
      });

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "bad content",
        channel: "cli",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("Content policy violation");
    });

    it("should modify prompt when handler provides new prompt", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        success: true,
        output: { decision: "allow", prompt: "Modified: Hello world" },
      });

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Hello world",
        channel: "http",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
      expect(result.modifiedPrompt).toBe("Modified: Hello world");
    });

    it("should continue on error and allow", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        error: true,
        message: "Command failed",
      });

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Hello world",
        channel: "telegram",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should skip non-command handlers", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "prompt", prompt: "test" }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "prompt", prompt: "test" }]);

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Hello world",
        channel: "telegram",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
      expect(runClaudeHook).not.toHaveBeenCalled();
    });

    it("should return ask when handler returns ask decision", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        success: true,
        output: { decision: "ask", reason: "Need confirmation" },
      });

      const result = await runUserPromptSubmitHooks({
        session_id: "test-session",
        prompt: "Delete everything",
        channel: "telegram",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("ask");
      expect(result.reason).toBe("Need confirmation");
    });
  });

  describe("hasUserPromptSubmitHooks", () => {
    it("should return false when hooks disabled", () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(false);

      expect(hasUserPromptSubmitHooks()).toBe(false);
    });

    it("should return false when no handlers", () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: { claude: {} },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([]);

      expect(hasUserPromptSubmitHooks()).toBe(false);
    });

    it("should return true when handlers exist", () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);

      expect(hasUserPromptSubmitHooks()).toBe(true);
    });
  });
});
