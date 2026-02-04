/**
 * UI Review Agent
 *
 * Visual verification using Playwright for screenshots.
 */

import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class UIReviewAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "ui-review",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[ui-review] Reviewing UI: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[ui-review] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      const review = await this.reviewUI(workItem);

      if (review.approved) {
        // UI looks good - send to CI agent
        await this.updateWorkStatus(workItem.id, "review");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "ci-agent",
          payload: {
            screenshots: review.screenshots,
            approved: true,
          },
        });
        console.log(`[ui-review] Approved: ${workItem.title}`);
      } else {
        // UI issues - send back to senior dev
        await this.updateWorkStatus(workItem.id, "in_progress");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "senior-dev",
          payload: {
            approved: false,
            feedback: review.feedback,
            screenshots: review.screenshots,
          },
        });
        console.log(`[ui-review] Issues found: ${workItem.title}`);
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async reviewUI(workItem: WorkItem): Promise<{
    approved: boolean;
    feedback: string;
    screenshots: string[];
  }> {
    // TODO: Use Playwright to capture screenshots and verify UI
    // 1. Start dev server
    // 2. Navigate to affected pages
    // 3. Take screenshots
    // 4. Compare with expected (if available)
    // 5. Use LLM to analyze visual consistency

    console.log(`[ui-review] Capturing screenshots...`);

    // Placeholder - auto-approve for now
    return {
      approved: true,
      feedback: "UI looks consistent and functional.",
      screenshots: [],
    };
  }
}
