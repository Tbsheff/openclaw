/**
 * Architect Agent
 *
 * Receives epics and adds technical specifications with task breakdown.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class ArchitectAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "architect",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[architect] Processing epic: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[architect] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Read epic spec
      const specContent = workItem.spec_path
        ? await this.readSpecFile(workItem.spec_path)
        : (workItem.description ?? workItem.title);

      // Generate technical spec and tasks
      const { techSpec, tasks } = await this.generateTechSpec(workItem, specContent);

      // Update epic spec with technical details
      if (workItem.spec_path) {
        await this.appendToSpec(workItem.spec_path, techSpec);
      }

      // Create task work items
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskSpecPath = await this.writeTaskSpec(workItem.id, i + 1, task);

        const taskItem = await this.createChildWork({
          parentId: workItem.id,
          type: "task",
          title: task.title,
          description: task.description,
          targetAgent: "senior-dev",
          specPath: taskSpecPath,
          priority: tasks.length - i, // Higher priority for earlier tasks
        });

        console.log(`[architect] Created task: ${taskItem.title}`);
      }

      // Mark epic as complete, notify CTO review
      await this.updateWorkStatus(workItem.id, "done");
      await this.publish({
        workItemId: workItem.id,
        eventType: "work_completed",
        targetRole: "cto-review",
        payload: { task_count: tasks.length },
      });

      console.log(`[architect] Epic breakdown complete: ${tasks.length} tasks`);
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async readSpecFile(specPath: string): Promise<string> {
    const repoRoot = process.cwd();
    const fullPath = join(repoRoot, specPath);
    return readFile(fullPath, "utf-8");
  }

  private async appendToSpec(specPath: string, techSpec: string): Promise<void> {
    const repoRoot = process.cwd();
    const fullPath = join(repoRoot, specPath);
    const existing = await readFile(fullPath, "utf-8");
    await writeFile(fullPath, existing + "\n\n" + techSpec, "utf-8");
  }

  private async writeTaskSpec(
    epicId: string,
    taskNum: number,
    task: { title: string; description: string; spec: string },
  ): Promise<string> {
    const repoRoot = process.cwd();
    const taskDir = join(repoRoot, ".flow", "tasks");
    const taskPath = join(taskDir, `${epicId}.${taskNum}.md`);

    await mkdir(dirname(taskPath), { recursive: true });
    await writeFile(taskPath, task.spec, "utf-8");

    return `.flow/tasks/${epicId}.${taskNum}.md`;
  }

  private async generateTechSpec(
    workItem: WorkItem,
    specContent: string,
  ): Promise<{
    techSpec: string;
    tasks: Array<{ title: string; description: string; spec: string }>;
  }> {
    // TODO: Use LLM to generate technical spec
    // For now, generate structured placeholders

    const techSpec = `
## Technical Specification

### Architecture
- Component-based design
- Follow existing patterns

### Dependencies
- No new external dependencies required

### Implementation Notes
- Use TDD approach
- Follow coding standards
`;

    const tasks = [
      {
        title: `Implement core logic for: ${workItem.title}`,
        description: "Core implementation of the feature",
        spec: `# Task: Core Implementation

## Parent Epic
${workItem.title}

## Objective
Implement the core logic for this feature.

## Requirements
- Follow TDD approach
- Write tests first
- Implement minimal code to pass tests

## Acceptance Criteria
- [ ] Tests written and passing
- [ ] Code follows existing patterns
- [ ] No linting errors
`,
      },
      {
        title: `Add integration tests for: ${workItem.title}`,
        description: "Integration testing for the feature",
        spec: `# Task: Integration Tests

## Parent Epic
${workItem.title}

## Objective
Add integration tests to verify end-to-end behavior.

## Requirements
- Test happy paths
- Test error cases
- Test edge cases

## Acceptance Criteria
- [ ] Integration tests cover main flows
- [ ] All tests pass
`,
      },
    ];

    return { techSpec, tasks };
  }
}
