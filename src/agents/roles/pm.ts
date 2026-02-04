/**
 * PM Agent - Product Manager
 *
 * Receives goals/requests and creates epics with user stories.
 * First agent in the pipeline - entry point for new work.
 *
 * Listens for: goal_submitted
 * Publishes: work_created -> architect
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { getLLM, type AnthropicClient } from "../../llm/anthropic.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

// =============================================================================
// SCHEMAS
// =============================================================================

const UserStorySchema = z.object({
  title: z.string().describe("Brief descriptive title"),
  story: z.string().describe("As a [user], I want [feature] so that [benefit]"),
  acceptance_criteria: z.array(z.string()).describe("List of acceptance criteria"),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level"),
  complexity: z.enum(["simple", "medium", "complex"]).describe("Estimated complexity"),
});

const EpicSpecSchema = z.object({
  title: z.string().describe("Concise epic title"),
  description: z.string().describe("Detailed epic description with context and goals"),
  user_stories: z.array(UserStorySchema).describe("Ordered list of user stories"),
  technical_notes: z.array(z.string()).describe("Technical considerations and notes"),
  testing_strategy: z.array(z.string()).describe("Testing approach and key scenarios"),
  out_of_scope: z.array(z.string()).optional().describe("Items explicitly not included"),
});

type EpicSpec = z.infer<typeof EpicSpecSchema>;

// =============================================================================
// PM AGENT
// =============================================================================

export class PMAgent extends BaseAgent {
  private llm: AnthropicClient;
  private systemPrompt: string | null = null;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "pm",
      instanceId,
    };
    super(config);
    this.llm = getLLM();
  }

  /**
   * Load the PM system prompt on first use.
   */
  private async getSystemPrompt(): Promise<string> {
    if (this.systemPrompt) {
      return this.systemPrompt;
    }
    this.systemPrompt = await this.llm.loadSystemPrompt("pm");
    return this.systemPrompt;
  }

  /**
   * Handle incoming work - break down goals into epics.
   */
  protected async onWorkAssigned(_message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[pm] Processing goal: ${workItem.title}`);

    // Claim the work atomically
    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[pm] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Parse the goal from the work item
      const goal = workItem.description ?? workItem.title;

      // Generate epic spec using LLM
      const epicSpec = await this.generateEpicSpec(goal);

      // Format and write spec file
      const specContent = this.formatEpicSpec(epicSpec);
      const specPath = await this.writeSpecFile(workItem.id, specContent);

      // Update work item with spec path and epic title
      await this.db.transaction(async (client) => {
        await client.query("UPDATE work_items SET spec_path = $1, title = $2 WHERE id = $3", [
          specPath,
          epicSpec.title,
          workItem.id,
        ]);
      });

      // Request domain expert review before architect
      await this.updateWorkStatus(workItem.id, "in_progress");
      // Assign to target role before publishing so they can claim the work
      await this.assignToRole(workItem.id, "domain-expert");
      await this.publish({
        workItemId: workItem.id,
        eventType: "review_requested",
        targetRole: "domain-expert",
        payload: {
          spec_path: specPath,
          story_count: epicSpec.user_stories.length,
        },
      });

      console.log(`[pm] Epic created: ${epicSpec.title} - sent to domain expert for review`);
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  /**
   * Generate epic specification using LLM.
   */
  private async generateEpicSpec(goal: string): Promise<EpicSpec> {
    const systemPrompt = await this.getSystemPrompt();

    try {
      const epicSpec = await this.llm.completeWithSchema({
        systemPrompt,
        messages: [
          {
            role: "user",
            content: `Please analyze this goal and create a detailed epic specification with user stories:\n\n${goal}`,
          },
        ],
        schema: EpicSpecSchema,
        schemaName: "create_epic",
        schemaDescription: "Create an epic specification with user stories from a goal",
        temperature: 0.7,
      });

      return epicSpec;
    } catch (err) {
      console.error("[pm] LLM generation failed:", (err as Error).message);
      // Fallback to basic spec if LLM fails
      return this.generateFallbackSpec(goal);
    }
  }

  /**
   * Generate a basic fallback spec when LLM is unavailable.
   */
  private generateFallbackSpec(goal: string): EpicSpec {
    return {
      title: goal.slice(0, 100),
      description: goal,
      user_stories: [
        {
          title: "Core Implementation",
          story: `As a user, I want ${goal.toLowerCase()} so that I can achieve my objective.`,
          acceptance_criteria: [
            "Core functionality is implemented",
            "Basic validation works",
            "Error handling is in place",
          ],
          priority: "high",
          complexity: "medium",
        },
        {
          title: "Testing",
          story: "As a developer, I want tests so that I can verify the implementation.",
          acceptance_criteria: [
            "Unit tests cover main paths",
            "Integration tests verify end-to-end flow",
          ],
          priority: "high",
          complexity: "simple",
        },
      ],
      technical_notes: [
        "Follow existing patterns in codebase",
        "Use TDD approach where applicable",
      ],
      testing_strategy: [
        "Unit tests for business logic",
        "Integration tests for API endpoints",
        "E2E tests for critical user flows",
      ],
    };
  }

  /**
   * Format epic spec as markdown.
   */
  private formatEpicSpec(spec: EpicSpec): string {
    const timestamp = new Date().toISOString();
    const lines: string[] = [];

    lines.push(`# Epic: ${spec.title}`);
    lines.push("");
    lines.push("## Overview");
    lines.push(spec.description);
    lines.push("");

    if (spec.out_of_scope && spec.out_of_scope.length > 0) {
      lines.push("## Out of Scope");
      for (const item of spec.out_of_scope) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }

    lines.push("## User Stories");
    lines.push("");

    for (let i = 0; i < spec.user_stories.length; i++) {
      const story = spec.user_stories[i];
      lines.push(`### Story ${i + 1}: ${story.title}`);
      lines.push("");
      lines.push(`**Priority**: ${story.priority.toUpperCase()}`);
      lines.push(`**Complexity**: ${story.complexity}`);
      lines.push("");
      lines.push(story.story);
      lines.push("");
      lines.push("**Acceptance Criteria:**");
      for (const criterion of story.acceptance_criteria) {
        lines.push(`- [ ] ${criterion}`);
      }
      lines.push("");
    }

    lines.push("## Technical Notes");
    for (const note of spec.technical_notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");

    lines.push("## Testing Strategy");
    for (const item of spec.testing_strategy) {
      lines.push(`- ${item}`);
    }
    lines.push("");

    lines.push("---");
    lines.push(`Generated: ${timestamp}`);
    lines.push("Agent: PM");

    return lines.join("\n");
  }

  /**
   * Write spec file to .flow/specs directory.
   */
  private async writeSpecFile(workItemId: string, content: string): Promise<string> {
    const repoRoot = process.cwd();
    const specDir = join(repoRoot, ".flow", "specs");
    const specPath = join(specDir, `${workItemId}.md`);

    await mkdir(dirname(specPath), { recursive: true });
    await writeFile(specPath, content, "utf-8");

    return `.flow/specs/${workItemId}.md`;
  }
}
