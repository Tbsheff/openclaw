/**
 * Tests for Stop hook integration.
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
import { hasStopHooks, runStopHooks } from "./stop.js";

describe("Stop hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runStopHooks", () => {
    it("should return allow when hooks disabled", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(false);

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should return allow when no config", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([]);

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should return allow when no handlers match", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: { Stop: [] },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([]);

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should return deny (continue) when handler blocks with exit code 2", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        blocked: true,
        reason: "Not done yet",
      });

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
        last_response: "I think I am done.",
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("Not done yet");
      expect(result.continuation_message).toBe("Not done yet");
    });

    it("should return deny when handler output has deny decision", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        success: true,
        output: {
          decision: "deny",
          reason: "More work needed",
          continuation_message: "Please continue with step 2",
        },
      });

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("More work needed");
      expect(result.continuation_message).toBe("Please continue with step 2");
    });

    it("should return allow when handler output has allow decision", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        success: true,
        output: { decision: "allow", reason: "Task completed" },
      });

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toBe("Task completed");
    });

    it("should continue on error and allow", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        error: true,
        message: "Command failed",
      });

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
    });

    it("should skip non-command handlers", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "prompt", prompt: "test" }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "prompt", prompt: "test" }]);

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("allow");
      expect(runClaudeHook).not.toHaveBeenCalled();
    });

    it("should use reason as continuation_message when continuation_message not provided", async () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);
      vi.mocked(runClaudeHook).mockResolvedValue({
        success: true,
        output: {
          decision: "deny",
          reason: "Keep going",
        },
      });

      const result = await runStopHooks({
        session_id: "test-session",
        cwd: "/tmp",
      });

      expect(result.decision).toBe("deny");
      expect(result.continuation_message).toBe("Keep going");
    });
  });

  describe("hasStopHooks", () => {
    it("should return false when hooks disabled", () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(false);

      expect(hasStopHooks()).toBe(false);
    });

    it("should return false when no handlers", () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: { claude: {} },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([]);

      expect(hasStopHooks()).toBe(false);
    });

    it("should return true when handlers exist", () => {
      vi.mocked(isClaudeHooksEnabled).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        hooks: {
          claude: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: ["test"] }] }],
          },
        },
      } as ReturnType<typeof loadConfig>);
      vi.mocked(matchHooks).mockReturnValue([{ type: "command", command: ["test"] }]);

      expect(hasStopHooks()).toBe(true);
    });
  });
});
