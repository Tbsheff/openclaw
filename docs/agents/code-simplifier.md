---
title: Code Simplifier Agent
description: Code optimization and simplification agent
---

# Code Simplifier Agent

The Code Simplifier Agent focuses on reducing complexity, removing duplication, and improving code readability without changing functionality.

## Responsibilities

- Simplify complex code
- Remove duplication (DRY)
- Improve readability
- Reduce technical debt
- Optimize performance
- Maintain functionality

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 1          |
| Max Instances      | 3          |
| Scale Up Threshold | 5 messages |
| Scale Down Delay   | 180s       |

## Event Flow

### Incoming Events

- `work_assigned`: Simplification task from staff engineer

### Outgoing Events

- `work_completed`: Simplification finished
- `review_requested`: Request verification from staff engineer

## Simplification Strategies

1. **Extract Functions**: Break large functions into smaller ones
2. **Remove Duplication**: Consolidate repeated code
3. **Simplify Conditionals**: Reduce nested if/else
4. **Improve Names**: Use clearer variable/function names
5. **Remove Dead Code**: Delete unused code paths
6. **Optimize Loops**: Simplify iteration patterns

## Metrics Tracked

| Metric                | Description                   |
| --------------------- | ----------------------------- |
| Cyclomatic Complexity | Measure of code complexity    |
| Lines of Code         | Total and per function        |
| Duplication           | Percentage of duplicated code |
| Function Length       | Average lines per function    |

## Example Simplifications

### Before

```typescript
function processData(items: Item[]) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].active === true) {
      if (items[i].type === "premium") {
        results.push(items[i].value * 1.5);
      } else {
        results.push(items[i].value);
      }
    }
  }
  return results;
}
```

### After

```typescript
function processData(items: Item[]) {
  return items
    .filter((item) => item.active)
    .map((item) => (item.type === "premium" ? item.value * 1.5 : item.value));
}
```

## Best Practices

- Ensure tests pass before and after
- Make incremental changes
- Document the reasoning
- Preserve behavior exactly
- Measure improvement metrics

## See Also

- [Agent Roles](/agents)
- [Staff Engineer Agent](/agents/staff-engineer)
- [Senior Dev Agent](/agents/senior-dev)
