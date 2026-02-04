/**
 * CTO Review Agent
 *
 * Validates architecture patterns and conventions.
 * Gates work before it goes to implementation.
 */

import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class CTOReviewAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "cto-review",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[cto-review] Reviewing: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[cto-review] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Review the architecture/design
      const review = await this.reviewArchitecture(workItem);

      if (review.approved) {
        // Approved - get child tasks and assign to senior-dev
        const tasks = await this.db.getChildWorkItems(workItem.id);

        for (const task of tasks) {
          await this.publish({
            workItemId: task.id,
            eventType: "work_assigned",
            targetRole: "senior-dev",
            payload: { approved_by: "cto-review" },
          });
        }

        await this.updateWorkStatus(workItem.id, "done");
        console.log(`[cto-review] Approved: ${workItem.title}`);
      } else {
        // Rejected - send back to architect with feedback
        await this.updateWorkStatus(workItem.id, "blocked", review.feedback);
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "architect",
          payload: {
            approved: false,
            feedback: review.feedback,
          },
        });
        console.log(`[cto-review] Rejected: ${workItem.title}`);
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async reviewArchitecture(
    workItem: WorkItem,
  ): Promise<{ approved: boolean; feedback: string }> {
    // TODO: Use LLM to review architecture
    // Check for:
    // - Pattern compliance
    // - Security considerations
    // - Scalability
    // - Maintainability

    console.log(`[cto-review] Checking patterns and conventions...`);

    // Placeholder - auto-approve for now
    return {
      approved: true,
      feedback: "Architecture looks good. Proceed with implementation.",
    };
  }
}
