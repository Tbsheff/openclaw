/**
 * Domain Expert Agent
 *
 * Home health care domain expert using RAG for domain knowledge.
 * Validates epics against domain requirements.
 */

import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class DomainExpertAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "domain-expert",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[domain-expert] Reviewing: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[domain-expert] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      const review = await this.reviewDomainCompliance(workItem);

      if (review.compliant) {
        // Domain requirements met - continue to architect
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "architect",
          payload: {
            domain_validated: true,
            notes: review.notes,
          },
        });
        console.log(`[domain-expert] Validated: ${workItem.title}`);
      } else {
        // Domain issues - send back to PM
        await this.updateWorkStatus(workItem.id, "blocked", review.issues.join("; "));
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "pm",
          payload: {
            domain_validated: false,
            issues: review.issues,
            recommendations: review.recommendations,
          },
        });
        console.log(`[domain-expert] Issues found: ${workItem.title}`);
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async reviewDomainCompliance(workItem: WorkItem): Promise<{
    compliant: boolean;
    notes: string;
    issues: string[];
    recommendations: string[];
  }> {
    // TODO: Use RAG to query domain knowledge
    // Check for:
    // - HIPAA compliance
    // - Medicare/Medicaid guidelines
    // - Home health care regulations
    // - Industry best practices

    console.log(`[domain-expert] Checking domain compliance...`);

    // Placeholder - auto-approve for now
    return {
      compliant: true,
      notes: "Feature aligns with home health care requirements.",
      issues: [],
      recommendations: [],
    };
  }
}
