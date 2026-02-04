# fn-1-add-claude-code-style-hooks-system.4 PostToolUse and PostToolUseFailure hooks

## Description

Integrate PostToolUse and PostToolUseFailure hooks after tool execution completes. Fire-and-forget, cannot block. Tool results are **sanitized** before passing to hooks.

**Size:** M

**Files:**

- `src/agents/pi-embedded-subscribe.handlers.tools.ts` (modify)
- `src/hooks/claude-style/hooks/post-tool-use.ts` (new)
- `src/hooks/claude-style/sanitize.ts` (new)
- `src/hooks/claude-style/hooks/post-tool-use.test.ts` (new)

## Approach

- Hook into `handleToolExecutionEnd()` at `src/agents/pi-embedded-subscribe.handlers.tools.ts:148-229`
- Fire PostToolUse on success, PostToolUseFailure on error
- Run async (fire-and-forget) - don't block agent flow
- **Sanitize tool results** to avoid JSON protocol issues

## Result Sanitization

Tool results may contain binary data, large buffers, or non-JSON-safe values:

```typescript
function sanitizeForHook(result: unknown): unknown {
  // 1. Truncate strings over 100KB
  // 2. Replace binary buffers with placeholder
  // 3. Limit object depth to 10
  // 4. Remove circular references
  // 5. Ensure JSON-serializable
  return JSON.parse(JSON.stringify(result, replacer, 2).slice(0, 100_000));
}
```

## Acceptance

- [ ] `runPostToolUseHooks()` fires after successful tool execution
- [ ] `runPostToolUseFailureHooks()` fires after failed tool execution
- [ ] `sanitizeForHook()` handles binary data, large strings, circular refs
- [ ] Tool results **sanitized** before passing to hooks
- [ ] Hook receives tool_name, tool_input, sanitized tool_result (or tool_error)
- [ ] Hooks run async (fire-and-forget, don't block agent)
- [ ] Multiple hooks can run in parallel
- [ ] Errors logged but don't crash agent
- [ ] Unit tests for sanitization (binary, large, circular)
- [ ] Integration test: PostToolUse fires after Write tool
- [ ] Integration test: PostToolUseFailure fires on tool error
