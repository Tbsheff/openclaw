Goal (incl. success criteria):

- Re-review updated spec + task specs for Claude Code-style hooks system in OpenClaw and deliver plan review verdict.

Constraints/Assumptions:

- Follow repo rules in `AGENTS.md` (docs linking, commit rules, no Carbon updates, etc.).
- Maintain this ledger and update on state changes.

Key decisions:

- Review outcome: SHIP — Stop hook now uses verified `activeSession.prompt()` inside runEmbeddedAttempt with max retries; epic/task alignment resolved.

State:

- Re-review completed; verdict ready to deliver.

Done:

- Read continuity ledger at start of turn.

Now:

- Deliver Carmack-level plan review verdict.

Next:

- Deliver Carmack-level plan review verdict.

Open questions (UNCONFIRMED if needed):

- How should `permission_mode` be sourced for hook input (no current field found in codebase)?

Working set (files/ids/commands):

- `AGENTS.md`
- `.flow/specs/fn-1-add-claude-code-style-hooks-system.md`
- `.flow/tasks/fn-1-add-claude-code-style-hooks-system.*.md`
- `src/plugins/hooks.ts`
- `src/plugins/types.ts`
- `src/hooks/internal-hooks.ts`
- `src/config/zod-schema.hooks.ts`
- `src/config/types.hooks.ts`
- `src/agents/pi-tools.before-tool-call.ts`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts`
- `src/gateway/hooks.ts`
- `src/agents/tools/sessions-spawn-tool.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/pi-embedded-subscribe.ts`
- `src/agents/pi-embedded-runner/compact.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`
- `src/config/zod-schema.ts`
