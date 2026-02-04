# fn-1-add-claude-code-style-hooks-system.1 Hook types and config schema

## Description

Create TypeScript types and Zod schemas for the Claude-style hook system.

**Size:** M

**Files:**

- `src/hooks/claude-style/types.ts` (new)
- `src/hooks/claude-style/config.ts` (new)
- `src/config/types.hooks.ts` (modify - add `claude` to HooksConfig)
- `src/config/zod-schema.hooks.ts` (modify)
- `src/config/zod-schema.ts` (modify - wire `claude` into root schema)

## Approach

- Follow discriminated union pattern from `src/plugins/types.ts:287-301`
- Add `claude?: ClaudeHooksConfig` to `HooksConfig` interface
- Add Zod schema to `zod-schema.hooks.ts` AND wire into root `zod-schema.ts`
- Gate parsing behind `OPENCLAW_CLAUDE_HOOKS=1` env var
- `permission_mode` is **optional** in hook input (no source currently exists)
- Command handler accepts `string | string[]` for command field

## Config Structure (settings.json)

```json
{
  "hooks": {
    "claude": {
      "PreToolUse": [
        {
          "matcher": "Bash*",
          "hooks": [
            {
              "type": "command",
              "command": ["./hooks/check-cmd.sh"],
              "timeout": 30
            }
          ]
        }
      ]
    }
  }
}
```

## Acceptance

- [ ] `ClaudeHookEvent` type covers all 8 events
- [ ] `ClaudeHookHandler` discriminated union with command/prompt/agent variants
- [ ] Command handler accepts `string | string[]` for command field
- [ ] `ClaudeHookInput` interface - `permission_mode` is OPTIONAL
- [ ] `ClaudeHookOutput` interface matching Claude Code protocol
- [ ] `ClaudeHookMatcher` type with glob pattern support
- [ ] Zod schemas in `zod-schema.hooks.ts`
- [ ] Root schema in `zod-schema.ts` wires `claude` into config
- [ ] `HooksConfig` interface updated with `claude?: ClaudeHooksConfig`
- [ ] Config parsing gated by `OPENCLAW_CLAUDE_HOOKS=1`
- [ ] Unit tests for schema validation
- [ ] Exports from `src/hooks/claude-style/index.ts`
