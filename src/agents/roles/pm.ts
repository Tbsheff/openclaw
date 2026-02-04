/**
 * PM Agent - Product Manager
 *
 * Receives goals/requests and creates epics with user stories.
 * First agent in the pipeline.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class PMAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "pm",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[pm] Processing work item: ${workItem.title}`);

    // Claim the work atomically
    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[pm] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Parse the goal from the work item
      const goal = workItem.description ?? workItem.title;

      // Generate epic spec (placeholder - will use LLM)
      const epicSpec = await this.generateEpicSpec(goal);

      // Write spec file
      const specPath = await this.writeSpecFile(workItem.id, epicSpec);

      // Update work item with spec path
      await this.db.transaction(async (client) => {
        await client.query("UPDATE work_items SET spec_path = $1 WHERE id = $2", [
          specPath,
          workItem.id,
        ]);
      });

      // Mark as complete and notify architect
      await this.updateWorkStatus(workItem.id, "done");
      await this.publish({
        workItemId: workItem.id,
        eventType: "work_completed",
        targetRole: "architect",
        payload: { spec_path: specPath },
      });

      console.log(`[pm] Epic created: ${specPath}`);
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async generateEpicSpec(goal: string): Promise<string> {
    // TODO: Use LLM to generate epic spec
    // For now, generate a structured placeholder
    const timestamp = new Date().toISOString();

    return `# Epic: ${goal}

## Overview
${goal}

## User Stories

### Story 1: Core Implementation
As a user, I want the core functionality so that I can achieve the goal.

**Acceptance Criteria:**
- [ ] Core feature is implemented
- [ ] Basic validation works
- [ ] Error handling is in place

### Story 2: Testing
As a developer, I want tests so that I can verify the implementation.

**Acceptance Criteria:**
- [ ] Unit tests cover main paths
- [ ] Integration tests verify end-to-end

## Technical Notes
- Follow existing patterns in codebase
- Use TDD approach

## Generated
- Date: ${timestamp}
- Agent: PM
`;
  }

  private async writeSpecFile(workItemId: string, content: string): Promise<string> {
    const repoRoot = process.cwd();
    const specDir = join(repoRoot, ".flow", "specs");
    const specPath = join(specDir, `${workItemId}.md`);

    await mkdir(dirname(specPath), { recursive: true });
    await writeFile(specPath, content, "utf-8");

    return `.flow/specs/${workItemId}.md`;
  }
}
