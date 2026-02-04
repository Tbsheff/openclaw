---
title: CI Agent
description: Continuous integration and PR management agent
---

# CI Agent

The CI Agent manages the continuous integration pipeline, running tests, creating pull requests, and handling merges.

## Responsibilities

- Run automated tests
- Create pull requests
- Manage CI/CD pipeline
- Handle merge conflicts
- Update changelogs
- Coordinate releases

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 3          |
| Scale Up Threshold | 3 messages |
| Scale Down Delay   | 180s       |

## Event Flow

### Incoming Events

- `work_completed`: Implementation ready for CI
- `review_completed`: Approved for merge

### Outgoing Events

- `ci_status`: CI pipeline status update
- `work_completed`: PR merged successfully

## CI Pipeline Stages

1. **Checkout**: Get latest code
2. **Install**: Install dependencies
3. **Lint**: Run linting checks
4. **Type Check**: TypeScript compilation
5. **Test**: Run test suite
6. **Build**: Build artifacts
7. **PR Creation**: Open pull request
8. **Merge**: Merge to main branch

## PR Management

### PR Creation

```bash
# CI agent creates PRs with:
gh pr create \
  --title "feat: Add user authentication" \
  --body "## Summary\n- Implements OAuth2 flow\n- Adds JWT handling" \
  --base main
```

### PR Checks

- All tests passing
- No lint errors
- Type check passes
- Code coverage maintained
- Review approved

### Merge Strategy

- Prefer squash merge for clean history
- Rebase for important commit history
- Always update changelog

## Status Events

| Status    | Description               |
| --------- | ------------------------- |
| `pending` | CI pipeline starting      |
| `running` | Tests in progress         |
| `success` | All checks passed         |
| `failure` | One or more checks failed |
| `merged`  | PR successfully merged    |

## Best Practices

- Run full test suite before PR
- Include meaningful PR descriptions
- Reference work item IDs
- Update changelog entries
- Clean up after merge

## See Also

- [Agent Roles](/agents)
- [Senior Dev Agent](/agents/senior-dev)
- [Staff Engineer Agent](/agents/staff-engineer)
