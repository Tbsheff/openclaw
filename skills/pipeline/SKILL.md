---
name: pipeline
description: Submit complex goals to the multi-agent pipeline for autonomous implementation with TDD and code review.
metadata: { "openclaw": { "emoji": "🔄" } }
---

# Pipeline Skill

Use the **pipeline tool** to delegate complex, multi-step implementations to specialized AI agents that work autonomously.

## When to Use the Pipeline

Use the pipeline for work that benefits from:

- **Multi-step implementation** - Features requiring architecture, coding, testing, and review
- **TDD workflow** - Agents write tests first, then implement
- **Code review** - Staff engineers and simplifiers review before merge
- **Autonomous work** - You want to delegate and check back later

**Good candidates:**

- "Add user authentication with OAuth2"
- "Build a REST API for managing todos"
- "Refactor the payment module to use the new pricing engine"
- "Add comprehensive test coverage to the billing service"

**Not ideal for:**

- Quick one-line fixes (just do it directly)
- Simple config changes
- Questions/research (use normal chat)
- Urgent hotfixes (pipeline has latency)

## Pipeline Tool Actions

### Submit a Goal

```
pipeline action:submit goal:"Add user authentication with OAuth2 support" priority:5 type:project
```

| Param      | Description                      | Default   |
| ---------- | -------------------------------- | --------- |
| `goal`     | What to implement (be specific!) | required  |
| `priority` | Higher = more urgent (0-100)     | 0         |
| `type`     | `project`, `epic`, or `task`     | `project` |

**Tips for good goals:**

- Be specific about requirements
- Mention existing patterns to follow
- Reference relevant files or modules
- Include acceptance criteria if known

### Check Status

```
pipeline action:status workItemId:abc-123-uuid deep:true
```

| Param        | Description               | Default  |
| ------------ | ------------------------- | -------- |
| `workItemId` | UUID from submit response | required |
| `deep`       | Include agent run history | false    |

### List Recent Work Items

```
pipeline action:list limit:10
```

| Param   | Description         | Default |
| ------- | ------------------- | ------- |
| `limit` | Max items to return | 20      |

## Pipeline Workflow

When you submit a goal, the pipeline processes it through specialized agents:

```
You → PM Agent → Architect → CTO Review → Senior Dev → Staff Engineer → CI Agent
       ↓             ↓            ↓            ↓              ↓            ↓
    Breakdown    Design      Approve     Implement       Review       Test & PR
```

1. **PM Agent** - Analyzes goal, creates work breakdown (epics, tasks)
2. **Architect** - Designs solution, creates technical specs
3. **CTO Review** - Approves major design decisions
4. **Senior Dev** - Implements code following specs (TDD)
5. **Staff Engineer** - Reviews patterns, suggests improvements
6. **Code Simplifier** - Reduces complexity, cleans up code
7. **CI Agent** - Runs tests, creates PRs, handles merge

## Example Workflow

```bash
# 1. Submit a goal
pipeline action:submit goal:"Add dark mode support with system preference detection" priority:3

# Response: { workItemId: "abc-123-...", status: "pending" }

# 2. Check progress (later)
pipeline action:status workItemId:abc-123-uuid deep:true

# 3. Review what the pipeline has been working on
pipeline action:list limit:5
```

## Prerequisites

The pipeline requires infrastructure:

```bash
# Start PostgreSQL and Redis
pnpm pipeline:up

# Start the orchestrator (manages agent scaling)
openclaw orchestrator start

# Verify everything is running
openclaw orchestrator status
```

If you get "Pipeline database not available" errors, the infrastructure isn't running.

## When NOT to Use

- **Urgent work** - Pipeline has latency; do urgent fixes directly
- **Simple changes** - One-file changes don't need a full pipeline
- **Exploration** - Use normal chat for research questions
- **Infrastructure down** - Check `openclaw orchestrator status` first

## Monitoring

Track pipeline health and queue depths:

```bash
# CLI status
openclaw orchestrator status

# Direct database query (if needed)
psql $PIPELINE_DATABASE_URL -c "SELECT id, title, status FROM work_items ORDER BY created_at DESC LIMIT 10"
```

## See Also

- [Multi-Agent Pipeline Architecture](/docs/multi-agent-pipeline)
- [Orchestrator Commands](/docs/cli/orchestrator)
