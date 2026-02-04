/**
 * Code Simplifier Agent
 *
 * Anti-slop gate that simplifies code before final approval.
 * Removes dead code, over-engineering, unnecessary abstractions.
 */

import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class CodeSimplifierAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "code-simplifier",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[code-simplifier] Simplifying: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[code-simplifier] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      const simplifications = await this.simplifyCode(workItem);

      if (simplifications.length > 0) {
        // Made simplifications - commit them
        await this.commitSimplifications(workItem, simplifications);
      }

      // Determine next step based on work item metadata
      const hasUI = workItem.metadata?.has_ui === true;
      const nextRole = hasUI ? "ui-review" : "ci-agent";

      await this.updateWorkStatus(workItem.id, "review");
      await this.publish({
        workItemId: workItem.id,
        eventType: "review_completed",
        targetRole: nextRole,
        payload: {
          simplifications: simplifications.length,
          simplified_by: "code-simplifier",
        },
      });

      console.log(`[code-simplifier] Done: ${simplifications.length} simplifications`);
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async simplifyCode(workItem: WorkItem): Promise<string[]> {
    // TODO: Use LLM to identify simplifications
    // Look for:
    // - Dead code
    // - Over-engineering
    // - Unnecessary abstractions
    // - Duplicate logic
    // - Overly complex patterns

    console.log(`[code-simplifier] Analyzing code for simplifications...`);

    // Placeholder - no simplifications for now
    return [];
  }

  private async commitSimplifications(
    workItem: WorkItem,
    simplifications: string[],
  ): Promise<void> {
    // TODO: Implement actual git commit
    console.log(`[code-simplifier] Would commit ${simplifications.length} simplifications`);
  }
}
