/**
 * CTO Review Agent
 *
 * Validates architecture patterns and conventions.
 * Gates work before it goes to implementation.
 *
 * Flow:
 * - Listens for `work_completed` from architect
 * - APPROVE → publish `work_assigned` to senior-dev
 * - REJECT → publish `review_completed` to architect with feedback
 * - Tracks review count to prevent infinite loops
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

const MAX_REVIEW_LOOPS = 3;

interface ReviewResult {
  approved: boolean;
  confidence: "high" | "medium" | "low";
  summary: string;
  issues: Array<{
    severity: "blocking" | "major" | "minor";
    category: string;
    description: string;
    suggestion: string;
  }>;
  positives: string[];
}

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

    // Only process work_completed events from architect
    if (message.event_type !== "work_completed" && message.event_type !== "work_assigned") {
      console.log(`[cto-review] Skipping event type: ${message.event_type}`);
      return;
    }

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[cto-review] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Get review attempt count from metadata
      const reviewCount = (workItem.metadata?.cto_review_count as number) ?? 0;

      // Check for infinite loop
      if (reviewCount >= MAX_REVIEW_LOOPS) {
        console.log(
          `[cto-review] Max review loops (${MAX_REVIEW_LOOPS}) reached for ${workItem.id}`,
        );
        await this.updateWorkStatus(workItem.id, "blocked", "Max CTO review loops exceeded");

        // Record the escalation in metadata
        await this.recordReviewInMetadata(workItem.id, reviewCount, {
          approved: false,
          confidence: "high",
          summary: "Escalated: max review loops exceeded",
          issues: [],
          positives: [],
        });
        return;
      }

      // Perform the architecture review
      const review = await this.reviewArchitecture(workItem);

      // Record the review in metadata
      await this.recordReviewInMetadata(workItem.id, reviewCount + 1, review);

      if (review.approved) {
        // Approved - get child tasks and assign to senior-dev
        const tasks = await this.db.getChildWorkItems(workItem.id);

        for (const task of tasks) {
          // Assign to target role before publishing so they can claim the work
          await this.assignToRole(task.id, "senior-dev");
          await this.publish({
            workItemId: task.id,
            eventType: "work_assigned",
            targetRole: "senior-dev",
            payload: {
              approved_by: "cto-review",
              review_summary: review.summary,
            },
          });
        }

        await this.updateWorkStatus(workItem.id, "done");
        console.log(`[cto-review] APPROVED: ${workItem.title} (${tasks.length} tasks assigned)`);
      } else {
        // Rejected - send back to architect with feedback
        await this.updateWorkStatus(workItem.id, "blocked", review.summary);
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "architect");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "architect",
          payload: {
            approved: false,
            feedback: review.summary,
            issues: review.issues,
            review_count: reviewCount + 1,
          },
        });
        console.log(
          `[cto-review] REJECTED: ${workItem.title} - ${review.issues.length} issues found`,
        );
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  /**
   * Record review result in work item metadata.
   */
  private async recordReviewInMetadata(
    workItemId: string,
    reviewCount: number,
    review: ReviewResult,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE work_items
         SET metadata = jsonb_set(
           jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{cto_review_count}',
             $1::jsonb
           ),
           '{cto_review_history}',
           COALESCE(metadata->'cto_review_history', '[]'::jsonb) || $2::jsonb
         )
         WHERE id = $3`,
        [
          reviewCount.toString(),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            approved: review.approved,
            summary: review.summary,
            issues_count: review.issues.length,
          }),
          workItemId,
        ],
      );
    });
  }

  /**
   * Read spec file from the repository.
   */
  private async readSpecFile(specPath: string): Promise<string> {
    const repoRoot = process.cwd();
    const fullPath = join(repoRoot, specPath);
    try {
      return await readFile(fullPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Review architecture for patterns and conventions.
   *
   * TODO: Integrate with LLM using prompts/cto-review.md
   */
  private async reviewArchitecture(workItem: WorkItem): Promise<ReviewResult> {
    console.log(`[cto-review] Checking patterns and conventions...`);

    // Read the spec if available
    const specContent = workItem.spec_path ? await this.readSpecFile(workItem.spec_path) : "";

    // Get child tasks to understand the breakdown
    const tasks = await this.db.getChildWorkItems(workItem.id);

    // TODO: Use LLM to review architecture
    // Load prompts/cto-review.md and send to Claude/GPT with:
    // - Epic/feature specification (specContent)
    // - Task breakdown (tasks)
    // - Project patterns/conventions (from codebase analysis)

    // Placeholder validation logic
    const issues: ReviewResult["issues"] = [];

    // Check for spec file
    if (!specContent) {
      issues.push({
        severity: "major",
        category: "architecture",
        description: "No specification file found for this epic",
        suggestion: "Create a spec file with technical details at the spec_path location",
      });
    }

    // Check for task breakdown
    if (tasks.length === 0) {
      issues.push({
        severity: "blocking",
        category: "architecture",
        description: "No tasks were created for this epic",
        suggestion: "Break down the epic into implementable tasks",
      });
    }

    // Check spec content for required sections
    if (specContent && !specContent.includes("## Architecture")) {
      issues.push({
        severity: "minor",
        category: "pattern",
        description: "Spec missing Architecture section",
        suggestion: "Add ## Architecture section with component design",
      });
    }

    // Determine approval based on issues
    const blockingIssues = issues.filter((i) => i.severity === "blocking");
    const majorIssues = issues.filter((i) => i.severity === "major");
    const approved = blockingIssues.length === 0 && majorIssues.length < 3;

    return {
      approved,
      confidence: "medium",
      summary: approved
        ? `Architecture approved. ${tasks.length} tasks ready for implementation.`
        : `Review found ${blockingIssues.length} blocking and ${majorIssues.length} major issues.`,
      issues,
      positives: tasks.length > 0 ? [`Task breakdown provided (${tasks.length} tasks)`] : [],
    };
  }
}
