import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeHooksConfigSchema,
  ClaudeHookHandlerSchema,
  ClaudeHookRuleSchema,
  isClaudeHooksEnabled,
  parseClaudeHooksConfig,
} from "./config.js";

describe("ClaudeHookHandlerSchema", () => {
  it("validates command handler with string command", () => {
    const handler = {
      type: "command",
      command: "./hooks/check-cmd.sh",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(handler);
    }
  });

  it("validates command handler with string[] command", () => {
    const handler = {
      type: "command",
      command: ["./hooks/check-cmd.sh", "--verbose"],
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(handler);
    }
  });

  it("validates command handler with timeout", () => {
    const handler = {
      type: "command",
      command: "./hooks/slow-check.sh",
      timeout: 30,
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(handler);
    }
  });

  it("validates prompt handler", () => {
    const handler = {
      type: "prompt",
      prompt: "Is this tool call safe?",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(handler);
    }
  });

  it("validates prompt handler with model", () => {
    const handler = {
      type: "prompt",
      prompt: "Review this action",
      model: "anthropic/claude-3-haiku",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
  });

  it("validates agent handler", () => {
    const handler = {
      type: "agent",
      agent: "security-reviewer",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
  });

  it("validates agent handler with instructions", () => {
    const handler = {
      type: "agent",
      agent: "security-reviewer",
      instructions: "Focus on file system access patterns",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const handler = {
      type: "invalid",
      command: "./test.sh",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(false);
  });

  it("rejects command handler without command field", () => {
    const handler = {
      type: "command",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(false);
  });

  it("rejects prompt handler without prompt field", () => {
    const handler = {
      type: "prompt",
    };
    const result = ClaudeHookHandlerSchema.safeParse(handler);
    expect(result.success).toBe(false);
  });
});

describe("ClaudeHookRuleSchema", () => {
  it("validates a rule with matcher and hooks", () => {
    const rule = {
      matcher: "Bash*",
      hooks: [
        {
          type: "command",
          command: ["./hooks/check-cmd.sh"],
          timeout: 30,
        },
      ],
    };
    const result = ClaudeHookRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });

  it("validates a rule with glob pattern", () => {
    const rule = {
      matcher: "Write|Edit|*File*",
      hooks: [
        {
          type: "prompt",
          prompt: "Is this file modification safe?",
        },
      ],
    };
    const result = ClaudeHookRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });

  it("validates a rule with multiple hooks", () => {
    const rule = {
      matcher: "*",
      hooks: [
        { type: "command", command: "./pre-check.sh" },
        { type: "prompt", prompt: "Verify action" },
      ],
    };
    const result = ClaudeHookRuleSchema.safeParse(rule);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hooks).toHaveLength(2);
    }
  });

  it("rejects rule without matcher", () => {
    const rule = {
      hooks: [{ type: "command", command: "./test.sh" }],
    };
    const result = ClaudeHookRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
  });

  it("rejects rule without hooks", () => {
    const rule = {
      matcher: "*",
    };
    const result = ClaudeHookRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
  });
});

describe("ClaudeHooksConfigSchema", () => {
  it("validates full config with all events", () => {
    const config = {
      PreToolUse: [
        {
          matcher: "Bash*",
          hooks: [{ type: "command", command: ["./hooks/bash-guard.sh"] }],
        },
      ],
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "./hooks/log-tool.sh" }],
        },
      ],
      PostToolUseFailure: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "./hooks/alert-failure.sh" }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "*",
          hooks: [{ type: "prompt", prompt: "Is this prompt appropriate?" }],
        },
      ],
      Stop: [
        {
          matcher: "*",
          hooks: [{ type: "agent", agent: "continuation-decider" }],
        },
      ],
      SubagentStart: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "./hooks/subagent-start.sh" }],
        },
      ],
      SubagentStop: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "./hooks/subagent-stop.sh" }],
        },
      ],
      PreCompact: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "./hooks/pre-compact.sh" }],
        },
      ],
    };
    const result = ClaudeHooksConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("validates partial config", () => {
    const config = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "./check.sh" }],
        },
      ],
    };
    const result = ClaudeHooksConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("validates empty config", () => {
    const result = ClaudeHooksConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("validates undefined", () => {
    const result = ClaudeHooksConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("rejects unknown event types", () => {
    const config = {
      UnknownEvent: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "./test.sh" }],
        },
      ],
    };
    const result = ClaudeHooksConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("isClaudeHooksEnabled", () => {
  const originalEnv = process.env.OPENCLAW_CLAUDE_HOOKS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CLAUDE_HOOKS;
    } else {
      process.env.OPENCLAW_CLAUDE_HOOKS = originalEnv;
    }
  });

  it("returns true when env var is 1", () => {
    process.env.OPENCLAW_CLAUDE_HOOKS = "1";
    expect(isClaudeHooksEnabled()).toBe(true);
  });

  it("returns false when env var is not set", () => {
    delete process.env.OPENCLAW_CLAUDE_HOOKS;
    expect(isClaudeHooksEnabled()).toBe(false);
  });

  it("returns false when env var is 0", () => {
    process.env.OPENCLAW_CLAUDE_HOOKS = "0";
    expect(isClaudeHooksEnabled()).toBe(false);
  });

  it("returns false when env var is empty", () => {
    process.env.OPENCLAW_CLAUDE_HOOKS = "";
    expect(isClaudeHooksEnabled()).toBe(false);
  });
});

describe("parseClaudeHooksConfig", () => {
  const originalEnv = process.env.OPENCLAW_CLAUDE_HOOKS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CLAUDE_HOOKS;
    } else {
      process.env.OPENCLAW_CLAUDE_HOOKS = originalEnv;
    }
  });

  it("returns undefined when feature is disabled", () => {
    delete process.env.OPENCLAW_CLAUDE_HOOKS;
    const config = {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "./test.sh" }] }],
    };
    expect(parseClaudeHooksConfig(config)).toBeUndefined();
  });

  it("parses config when feature is enabled", () => {
    process.env.OPENCLAW_CLAUDE_HOOKS = "1";
    const config = {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "./test.sh" }] }],
    };
    const result = parseClaudeHooksConfig(config);
    expect(result).toEqual(config);
  });
});
