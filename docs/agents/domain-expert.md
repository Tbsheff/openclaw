---
title: Domain Expert Agent
description: RAG-powered domain knowledge agent
---

# Domain Expert Agent

The Domain Expert Agent uses Retrieval-Augmented Generation (RAG) to provide domain-specific knowledge and context to other agents.

## Responsibilities

- Provide domain context
- Answer technical questions
- Reference documentation
- Suggest domain patterns
- Maintain knowledge base
- Index codebase semantically

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 0          |
| Max Instances      | 2          |
| Scale Up Threshold | 3 messages |
| Scale Down Delay   | 300s       |

Note: Starts at 0 instances since domain expertise is only needed when requested.

## Event Flow

### Incoming Events

- `review_requested`: Question requiring domain knowledge

### Outgoing Events

- `review_completed`: Answer with context and references

## RAG Architecture

```
Query
  │
  ▼
┌─────────────────┐
│ Query Embedding │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Vector Search  │──── sqlite-vec
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Context Ranking │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LLM Response   │
└─────────────────┘
```

## Knowledge Sources

| Source   | Description              |
| -------- | ------------------------ |
| Codebase | Indexed source files     |
| Docs     | Documentation files      |
| Comments | Code comments and JSDoc  |
| Specs    | Technical specifications |
| Issues   | GitHub issues and PRs    |

## Query Types

### Code Understanding

"How does the authentication flow work?"

### Pattern Questions

"What's the standard way to handle errors?"

### API References

"What are the parameters for createUser?"

### Best Practices

"Should I use Redis or in-memory cache here?"

## Response Format

```markdown
## Domain Context: [Question]

### Answer

Direct answer to the question

### References

- `src/auth/flow.ts:45-67`: Authentication flow
- `docs/auth.md`: Auth documentation

### Related Code

- `src/auth/middleware.ts`: Auth middleware
- `src/utils/jwt.ts`: JWT utilities

### Suggestions

- Consider using existing AuthService
- Follow pattern in UserController
```

## Indexing

The domain expert maintains semantic indexes of:

- Source code files
- Markdown documentation
- Test files and examples
- Configuration files
- API schemas

Indexes are updated incrementally as files change.

## Best Practices

- Ask specific questions
- Include context about what you're trying to do
- Reference file paths when relevant
- Use domain expert for "why" questions
- Trust but verify referenced code

## See Also

- [Agent Roles](/agents)
- [Architect Agent](/agents/architect)
- [Staff Engineer Agent](/agents/staff-engineer)
