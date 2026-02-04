import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeHooksConfig } from "../types.js";
import {
  hasSubagentStartHooks,
  hasSubagentStopHooks,
  runSubagentStartHooks,
  runSubagentStopHooks,
} from "./subagent.js";

// Mock dependencies
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../config.js", () => ({
  isClaudeHooksEnabled: vi.fn(),
}));

vi.mock("../executor.js", () => ({
  runClaudeHook: vi.fn(),
}));

import { loadConfig } from "../../../config/config.js";
import { isClaudeHooksEnabled } from "../config.js";
import { runClaudeHook } from "../executor.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockIsEnabled = vi.mocked(isClaudeHooksEnabled);
const mockRunClaudeHook = vi.mocked(runClaudeHook);

describe("SubagentStart hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should allow when hooks disabled", async () => {
    mockIsEnabled.mockReturnValue(false);

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
      subagent_type: "task",
    });

    expect(result.decision).toBe("allow");
    expect(mockRunClaudeHook).not.toHaveBeenCalled();
  });

  it("should allow when no config", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({} as ReturnType<typeof loadConfig>);

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("allow");
    expect(mockRunClaudeHook).not.toHaveBeenCalled();
  });

  it("should allow when no SubagentStart hooks configured", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("allow");
    expect(mockRunClaudeHook).not.toHaveBeenCalled();
  });

  it("should allow and inject context from successful hook", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [
            { matcher: "*", hooks: [{ type: "command", command: ["node", "script.js"] }] },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      success: true,
      output: {
        decision: "allow",
        additionalContext: "Remember to follow coding standards",
      },
    });

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
      subagent_type: "task",
      task: "Implement feature X",
    });

    expect(result.decision).toBe("allow");
    expect(result.additionalContext).toBe("Remember to follow coding standards");
    expect(mockRunClaudeHook).toHaveBeenCalledWith(
      { type: "command", command: ["node", "script.js"] },
      expect.objectContaining({
        hook_event_name: "SubagentStart",
        session_id: "parent-session",
        subagent_id: "child-session",
        subagent_type: "task",
      }),
    );
  });

  it("should accumulate context from multiple hooks", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [
            { matcher: "*", hooks: [{ type: "command", command: "hook1" }] },
            { matcher: "*", hooks: [{ type: "command", command: "hook2" }] },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook
      .mockResolvedValueOnce({
        success: true,
        output: { additionalContext: "Context 1" },
      })
      .mockResolvedValueOnce({
        success: true,
        output: { additionalContext: "Context 2" },
      });

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("allow");
    expect(result.additionalContext).toBe("Context 1\nContext 2");
  });

  it("should deny when hook explicitly denies", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [{ matcher: "*", hooks: [{ type: "command", command: "deny-hook" }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      success: true,
      output: { decision: "deny", reason: "Subagent not allowed" },
    });

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("Subagent not allowed");
  });

  it("should deny when hook returns blocked", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [{ matcher: "*", hooks: [{ type: "command", command: "block-hook" }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      blocked: true,
      reason: "Blocked by policy",
    });

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("Blocked by policy");
  });

  it("should continue on hook error", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [
            { matcher: "*", hooks: [{ type: "command", command: "error-hook" }] },
            { matcher: "*", hooks: [{ type: "command", command: "success-hook" }] },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook
      .mockResolvedValueOnce({
        error: true,
        message: "Hook failed",
      })
      .mockResolvedValueOnce({
        success: true,
        output: { additionalContext: "From second hook" },
      });

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("allow");
    expect(result.additionalContext).toBe("From second hook");
  });

  it("should skip non-command handlers", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [
            {
              matcher: "*",
              hooks: [
                { type: "prompt", prompt: "Check subagent" } as never,
                { type: "command", command: "real-hook" },
              ],
            },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      success: true,
      output: { additionalContext: "From command hook" },
    });

    const result = await runSubagentStartHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(result.decision).toBe("allow");
    expect(result.additionalContext).toBe("From command hook");
    expect(mockRunClaudeHook).toHaveBeenCalledTimes(1);
  });
});

describe("SubagentStop hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should do nothing when hooks disabled", async () => {
    mockIsEnabled.mockReturnValue(false);

    await runSubagentStopHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(mockRunClaudeHook).not.toHaveBeenCalled();
  });

  it("should do nothing when no config", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({} as ReturnType<typeof loadConfig>);

    await runSubagentStopHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(mockRunClaudeHook).not.toHaveBeenCalled();
  });

  it("should fire observe-only hooks on completion", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStop: [{ matcher: "*", hooks: [{ type: "command", command: ["log-script"] }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      success: true,
      output: {},
    });

    await runSubagentStopHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
      subagent_outcome: { status: "ok" },
    });

    expect(mockRunClaudeHook).toHaveBeenCalledWith(
      { type: "command", command: ["log-script"] },
      expect.objectContaining({
        hook_event_name: "SubagentStop",
        session_id: "parent-session",
        subagent_id: "child-session",
        subagent_outcome: { status: "ok" },
      }),
    );
  });

  it("should ignore blocked responses (observe-only)", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStop: [{ matcher: "*", hooks: [{ type: "command", command: "block-hook" }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      blocked: true,
      reason: "Attempted to block",
    });

    // Should not throw, just log and continue
    await expect(
      runSubagentStopHooks({
        session_id: "parent-session",
        subagent_id: "child-session",
      }),
    ).resolves.toBeUndefined();

    expect(mockRunClaudeHook).toHaveBeenCalled();
  });

  it("should handle errors gracefully (fire-and-forget)", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStop: [
            { matcher: "*", hooks: [{ type: "command", command: "error-hook" }] },
            { matcher: "*", hooks: [{ type: "command", command: "success-hook" }] },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook
      .mockResolvedValueOnce({
        error: true,
        message: "Hook failed",
      })
      .mockResolvedValueOnce({
        success: true,
        output: {},
      });

    // Should not throw despite error
    await expect(
      runSubagentStopHooks({
        session_id: "parent-session",
        subagent_id: "child-session",
      }),
    ).resolves.toBeUndefined();

    expect(mockRunClaudeHook).toHaveBeenCalledTimes(2);
  });

  it("should handle exceptions gracefully", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStop: [
            { matcher: "*", hooks: [{ type: "command", command: "throw-hook" }] },
            { matcher: "*", hooks: [{ type: "command", command: "success-hook" }] },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockRejectedValueOnce(new Error("Unexpected error")).mockResolvedValueOnce({
      success: true,
      output: {},
    });

    // Should not throw despite exception
    await expect(
      runSubagentStopHooks({
        session_id: "parent-session",
        subagent_id: "child-session",
      }),
    ).resolves.toBeUndefined();

    expect(mockRunClaudeHook).toHaveBeenCalledTimes(2);
  });

  it("should skip non-command handlers", async () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStop: [
            {
              matcher: "*",
              hooks: [
                { type: "agent", agent: "logger" } as never,
                { type: "command", command: "real-hook" },
              ],
            },
          ],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);

    mockRunClaudeHook.mockResolvedValue({
      success: true,
      output: {},
    });

    await runSubagentStopHooks({
      session_id: "parent-session",
      subagent_id: "child-session",
    });

    expect(mockRunClaudeHook).toHaveBeenCalledTimes(1);
  });
});

describe("hasSubagentStartHooks", () => {
  it("should return false when disabled", () => {
    mockIsEnabled.mockReturnValue(false);
    expect(hasSubagentStartHooks()).toBe(false);
  });

  it("should return false when no config", () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({} as ReturnType<typeof loadConfig>);
    expect(hasSubagentStartHooks()).toBe(false);
  });

  it("should return true when hooks configured", () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStart: [{ matcher: "*", hooks: [{ type: "command", command: "hook" }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);
    expect(hasSubagentStartHooks()).toBe(true);
  });
});

describe("hasSubagentStopHooks", () => {
  it("should return false when disabled", () => {
    mockIsEnabled.mockReturnValue(false);
    expect(hasSubagentStopHooks()).toBe(false);
  });

  it("should return false when no config", () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({} as ReturnType<typeof loadConfig>);
    expect(hasSubagentStopHooks()).toBe(false);
  });

  it("should return true when hooks configured", () => {
    mockIsEnabled.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
      hooks: {
        claude: {
          SubagentStop: [{ matcher: "*", hooks: [{ type: "command", command: "hook" }] }],
        } as ClaudeHooksConfig,
      },
    } as ReturnType<typeof loadConfig>);
    expect(hasSubagentStopHooks()).toBe(true);
  });
});
