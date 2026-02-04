/**
 * Staff Engineer Agent
 *
 * Carmack-level code review: correctness, edge cases, simplicity.
 *
 * Flow:
 * - Listens for `work_completed` from senior-dev
 * - SHIP → publish `review_completed` to code-simplifier
 * - NEEDS_WORK → publish `review_completed` to senior-dev with feedback
 * - Max 3 review loops before escalation
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

const MAX_REVIEW_LOOPS = 3;

type Verdict = "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK";

interface ReviewResult {
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  summary: string;
  issues: Array<{
    severity: "critical" | "major" | "minor" | "nit";
    category: "correctness" | "edge-case" | "error-handling" | "simplicity" | "resources";
    file?: string;
    line?: number;
    description: string;
    suggestion?: string;
  }>;
  positives: string[];
}

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

    // Only process work_completed events from senior-dev
    if (message.event_type !== "work_completed" && message.event_type !== "work_assigned") {
      console.log(`[staff-engineer] Skipping event type: ${message.event_type}`);
      return;
    }

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[staff-engineer] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Get review attempt count from metadata
      const reviewCount = (workItem.metadata?.staff_review_count as number) ?? 0;

      // Perform the code review
      const review = await this.reviewCode(workItem);

      // Record the review in metadata
      await this.recordReviewInMetadata(workItem.id, reviewCount + 1, review);

      if (review.verdict === "SHIP") {
        // Approved - send to code simplifier
        await this.updateWorkStatus(workItem.id, "review");
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "code-simplifier");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "code-simplifier",
          payload: {
            verdict: "SHIP",
            approved_by: "staff-engineer",
            review_summary: review.summary,
            positives: review.positives,
          },
        });
        console.log(`[staff-engineer] SHIP: ${workItem.title}`);
      } else if (review.verdict === "MAJOR_RETHINK" || reviewCount >= MAX_REVIEW_LOOPS) {
        // Major issues or too many review loops - escalate
        const reason =
          review.verdict === "MAJOR_RETHINK"
            ? "Fundamental issues require architectural changes"
            : `Max review loops (${MAX_REVIEW_LOOPS}) exceeded`;

        await this.updateWorkStatus(workItem.id, "blocked", reason);

        // Escalate to CTO for human review
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "cto-review");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "cto-review",
          payload: {
            verdict: review.verdict,
            escalated: true,
            reason,
            issues: review.issues,
            review_count: reviewCount + 1,
          },
        });
        console.log(`[staff-engineer] ESCALATED: ${workItem.title} - ${reason}`);
      } else {
        // Needs work - send back to senior dev with feedback
        await this.updateWorkStatus(workItem.id, "in_progress");
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "senior-dev");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "senior-dev",
          payload: {
            verdict: "NEEDS_WORK",
            feedback: review.summary,
            issues: review.issues,
            review_count: reviewCount + 1,
            remaining_attempts: MAX_REVIEW_LOOPS - (reviewCount + 1),
          },
        });
        console.log(
          `[staff-engineer] NEEDS_WORK: ${workItem.title} (${review.issues.length} issues, ${MAX_REVIEW_LOOPS - (reviewCount + 1)} attempts remaining)`,
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
             '{staff_review_count}',
             $1::jsonb
           ),
           '{staff_review_history}',
           COALESCE(metadata->'staff_review_history', '[]'::jsonb) || $2::jsonb
         )
         WHERE id = $3`,
        [
          reviewCount.toString(),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            verdict: review.verdict,
            summary: review.summary,
            issues: review.issues.map((i) => ({
              severity: i.severity,
              category: i.category,
              description: i.description,
            })),
          }),
          workItemId,
        ],
      );
    });
  }

  /**
   * Read a file from the repository.
   */
  private async readFile(filePath: string): Promise<string> {
    const repoRoot = process.cwd();
    const fullPath = join(repoRoot, filePath);
    try {
      return await readFile(fullPath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Perform Carmack-level code review.
   *
   * TODO: Integrate with LLM using prompts/staff-engineer.md
   */
  private async reviewCode(workItem: WorkItem): Promise<ReviewResult> {
    console.log(`[staff-engineer] Performing code review...`);

    // Read the spec if available
    const specContent = workItem.spec_path ? await this.readFile(workItem.spec_path) : "";

    // TODO: Use LLM to review code
    // Load prompts/staff-engineer.md and send to Claude/GPT with:
    // - Task specification (specContent)
    // - Git diff of changes
    // - Relevant test files
    // - Dependencies and imports

    // Placeholder validation logic
    const issues: ReviewResult["issues"] = [];
    const positives: string[] = [];

    // Check for spec file
    if (!specContent) {
      issues.push({
        severity: "minor",
        category: "correctness",
        description: "No specification file found for this task",
        suggestion: "Verify implementation matches intended behavior",
      });
    }

    // Check for acceptance criteria
    if (specContent && specContent.includes("## Acceptance Criteria")) {
      positives.push("Task has clear acceptance criteria");
    }

    // Check for tests mentioned
    if (specContent && (specContent.includes("test") || specContent.includes("Test"))) {
      positives.push("Testing is part of the spec");
    }

    // Determine verdict based on issues
    const criticalIssues = issues.filter((i) => i.severity === "critical");
    const majorIssues = issues.filter((i) => i.severity === "major");

    let verdict: Verdict;
    if (criticalIssues.length > 0) {
      verdict = "MAJOR_RETHINK";
    } else if (majorIssues.length > 2) {
      verdict = "NEEDS_WORK";
    } else {
      verdict = "SHIP";
    }

    return {
      verdict,
      confidence: "medium",
      summary:
        verdict === "SHIP"
          ? "Code review passed. Clean implementation ready for simplification."
          : `Found ${criticalIssues.length} critical and ${majorIssues.length} major issues.`,
      issues,
      positives,
    };
  }
}
