---
title: Architect Agent
description: Technical design and specification agent
---

# Architect Agent

The Architect Agent is responsible for technical design, creating specifications, and ensuring architectural consistency across the codebase.

## Responsibilities

- Design system architecture
- Create technical specifications
- Define interfaces and API contracts
- Review architectural decisions
- Document design patterns
- Ensure scalability and maintainability

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 3          |
| Scale Up Threshold | 3 messages |
| Scale Down Delay   | 300s       |

## Event Flow

### Incoming Events

- `work_assigned`: Work item assigned from PM
- `review_requested`: Review request from other agents

### Outgoing Events

- `work_created`: Spec document created
- `review_requested`: Request CTO review for major decisions
- `work_assigned`: Assign implementation to senior dev

## Specification Format

Architect produces specs in structured format:

```markdown
# Technical Specification: [Feature Name]

## Overview

Brief description of the feature

## Requirements

- Functional requirements
- Non-functional requirements

## Architecture

- Component diagram
- Data flow

## API Design

- Endpoints
- Request/response schemas

## Implementation Notes

- Key algorithms
- Edge cases
- Dependencies

## Testing Strategy

- Unit test coverage
- Integration tests
```

## Best Practices

- Keep specs concise but complete
- Reference existing patterns when applicable
- Consider edge cases early
- Document trade-offs and decisions
- Include diagrams for complex flows

## See Also

- [Agent Roles](/agents)
- [PM Agent](/agents/pm)
- [CTO Review Agent](/agents/cto-review)
