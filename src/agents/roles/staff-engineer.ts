/**
 * Staff Engineer Agent
 *
 * Carmack-level code review: correctness, edge cases, simplicity.
 */

import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

const MAX_REVIEW_LOOPS = 3;

export class StaffEngineerAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "staff-engineer",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[staff-engineer] Reviewing: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[staff-engineer] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Get review attempt count from metadata
      const reviewCount = (workItem.metadata?.review_count as number) ?? 0;

      const review = await this.reviewCode(workItem);

      if (review.verdict === "SHIP") {
        // Approved - send to code simplifier
        await this.updateWorkStatus(workItem.id, "review");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "code-simplifier",
          payload: { verdict: "SHIP" },
        });
        console.log(`[staff-engineer] SHIP: ${workItem.title}`);
      } else if (reviewCount >= MAX_REVIEW_LOOPS) {
        // Too many review loops - escalate
        await this.updateWorkStatus(workItem.id, "blocked", "Max review loops exceeded");
        console.log(`[staff-engineer] Escalated: ${workItem.title} (max loops)`);
      } else {
        // Needs work - send back to senior dev
        await this.db.transaction(async (client) => {
          await client.query(
            "UPDATE work_items SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{review_count}', $1::jsonb) WHERE id = $2",
            [(reviewCount + 1).toString(), workItem.id],
          );
        });

        await this.updateWorkStatus(workItem.id, "in_progress");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "senior-dev",
          payload: {
            verdict: "NEEDS_WORK",
            feedback: review.feedback,
            issues: review.issues,
          },
        });
        console.log(`[staff-engineer] NEEDS_WORK: ${workItem.title}`);
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async reviewCode(workItem: WorkItem): Promise<{
    verdict: "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK";
    feedback: string;
    issues: string[];
  }> {
    // TODO: Use LLM for Carmack-level review
    // Check for:
    // - Correctness
    // - Edge cases
    // - Error handling
    // - Performance
    // - Simplicity

    console.log(`[staff-engineer] Performing code review...`);

    // Placeholder - auto-approve for now
    return {
      verdict: "SHIP",
      feedback: "Code looks good. Clean implementation.",
      issues: [],
    };
  }
}
