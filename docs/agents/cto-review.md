---
title: CTO Review Agent
description: Executive oversight and approval agent
---

# CTO Review Agent

The CTO Review Agent provides executive-level oversight, approving major design decisions and ensuring alignment with project goals and standards.

## Responsibilities

- Review major architectural decisions
- Approve significant code changes
- Ensure alignment with project goals
- Provide strategic feedback
- Guard against technical debt
- Enforce coding standards

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 2          |
| Scale Up Threshold | 5 messages |
| Scale Down Delay   | 300s       |

## Event Flow

### Incoming Events

- `review_requested`: Review request from architect or staff engineer

### Outgoing Events

- `review_completed`: Review finished with approval/rejection
- `work_assigned`: Approved work sent to implementation

## Review Criteria

The CTO agent evaluates:

1. **Architecture Alignment**: Does the design fit existing patterns?
2. **Scalability**: Will this scale with expected growth?
3. **Security**: Are there security implications?
4. **Maintainability**: Is this code maintainable long-term?
5. **Cost**: What are the resource implications?

## Review Outcomes

| Outcome                 | Description                 |
| ----------------------- | --------------------------- |
| `approved`              | Proceed with implementation |
| `approved_with_changes` | Minor changes needed        |
| `needs_revision`        | Major rework required       |
| `rejected`              | Does not meet standards     |

## Best Practices

- Focus on high-impact decisions
- Provide actionable feedback
- Reference standards and guidelines
- Consider long-term implications
- Balance perfectionism with pragmatism

## See Also

- [Agent Roles](/agents)
- [Architect Agent](/agents/architect)
- [Staff Engineer Agent](/agents/staff-engineer)
