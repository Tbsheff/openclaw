---
title: PM Agent
description: Project management agent for task breakdown and coordination
---

# PM Agent

The PM (Project Manager) Agent is the entry point for the multi-agent pipeline. It receives user goals and orchestrates the work breakdown process.

## Responsibilities

- Receive and analyze user goals
- Create work breakdown structure (projects, epics, tasks)
- Assign work to appropriate downstream agents
- Track overall progress and dependencies
- Handle escalations and blockers

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 1          |
| Scale Up Threshold | 5 messages |
| Scale Down Delay   | 300s       |

## Event Flow

### Incoming Events

- `goal_submitted`: User submitted a new goal

### Outgoing Events

- `work_created`: New work item created
- `work_assigned`: Work assigned to architect

## Work Breakdown Process

1. **Goal Analysis**: Parse and understand user intent
2. **Scope Definition**: Define project boundaries
3. **Epic Creation**: Break down into major features
4. **Task Definition**: Create actionable tasks
5. **Assignment**: Route to architect for technical design

## Example

```bash
# Submit a goal (routed to PM)
openclaw pipeline submit "Build a REST API for user management"

# PM creates work breakdown:
# - Project: User Management API
#   - Epic: Authentication
#     - Task: Design auth flow
#     - Task: Implement JWT tokens
#   - Epic: User CRUD
#     - Task: Design user schema
#     - Task: Implement endpoints
```

## Best Practices

- Keep goals specific and measurable
- Include acceptance criteria when possible
- Set appropriate priority levels
- Review work breakdown before approval

## See Also

- [Agent Roles](/agents)
- [Architect Agent](/agents/architect)
- [Pipeline Commands](/cli/pipeline)
