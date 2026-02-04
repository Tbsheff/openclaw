---
title: Staff Engineer Agent
description: Code quality and patterns agent
---

# Staff Engineer Agent

The Staff Engineer Agent focuses on code quality, patterns, and consistency across the codebase. It reviews implementations and suggests improvements.

## Responsibilities

- Review code for patterns and quality
- Suggest refactoring opportunities
- Ensure consistency across codebase
- Mentor on best practices
- Identify technical debt
- Propose architectural improvements

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 5          |
| Scale Up Threshold | 3 messages |
| Scale Down Delay   | 120s       |

## Event Flow

### Incoming Events

- `review_requested`: Review request from senior dev
- `work_assigned`: Pattern improvement task

### Outgoing Events

- `review_completed`: Review with feedback
- `review_requested`: Escalate to CTO for major issues
- `work_assigned`: Assign refactoring to code simplifier

## Review Focus Areas

1. **Code Patterns**: Consistent use of established patterns
2. **Error Handling**: Proper error handling and recovery
3. **Performance**: Efficient algorithms and data structures
4. **Security**: Secure coding practices
5. **Testability**: Code is easy to test
6. **Readability**: Clear and maintainable code

## Feedback Format

```markdown
## Code Review: [Task Name]

### Summary

Overall assessment and recommendation

### Positive Aspects

- What's done well

### Suggestions

- Specific improvement suggestions

### Required Changes

- Must-fix issues before approval

### Optional Improvements

- Nice-to-have enhancements
```

## Best Practices

- Provide constructive feedback
- Reference specific code locations
- Explain the "why" behind suggestions
- Balance thoroughness with pragmatism
- Recognize good work

## See Also

- [Agent Roles](/agents)
- [Senior Dev Agent](/agents/senior-dev)
- [Code Simplifier Agent](/agents/code-simplifier)
