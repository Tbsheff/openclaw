# fn-1-add-claude-code-style-hooks-system.7 PreCompact hook integration

## Description

Implement PreCompact hook that fires before context compaction. Fire-and-forget (cannot prevent compaction).

**Size:** S
**Files:**

- `src/agents/pi-embedded-runner/compact.ts` (modify)
- `src/hooks/claude-style/hooks/pre-compact.ts` (new)

## Approach

- Hook into `compactEmbeddedPiSessionDirect()` at `src/agents/pi-embedded-runner/compact.ts:112-150`
- Fire before compaction begins
- Hook receives session context, can log or trigger external actions
- Fire-and-forget (doesn't block compaction)

## Integration Point

At `src/agents/pi-embedded-runner/compact.ts:120-125`, before compaction logic:

```typescript
// NEW: PreCompact hook (fire-and-forget)
runPreCompactHooks({
  session_id: sessionKey,
  message_count: messages.length,
  token_estimate: tokenCount,
  cwd: process.cwd(),
}).catch(logError);

// Existing compaction logic continues...
```

## Key Context

- Existing `before_compaction` plugin hook at `src/plugins/hooks.ts:216-221` is void
- Compaction happens when context approaches token limit
- Hook useful for logging, external backup, analytics

## Acceptance

- [ ] `runPreCompactHooks()` fires before context compaction
- [ ] Hook receives session_id, message_count, token_estimate
- [ ] Hook runs fire-and-forget (doesn't block compaction)
- [ ] Errors logged but don't prevent compaction
- [ ] Integration test: PreCompact fires before compaction

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
