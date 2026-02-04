# fn-1-add-claude-code-style-hooks-system.2 Hook executor with command runner

## Description

Implement hook executor with command runner, glob matching, and error isolation.

**Size:** M

**Files:**

- `src/hooks/claude-style/executor.ts` (new)
- `src/hooks/claude-style/registry.ts` (new)
- `src/hooks/claude-style/executor.test.ts` (new)
- `package.json` (add picomatch, shell-quote deps)

## Approach

- Use `execFile` (not exec/spawn) with args array - no shell injection
- Command as `string[]` → use directly as argv
- Command as `string` → parse via `shell-quote`, validate tokens are strings only
- Use picomatch for glob matching tool names
- Use `AbortController` for timeouts, circuit breaker after 3 failures
- Read config from `hooks.claude[event]` path

## shell-quote Token Validation

shell-quote can return operators/redirects, not just strings. Validate:

```typescript
const tokens = parse(command);
const argv = tokens.filter((t): t is string => typeof t === "string");
if (argv.length !== tokens.length) {
  return { blocked: true, reason: "Command contains unsupported operators" };
}
```

## Acceptance

- [ ] `runClaudeHook()` executes command handlers via execFile
- [ ] Command `string[]` used directly as argv
- [ ] Command `string` parsed via shell-quote
- [ ] shell-quote tokens validated - reject non-string tokens (operators)
- [ ] JSON input written to stdin, JSON output read from stdout
- [ ] Exit code 0 parses stdout, 2 blocks with stderr, other logs and continues
- [ ] Timeout via AbortController (default 600s command, 30s prompt, 60s agent)
- [ ] `SIGTERM` → wait 5s → `SIGKILL` on timeout
- [ ] Circuit breaker disables hook after 3 consecutive failures
- [ ] `matchHooks()` uses picomatch, reads from `hooks.claude[event]`
- [ ] picomatch and shell-quote added to package.json
- [ ] Unit tests for executor and registry

## Done summary

- Task completed

## Evidence

- Commits:
- Tests:
- PRs:
