/**
 * Architect Agent
 *
 * Receives epics from PM and adds technical specifications with task breakdown.
 * Uses LLM to analyze requirements and generate implementation plans.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { getLLM } from "../../llm/anthropic.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

// =============================================================================
// SCHEMAS
// =============================================================================

const TechSpecComponentSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  dependencies: z.array(z.string()),
});

const TechSpecInterfaceSchema = z.object({
  name: z.string(),
  definition: z.string(),
});

const TechSpecDecisionSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
});

const TechnicalSpecSchema = z.object({
  architecture: z.string(),
  components: z.array(TechSpecComponentSchema),
  file_structure: z.array(z.string()),
  interfaces: z.array(TechSpecInterfaceSchema),
  decisions: z.array(TechSpecDecisionSchema),
});

const TaskSpecSchema = z.object({
  title: z.string(),
  description: z.string(),
  files_to_modify: z.array(z.string()),
  implementation_approach: z.string(),
  test_requirements: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  estimated_complexity: z.enum(["low", "medium", "high"]),
});

const ArchitectResponseSchema = z.object({
  technical_spec: TechnicalSpecSchema,
  tasks: z.array(TaskSpecSchema),
});

type TechnicalSpec = z.infer<typeof TechnicalSpecSchema>;
type TaskSpec = z.infer<typeof TaskSpecSchema>;

// =============================================================================
// ARCHITECT AGENT
// =============================================================================

export class ArchitectAgent extends BaseAgent {
  private systemPrompt: string | null = null;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "architect",
      instanceId,
    };
    super(config);
  }

  /**
   * Load the architect system prompt.
   */
  private async getSystemPrompt(): Promise<string> {
    if (!this.systemPrompt) {
      const llm = getLLM();
      this.systemPrompt = await llm.loadSystemPrompt("architect");
      if (!this.systemPrompt) {
        throw new Error("Failed to load architect system prompt");
      }
    }
    return this.systemPrompt;
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

      // Generate technical spec and tasks using LLM
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
      // Assign to target role before publishing so they can claim the work
      await this.assignToRole(workItem.id, "cto-review");
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

  private async writeTaskSpec(epicId: string, taskNum: number, task: TaskSpec): Promise<string> {
    const repoRoot = process.cwd();
    const taskDir = join(repoRoot, ".flow", "tasks");
    const taskPath = join(taskDir, `${epicId}.${taskNum}.md`);

    await mkdir(dirname(taskPath), { recursive: true });

    const taskSpecContent = this.formatTaskSpec(task, taskNum);
    await writeFile(taskPath, taskSpecContent, "utf-8");

    return `.flow/tasks/${epicId}.${taskNum}.md`;
  }

  /**
   * Format a task spec as markdown.
   */
  private formatTaskSpec(task: TaskSpec, taskNum: number): string {
    return `# Task ${taskNum}: ${task.title}

## Description
${task.description}

## Files to Modify
${task.files_to_modify.map((f) => `- \`${f}\``).join("\n")}

## Implementation Approach
${task.implementation_approach}

## Test Requirements
${task.test_requirements.map((t) => `- [ ] ${t}`).join("\n")}

## Acceptance Criteria
${task.acceptance_criteria.map((c) => `- [ ] ${c}`).join("\n")}

## Estimated Complexity
${task.estimated_complexity}
`;
  }

  /**
   * Format technical spec as markdown for appending to epic.
   */
  private formatTechSpec(spec: TechnicalSpec): string {
    const sections: string[] = [];

    sections.push("## Technical Specification");
    sections.push("");
    sections.push("### Architecture");
    sections.push(spec.architecture);
    sections.push("");

    if (spec.components.length > 0) {
      sections.push("### Components");
      for (const comp of spec.components) {
        sections.push(`#### ${comp.name}`);
        sections.push(`- **Purpose:** ${comp.purpose}`);
        if (comp.dependencies.length > 0) {
          sections.push(`- **Dependencies:** ${comp.dependencies.join(", ")}`);
        }
        sections.push("");
      }
    }

    if (spec.file_structure.length > 0) {
      sections.push("### File Structure");
      for (const file of spec.file_structure) {
        sections.push(`- ${file}`);
      }
      sections.push("");
    }

    if (spec.interfaces.length > 0) {
      sections.push("### Interfaces");
      for (const iface of spec.interfaces) {
        sections.push(`#### ${iface.name}`);
        sections.push("```typescript");
        sections.push(iface.definition);
        sections.push("```");
        sections.push("");
      }
    }

    if (spec.decisions.length > 0) {
      sections.push("### Architecture Decisions");
      for (const dec of spec.decisions) {
        sections.push(`- **${dec.decision}:** ${dec.rationale}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Generate technical specification and tasks using LLM.
   */
  private async generateTechSpec(
    workItem: WorkItem,
    specContent: string,
  ): Promise<{
    techSpec: string;
    tasks: TaskSpec[];
  }> {
    const systemPrompt = await this.getSystemPrompt();
    const llm = getLLM();

    // Build the user prompt
    const userPrompt = `Analyze the following epic specification and generate a technical specification with task breakdown.

## Epic: ${workItem.title}

${specContent}

---

Please provide your response using the output_spec tool.`;

    console.log(`[architect] Calling LLM for technical spec generation...`);

    const response = await llm.completeWithSchema({
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      schema: ArchitectResponseSchema,
      schemaName: "output_spec",
      schemaDescription: "Output the technical specification and task breakdown",
      maxTokens: 8192,
      temperature: 0.7,
    });

    console.log(`[architect] LLM response received: ${response.tasks.length} tasks`);

    // Validate response structure
    if (!response.technical_spec || !response.tasks) {
      throw new Error("Invalid LLM response: missing technical_spec or tasks");
    }

    if (response.tasks.length === 0) {
      throw new Error("Invalid LLM response: no tasks generated");
    }

    // Format technical spec as markdown
    const techSpec = this.formatTechSpec(response.technical_spec);

    return {
      techSpec,
      tasks: response.tasks,
    };
  }
}
