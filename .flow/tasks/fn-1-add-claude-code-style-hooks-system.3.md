# fn-1-add-claude-code-style-hooks-system.3 PreToolUse hook integration

## Description

Integrate PreToolUse hook at tool execution boundary. This hook can block tools or modify their input parameters.

**Size:** M
**Files:**

- `src/agents/pi-tools.before-tool-call.ts` (modify)
- `src/hooks/claude-style/hooks/pre-tool-use.ts` (new)
- `src/hooks/claude-style/hooks/pre-tool-use.test.ts` (new)

## Approach

- Hook into existing `runBeforeToolCallHook()` at `src/agents/pi-tools.before-tool-call.ts:19-65`
- Run Claude hooks BEFORE existing plugin hooks (Claude hooks are user-level policy)
- If blocked, return `{ blocked: true, reason }` - existing flow handles display

## Integration Point

At `src/agents/pi-tools.before-tool-call.ts:39-57`, after preparing context but before plugin hook:

```typescript
// NEW: Claude-style hooks first
const claudeResult = await runPreToolUseHooks({
  session_id: sessionKey,
  tool_name: toolName,
  tool_input: params,
  cwd: process.cwd(),
});
if (claudeResult.decision === 'deny') {
  return { blocked: true, reason: claudeResult.reason };
}
// Apply param modifications
const finalParams = claudeResult.updatedInput ?? params;

// Existing plugin hooks
const pluginResult = await hookRunner.runBeforeToolCall(...);
```

## Key Context

- Existing `wrapToolWithBeforeToolCallHook()` at line 67-91 wraps tool.execute()
- Tool name matching uses globs: `Bash`, `Bash*`, `*`
- Response with `updatedInput` merges into tool params

## Acceptance

- [ ] `runPreToolUseHooks()` fires before tool execution
- [ ] Hook receives tool_name, tool_input, session_id, cwd
- [ ] Decision "deny" blocks tool with reason shown to agent
- [ ] Decision "allow" proceeds with optional updatedInput
- [ ] `updatedInput` merged into tool params before execution
- [ ] Runs before existing plugin `before_tool_call` hooks
- [ ] Glob matching works for tool names (Bash, Bash*, *)
- [ ] Integration test: hook blocks `rm -rf` command
- [ ] Integration test: hook modifies params

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
