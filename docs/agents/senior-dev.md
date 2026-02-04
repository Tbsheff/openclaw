---
title: Senior Dev Agent
description: Implementation and coding agent
---

# Senior Dev Agent

The Senior Dev Agent is the primary implementation agent, responsible for writing production code based on specifications from the architect.

## Responsibilities

- Implement features from specifications
- Write production-quality code
- Handle complex coding tasks
- Follow architectural guidelines
- Create unit tests
- Document code appropriately

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 10         |
| Scale Up Threshold | 2 messages |
| Scale Down Delay   | 60s        |

The Senior Dev role has high scalability to handle parallel implementation tasks.

## Event Flow

### Incoming Events

- `work_assigned`: Implementation task from architect

### Outgoing Events

- `work_completed`: Implementation finished
- `review_requested`: Request review from staff engineer

## Implementation Process

1. **Spec Review**: Understand requirements and design
2. **Planning**: Break down into coding steps
3. **Implementation**: Write code following patterns
4. **Testing**: Create unit tests
5. **Documentation**: Add inline docs and comments
6. **Submission**: Request review

## Code Quality Standards

- Follow existing codebase patterns
- Write comprehensive tests
- Keep functions focused and small
- Use meaningful variable names
- Handle errors appropriately
- Add JSDoc comments for public APIs

## Best Practices

- Read specs thoroughly before starting
- Ask clarifying questions early
- Commit frequently with good messages
- Run tests before submitting
- Keep changes focused on the task

## See Also

- [Agent Roles](/agents)
- [Architect Agent](/agents/architect)
- [Staff Engineer Agent](/agents/staff-engineer)
