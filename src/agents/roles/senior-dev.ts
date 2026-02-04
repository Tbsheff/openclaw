/**
 * Senior Dev Agent
 *
 * Receives approved tasks and implements with TDD.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

export class SeniorDevAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "senior-dev",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[senior-dev] Processing task: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[senior-dev] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Read task spec
      const taskSpec = workItem.spec_path
        ? await this.readSpecFile(workItem.spec_path)
        : (workItem.description ?? workItem.title);

      // Implement the task (placeholder - will use LLM + tools)
      await this.implementTask(workItem, taskSpec);

      // Run tests
      const testsPassed = await this.runTests();
      if (!testsPassed) {
        throw new Error("Tests failed");
      }

      // Create git commit
      await this.commitChanges(workItem);

      // Mark complete, notify staff engineer for review
      await this.updateWorkStatus(workItem.id, "review");
      await this.publish({
        workItemId: workItem.id,
        eventType: "work_completed",
        targetRole: "staff-engineer",
        payload: { ready_for_review: true },
      });

      console.log(`[senior-dev] Task complete: ${workItem.title}`);
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

  private async implementTask(workItem: WorkItem, taskSpec: string): Promise<void> {
    // TODO: Use LLM with tools to implement the task
    // This will involve:
    // 1. Reading existing code
    // 2. Writing tests first (TDD)
    // 3. Implementing code to pass tests
    // 4. Running lints/formatters

    console.log(`[senior-dev] Implementing task based on spec...`);
    console.log(`[senior-dev] Task spec preview: ${taskSpec.substring(0, 200)}...`);

    // Placeholder - actual implementation would use Claude/GPT
  }

  private async runTests(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("pnpm", ["test"], {
        cwd: process.cwd(),
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          console.log("[senior-dev] Tests passed");
          resolve(true);
        } else {
          console.error("[senior-dev] Tests failed:", stderr || stdout);
          resolve(false);
        }
      });

      proc.on("error", (err) => {
        console.error("[senior-dev] Failed to run tests:", err.message);
        resolve(false);
      });
    });
  }

  private async commitChanges(workItem: WorkItem): Promise<void> {
    return new Promise((resolve, reject) => {
      const commitMsg = `feat: ${workItem.title}\n\nWork item: ${workItem.id}`;

      const proc = spawn("git", ["commit", "-am", commitMsg], {
        cwd: process.cwd(),
        stdio: "pipe",
      });

      proc.on("close", (code) => {
        if (code === 0) {
          console.log("[senior-dev] Changes committed");
          resolve();
        } else {
          // No changes to commit is OK
          resolve();
        }
      });

      proc.on("error", reject);
    });
  }
}
