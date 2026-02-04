---
title: Agent Roles
description: Overview of agent roles in the OpenClaw multi-agent pipeline
---

# Agent Roles

The OpenClaw multi-agent pipeline uses specialized agents, each with distinct responsibilities. This modular design enables parallel processing, specialized optimization, and clear separation of concerns.

## Available Agents

| Role                                             | Description                           | Scaling        |
| ------------------------------------------------ | ------------------------------------- | -------------- |
| [PM Agent](/agents/pm)                           | Project management and task breakdown | 1 instance     |
| [Architect Agent](/agents/architect)             | Technical design and specifications   | 1-3 instances  |
| [CTO Review Agent](/agents/cto-review)           | Executive oversight and approval      | 1-2 instances  |
| [Senior Dev Agent](/agents/senior-dev)           | Implementation and coding             | 1-10 instances |
| [Staff Engineer Agent](/agents/staff-engineer)   | Code quality and patterns             | 1-5 instances  |
| [Code Simplifier Agent](/agents/code-simplifier) | Code optimization                     | 1-3 instances  |
| [UI Review Agent](/agents/ui-review)             | Visual verification                   | 0-2 instances  |
| [CI Agent](/agents/ci-agent)                     | Continuous integration                | 1-3 instances  |
| [Domain Expert Agent](/agents/domain-expert)     | RAG-powered domain knowledge          | 0-2 instances  |

## Agent Lifecycle

1. **Spawning**: Orchestrator spawns agents based on scaling config
2. **Heartbeat**: Agents send periodic heartbeats to indicate health
3. **Work Consumption**: Agents consume events from their dedicated queue
4. **Processing**: Agent processes work item and produces output
5. **Publishing**: Agent publishes events to downstream agents
6. **Completion**: Agent marks work as done and acknowledges event

## Communication Pattern

Agents communicate through Redis Streams using per-agent queues:

```
User Goal
    │
    ▼
┌─────────┐     ┌───────────┐     ┌────────────┐
│   PM    │────▶│ Architect │────▶│ CTO Review │
└─────────┘     └───────────┘     └────────────┘
                      │                  │
                      ▼                  ▼
              ┌────────────┐     ┌─────────────┐
              │ Senior Dev │────▶│   CI Agent  │
              └────────────┘     └─────────────┘
                      │
                      ▼
              ┌─────────────────┐
              │ Staff Engineer  │
              └─────────────────┘
```

## Adding Custom Agents

To add a new agent role:

1. Add the role to `src/events/types.ts`:

   ```typescript
   export const AgentRoleSchema = z.enum([
     // ... existing roles
     "my-custom-agent",
   ]);
   ```

2. Create the agent implementation in `src/agents/`:

   ```typescript
   // src/agents/my-custom-agent.ts
   export async function runMyCustomAgent(event: StreamMessage): Promise<void> {
     // Process event and produce output
   }
   ```

3. Add to agent runner in `src/agents/agent-runner.ts`

4. Configure scaling in `src/orchestrator/scaler.ts`

5. Add documentation in `docs/agents/my-custom-agent.md`

## See Also

- [Multi-Agent Pipeline](/multi-agent-pipeline)
- [Event Flow](/concepts/events)
- [Orchestrator](/cli/orchestrator)
