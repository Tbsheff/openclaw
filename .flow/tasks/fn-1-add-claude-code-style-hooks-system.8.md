# fn-1-add-claude-code-style-hooks-system.8 Documentation and changelog updates

## Description

Update documentation with 8 new hook events, feature flag, and limitations.

**Size:** S

**Files:**

- `docs/hooks.md` (modify)
- `CHANGELOG.md` (modify)

## Approach

- Document feature flag requirement (`OPENCLAW_CLAUDE_HOOKS=1`)
- Move 8 events from "Future Events" to "Event Types" section
- Document command handler supports `string | string[]`
- Note SubagentStop observe-only limitation
- Note Stop uses non-blocking continuation approach
- Add CHANGELOG entry for feature (behind flag)
- Follow Mintlify conventions per CLAUDE.md

## Acceptance

- [ ] docs/hooks.md: Feature flag `OPENCLAW_CLAUDE_HOOKS=1` documented
- [ ] docs/hooks.md: All 8 events documented with input/output/examples
- [ ] docs/hooks.md: Command `string | string[]` format documented
- [ ] docs/hooks.md: SubagentStop observe-only limitation noted
- [ ] docs/hooks.md: Stop non-blocking continuation approach noted
- [ ] docs/hooks.md: Events moved from "Future Events" to "Event Types"
- [ ] CHANGELOG.md: Entry for Claude-style hooks (behind flag)

## Done summary

Documented Claude Code-style hooks system in docs/hooks.md with all 8 events, feature flag requirement, command handler formats, and implementation notes. Added CHANGELOG entry.

## Evidence

- Commits:
- Tests:
- PRs:
