---
title: UI Review Agent
description: Visual verification agent with Playwright
---

# UI Review Agent

The UI Review Agent uses Playwright to capture screenshots and verify visual changes in the application. It ensures UI consistency and catches visual regressions.

## Responsibilities

- Capture UI screenshots
- Verify visual changes
- Check responsive design
- Report UI issues
- Compare against baselines
- Test accessibility

## Configuration

| Setting            | Value      |
| ------------------ | ---------- |
| Min Instances      | 0          |
| Max Instances      | 2          |
| Scale Up Threshold | 3 messages |
| Scale Down Delay   | 300s       |

Note: Starts at 0 instances since UI review is only needed for UI-related tasks.

## Event Flow

### Incoming Events

- `work_assigned`: UI verification task
- `review_requested`: Visual review request

### Outgoing Events

- `review_completed`: Visual verification results
- `work_completed`: UI review finished

## Capabilities

### Screenshot Capture

- Full page screenshots
- Element-specific captures
- Multiple viewport sizes
- Dark/light mode variants

### Visual Comparison

- Pixel-by-pixel diff
- Configurable threshold
- Highlight differences
- Generate comparison reports

### Responsive Testing

- Desktop (1920x1080)
- Tablet (768x1024)
- Mobile (375x667)
- Custom viewports

## Report Format

```markdown
## UI Review: [Feature Name]

### Screenshots

- Desktop: [link]
- Mobile: [link]

### Visual Changes Detected

- Component X: Minor styling change
- Component Y: Layout shift

### Issues Found

- [ ] Button alignment off on mobile
- [ ] Text overflow in header

### Accessibility

- Contrast ratio: PASS
- Focus indicators: PASS
- Screen reader: NEEDS REVIEW
```

## Best Practices

- Capture before and after screenshots
- Test at multiple breakpoints
- Check interactive states
- Verify loading states
- Test with real data

## See Also

- [Agent Roles](/agents)
- [CI Agent](/agents/ci-agent)
- [Senior Dev Agent](/agents/senior-dev)
