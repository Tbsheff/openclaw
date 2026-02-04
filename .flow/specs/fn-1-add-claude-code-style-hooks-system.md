# Add Claude Code-style Hooks System

## Overview

Add a rich hook system to OpenClaw that mirrors Claude Code's hook architecture. Enables users to intercept, modify, and block agent actions via shell scripts, LLM prompts, or subagents.

## Scope

### In Scope

- 8 hook events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStart, SubagentStop, PreCompact
- 3 handler types: command (shell), prompt (LLM eval), agent (subagent)
- JSON stdin/stdout protocol with exit code semantics
- Glob-based tool matchers (picomatch)
- Settings.json `hooks.claude` configuration
- Feature flag `OPENCLAW_CLAUDE_HOOKS=1`

### Out of Scope

- SessionStart/SessionEnd (use existing `session` internal hook)
- Notification/PermissionRequest events
- GUI hook management

## Key Design Decisions

### Command Handler Execution

- `string[]` → use directly as argv
- `string` → parse via shell-quote, validate tokens are strings

### Hook Input - permission_mode Optional

No current source in codebase. Optional until mapping established.

### Stop Hook - Internal Continuation Loop

Stop hook is integrated **within** `runEmbeddedAttempt()` (src/agents/pi-embedded-runner/run/attempt.ts) as a self-contained continuation loop:

- Wraps existing `activeSession.prompt()` call (lines 804-808) in a retry loop
- Fires after each prompt completes (around line 830)
- If denied, calls `activeSession.prompt(continuationMessage)` to continue
- Max 3 retries to prevent infinite loops
- Works for ALL callers automatically (CLI, gateway, cron, probes, hooks)
- Uses verified `activeSession.prompt()` API from @mariozechner/pi-coding-agent

### SubagentStop Observe-Only

Subagent registry is announce/cleanup only. Cannot reject/retry.

### Tool Result Sanitization

PostToolUse receives sanitized results (truncated, no binary).

## Implementation Phases

### Phase 1: Hook Infrastructure (Tasks 1-2)

Types, Zod schemas, root schema wiring, executor with execFile + picomatch

### Phase 2: Tool Lifecycle Hooks (Tasks 3-4)

PreToolUse (block/modify), PostToolUse/Failure (sanitized, fire-and-forget)

### Phase 3: Agent Lifecycle Hooks (Tasks 5-6)

UserPromptSubmit (all channels), Stop (internal continuation loop), Subagent (observe)

### Phase 4: Compaction & Docs (Tasks 7-8)

PreCompact (fire-and-forget), Documentation, CHANGELOG

## Acceptance Criteria

- [ ] PreToolUse can block/modify tool params
- [ ] PostToolUse fires with sanitized result
- [ ] PostToolUseFailure fires on tool error
- [ ] UserPromptSubmit intercepts ALL channels via dispatch-from-config.ts
- [ ] Stop fires in runEmbeddedAttempt(), uses internal continuation loop
- [ ] Stop uses activeSession.prompt() for continuation (verified PI agent API)
- [ ] Stop has max 3 retries
- [ ] All runEmbeddedAttempt() callers get Stop behavior automatically
- [ ] SubagentStart can inject context
- [ ] SubagentStop is observe-only
- [ ] PreCompact fires before compaction
- [ ] Command handlers use execFile with validated argv
- [ ] shell-quote tokens validated
- [ ] Glob matching uses picomatch
- [ ] Feature flag gates functionality
- [ ] Config wired through root schema

## References

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [picomatch](https://github.com/micromatch/picomatch)
- [shell-quote](https://github.com/substack/node-shell-quote)
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts` (Stop hook integration)
