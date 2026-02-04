---
title: Multi-Agent Pipeline
description: Architecture and usage guide for the OpenClaw multi-agent pipeline
---

# Multi-Agent Pipeline

The OpenClaw multi-agent pipeline orchestrates specialized AI agents to collaboratively complete complex software development tasks. Each agent has a distinct role in the pipeline, processing work items through event-driven communication.

## Architecture Overview

```
                                    ┌─────────────────┐
                                    │   Orchestrator  │
                                    │   (health,      │
                                    │    scaling,     │
                                    │    spawning)    │
                                    └────────┬────────┘
                                             │
    ┌────────────────────────────────────────┼────────────────────────────────────────┐
    │                              Redis Streams (Event Bus)                           │
    │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
    │  │ PM Queue │ │Arch Queue│ │CTO Queue │ │ Dev Queue│ │Staff Q.  │ │ CI Queue │  │
    │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
    └───────┼────────────┼────────────┼────────────┼────────────┼────────────┼────────┘
            │            │            │            │            │            │
    ┌───────▼───────┐    │    ┌───────▼───────┐    │    ┌───────▼───────┐    │
    │   PM Agent    │    │    │  CTO Review   │    │    │Staff Engineer │    │
    │  (planning,   │    │    │  (approval,   │    │    │  (refactor,   │    │
    │   breakdown)  │    │    │   feedback)   │    │    │   patterns)   │    │
    └───────────────┘    │    └───────────────┘    │    └───────────────┘    │
                         │                         │                         │
                 ┌───────▼───────┐         ┌───────▼───────┐         ┌───────▼───────┐
                 │   Architect   │         │  Senior Dev   │         │   CI Agent    │
                 │  (design,     │         │  (implement,  │         │  (test, PR,   │
                 │   specs)      │         │   code)       │         │   merge)      │
                 └───────────────┘         └───────────────┘         └───────────────┘

    ┌─────────────────────────────────────────────────────────────────────────────────┐
    │                              PostgreSQL (State)                                  │
    │  work_items │ agent_runs │ pipeline_events │ agent_heartbeats                   │
    └─────────────────────────────────────────────────────────────────────────────────┘
```

## Agent Roles

### PM Agent

- **Role**: Project management and task breakdown
- **Responsibilities**:
  - Receives user goals
  - Analyzes requirements
  - Creates work breakdown structure (epics, tasks)
  - Assigns work to appropriate agents
  - Tracks overall progress

### Architect Agent

- **Role**: Technical design and specifications
- **Responsibilities**:
  - Designs system architecture
  - Creates technical specifications
  - Defines interfaces and contracts
  - Reviews design decisions
  - Documents architecture decisions

### CTO Review Agent

- **Role**: Executive oversight and approval
- **Responsibilities**:
  - Reviews major design decisions
  - Approves significant changes
  - Ensures alignment with project goals
  - Provides strategic feedback

### Senior Dev Agent

- **Role**: Implementation
- **Responsibilities**:
  - Writes production code
  - Implements features from specs
  - Handles complex coding tasks
  - Follows architectural guidelines

### Staff Engineer Agent

- **Role**: Code quality and patterns
- **Responsibilities**:
  - Reviews code for patterns
  - Suggests refactoring
  - Ensures consistency
  - Mentors on best practices

### Code Simplifier Agent

- **Role**: Code optimization
- **Responsibilities**:
  - Simplifies complex code
  - Removes duplication
  - Improves readability
  - Reduces technical debt

### UI Review Agent

- **Role**: Visual verification
- **Responsibilities**:
  - Captures UI screenshots
  - Verifies visual changes
  - Checks responsive design
  - Reports UI issues

### CI Agent

- **Role**: Continuous integration
- **Responsibilities**:
  - Runs tests
  - Creates pull requests
  - Manages CI/CD pipeline
  - Handles merge conflicts

### Domain Expert Agent (RAG-powered)

- **Role**: Domain knowledge
- **Responsibilities**:
  - Provides domain context
  - Answers technical questions
  - References documentation
  - Suggests domain patterns

## Event Flow

1. **Goal Submission**: User submits a goal via `openclaw pipeline submit`
2. **PM Processing**: PM agent receives the goal, creates work items
3. **Architecture**: Architect designs the solution, creates specs
4. **CTO Review**: Major decisions get reviewed and approved
5. **Implementation**: Senior devs implement based on specs
6. **Quality Review**: Staff engineer and code simplifier review
7. **UI Verification**: UI review agent checks visual changes
8. **CI/CD**: CI agent runs tests and creates PRs

### Event Types

| Event              | Description                      |
| ------------------ | -------------------------------- |
| `goal_submitted`   | User submitted a new goal        |
| `work_created`     | New work item created            |
| `work_assigned`    | Work assigned to an agent        |
| `work_completed`   | Agent finished work              |
| `review_requested` | Review needed from another agent |
| `review_completed` | Review finished                  |
| `ci_status`        | CI pipeline status update        |

## Quick Start

### Prerequisites

Start the pipeline infrastructure:

```bash
# Start PostgreSQL and Redis
pnpm pipeline:up

# Verify services are running
docker compose -f docker-compose.pipeline.yml ps
```

### Start the Orchestrator

```bash
# Start in background (daemon mode)
openclaw orchestrator start

# Or start in foreground for debugging
openclaw orchestrator start --foreground
```

### Submit a Goal

```bash
# Submit a goal to the pipeline
openclaw pipeline submit "Add user authentication with OAuth2 support"

# With priority (higher = more urgent)
openclaw pipeline submit "Fix critical security bug" --priority 10

# As a task instead of project
openclaw pipeline submit "Update README" --type task
```

### Check Status

```bash
# List all work items
openclaw pipeline status

# Check specific work item
openclaw pipeline status abc12345-1234-5678-90ab-cdef12345678

# With detailed agent run history
openclaw pipeline status abc12345-... --deep
```

### Monitor Orchestrator

```bash
# Show agent health and queue depths
openclaw orchestrator status

# JSON output for scripting
openclaw orchestrator status --json
```

### Stop the Orchestrator

```bash
# Graceful shutdown
openclaw orchestrator stop

# Force kill if needed
openclaw orchestrator stop --force
```

## CLI Reference

### `openclaw orchestrator`

| Command  | Description                        |
| -------- | ---------------------------------- |
| `start`  | Start the orchestrator daemon      |
| `stop`   | Graceful shutdown                  |
| `status` | Show agent health and queue depths |

**Options for `start`:**

- `--foreground`: Run in foreground (blocking)
- `--json`: Output JSON

**Options for `stop`:**

- `--force`: Force kill immediately
- `--json`: Output JSON

**Options for `status`:**

- `--json`: Output JSON

### `openclaw pipeline`

| Command         | Description                   |
| --------------- | ----------------------------- |
| `submit <goal>` | Submit a goal to the PM agent |
| `status [id]`   | Check pipeline status         |

**Options for `submit`:**

- `--priority <n>`: Priority level (default: 0)
- `--type <type>`: Work type (project, epic, task)
- `--json`: Output JSON

**Options for `status`:**

- `--deep`: Show agent runs and history
- `--json`: Output JSON

### Pipeline Tool (Agent API)

The main OpenClaw agent can also interact with the pipeline directly using the `pipeline` tool:

```
# Submit a goal
pipeline action:submit goal:"Add OAuth authentication" priority:5

# Check status
pipeline action:status workItemId:abc-123-uuid deep:true

# List recent work
pipeline action:list limit:10
```

This allows the agent to delegate complex work to the pipeline without shelling out to CLI commands.

## Configuration

### Environment Variables

| Variable                | Description                  | Default                                                  |
| ----------------------- | ---------------------------- | -------------------------------------------------------- |
| `PIPELINE_DATABASE_URL` | PostgreSQL connection string | `postgresql://openclaw:openclaw@localhost:5433/openclaw` |
| `REDIS_HOST`            | Redis host                   | `localhost`                                              |
| `REDIS_PORT`            | Redis port                   | `6380`                                                   |

### Scaling Configuration

Each agent role has configurable scaling:

```typescript
{
  pm: { min: 1, max: 1 },           // Always exactly 1
  architect: { min: 1, max: 3 },    // Scale based on queue
  "senior-dev": { min: 1, max: 10 }, // High scalability
  "ci-agent": { min: 1, max: 3 },   // Moderate scaling
}
```

The orchestrator automatically:

- Scales up when queue depth exceeds threshold
- Scales down after idle timeout
- Restarts crashed agents
- Reclaims orphaned work

## Troubleshooting

### Orchestrator Won't Start

```bash
# Check if already running
openclaw orchestrator status

# Check for port conflicts
lsof -i :5433  # PostgreSQL
lsof -i :6380  # Redis

# Verify infrastructure
docker compose -f docker-compose.pipeline.yml ps
```

### Agents Not Processing

```bash
# Check queue depths
openclaw orchestrator status

# View orchestrator logs
tail -f ~/.openclaw/orchestrator.log

# Check agent heartbeats (requires DB connection)
psql $PIPELINE_DATABASE_URL -c "SELECT * FROM agent_heartbeats"
```

### Work Items Stuck

```bash
# Check work item status
openclaw pipeline status <work-item-id> --deep

# Look for errors in agent runs
psql $PIPELINE_DATABASE_URL -c "SELECT * FROM agent_runs WHERE work_item_id = '<id>'"
```

## Development

### Running Tests

```bash
# Run pipeline e2e tests
pnpm test:e2e:pipeline

# Run with infrastructure
pnpm pipeline:up && pnpm test:e2e:pipeline
```

### Debugging

```bash
# Run orchestrator in dev mode with tsx
pnpm orchestrator:dev

# Watch logs
pnpm pipeline:logs
```

## See Also

- [Agent Architecture](/concepts/agents)
- [Event-Driven Design](/concepts/events)
- [Infrastructure Setup](/install/infrastructure)
