/**
 * Senior Dev Agent
 *
 * Implements tasks using strict TDD:
 * 1. Read task spec from .flow/tasks/<epic-id>.<task-number>.md
 * 2. Write tests FIRST
 * 3. Implement code to pass tests
 * 4. Iterate until tests pass
 * 5. Commit with task ID reference
 * 6. Publish work_completed to staff-engineer
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

const MAX_TDD_ITERATIONS = 5;

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface TDDResult {
  testsWritten: boolean;
  implementationDone: boolean;
  testsPassed: boolean;
  iterations: number;
  error?: string;
}

export class SeniorDevAgent extends BaseAgent {
  private repoRoot: string;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "senior-dev",
      instanceId,
    };
    super(config);
    this.repoRoot = process.cwd();
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[senior-dev] Received task: ${workItem.title}`);

    // Only process work_assigned events
    if (message.event_type !== "work_assigned") {
      console.log(`[senior-dev] Ignoring event type: ${message.event_type}`);
      return;
    }

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[senior-dev] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Read task spec
      const taskSpec = await this.readTaskSpec(workItem);
      console.log(`[senior-dev] Task spec loaded: ${taskSpec.substring(0, 100)}...`);

      // Implement with TDD
      const result = await this.implementWithTDD(workItem, taskSpec);

      if (!result.testsPassed) {
        throw new Error(`TDD failed after ${result.iterations} iterations: ${result.error}`);
      }

      // Create git commit
      await this.createCommit(workItem);

      // Mark for review and notify staff-engineer
      await this.updateWorkStatus(workItem.id, "review");
      await this.assignToRole(workItem.id, "staff-engineer");
      await this.publish({
        workItemId: workItem.id,
        eventType: "work_completed",
        targetRole: "staff-engineer",
        payload: {
          ready_for_review: true,
          tdd_iterations: result.iterations,
          task_spec_path: workItem.spec_path,
        },
      });

      console.log(
        `[senior-dev] Task complete: ${workItem.title} (${result.iterations} TDD iterations)`,
      );
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(`[senior-dev] Task failed: ${errorMsg}`);
      await this.updateWorkStatus(workItem.id, "failed", errorMsg);
      throw err;
    }
  }

  /**
   * Read task spec from .flow/tasks/<epic-id>.<task-number>.md
   */
  private async readTaskSpec(workItem: WorkItem): Promise<string> {
    // Try spec_path first if set
    if (workItem.spec_path) {
      try {
        const fullPath = join(this.repoRoot, workItem.spec_path);
        return await readFile(fullPath, "utf-8");
      } catch {
        console.log(`[senior-dev] Spec file not found at ${workItem.spec_path}, using description`);
      }
    }

    // Try .flow/tasks/<id>.md pattern
    const taskSpecPath = join(this.repoRoot, ".flow", "tasks", `${workItem.id}.md`);
    try {
      return await readFile(taskSpecPath, "utf-8");
    } catch {
      // Fall back to description or title
      return workItem.description ?? workItem.title;
    }
  }

  /**
   * Implement task using TDD: tests first, then implementation, iterate until passing
   */
  private async implementWithTDD(workItem: WorkItem, taskSpec: string): Promise<TDDResult> {
    const result: TDDResult = {
      testsWritten: false,
      implementationDone: false,
      testsPassed: false,
      iterations: 0,
    };

    // Step 1: Write tests first
    console.log("[senior-dev] Step 1: Writing tests...");
    await this.writeTests(workItem, taskSpec);
    result.testsWritten = true;

    // Step 2: Implement and iterate until tests pass
    for (let i = 0; i < MAX_TDD_ITERATIONS; i++) {
      result.iterations = i + 1;
      console.log(`[senior-dev] TDD iteration ${result.iterations}/${MAX_TDD_ITERATIONS}`);

      // Run implementation
      if (!result.implementationDone) {
        console.log("[senior-dev] Step 2: Writing implementation...");
        await this.writeImplementation(workItem, taskSpec);
        result.implementationDone = true;
      }

      // Run tests
      console.log("[senior-dev] Step 3: Running tests...");
      const testResult = await this.runTests();

      if (testResult.success) {
        console.log("[senior-dev] Tests passed!");
        result.testsPassed = true;
        break;
      }

      console.log(
        `[senior-dev] Tests failed, fixing... (${testResult.stderr || testResult.stdout})`,
      );

      // Fix implementation based on test failures
      await this.fixImplementation(workItem, taskSpec, testResult);
    }

    if (!result.testsPassed) {
      result.error = `Tests still failing after ${MAX_TDD_ITERATIONS} iterations`;
    }

    return result;
  }

  /**
   * Write tests based on task spec (TDD: tests first)
   */
  private async writeTests(workItem: WorkItem, _taskSpec: string): Promise<void> {
    // TODO: Use LLM to generate tests from task spec
    // For now, create a placeholder test file structure

    console.log(`[senior-dev] Analyzing task spec for test generation...`);

    // Extract test requirements from spec
    const testPath = this.deriveTestPath(workItem);

    // Placeholder: actual implementation would use Claude/GPT to generate tests
    console.log(`[senior-dev] Test file would be created at: ${testPath}`);
  }

  /**
   * Write implementation to pass the tests
   */
  private async writeImplementation(_workItem: WorkItem, _taskSpec: string): Promise<void> {
    // TODO: Use LLM to implement code that passes tests
    console.log(`[senior-dev] Implementing based on task spec...`);

    // Placeholder: actual implementation would use Claude/GPT
  }

  /**
   * Fix implementation based on test failures
   */
  private async fixImplementation(
    workItem: WorkItem,
    taskSpec: string,
    testResult: CommandResult,
  ): Promise<void> {
    // TODO: Use LLM to analyze failures and fix code
    console.log(`[senior-dev] Analyzing test failures...`);
    console.log(`[senior-dev] Test output: ${testResult.stdout.substring(0, 500)}`);

    // Placeholder: actual implementation would use Claude/GPT to fix code
  }

  /**
   * Run tests using pnpm test
   */
  private async runTests(): Promise<CommandResult> {
    return this.runCommand("pnpm", ["test"]);
  }

  /**
   * Create git commit with task reference
   */
  private async createCommit(workItem: WorkItem): Promise<void> {
    // Stage changes
    const addResult = await this.runCommand("git", ["add", "-A"]);
    if (!addResult.success) {
      console.log("[senior-dev] No changes to stage or staging failed");
    }

    // Check if there are changes to commit
    const statusResult = await this.runCommand("git", ["status", "--porcelain"]);
    if (!statusResult.stdout.trim()) {
      console.log("[senior-dev] No changes to commit");
      return;
    }

    // Extract task ID for commit message
    const taskId = this.extractTaskId(workItem);
    const commitMsg = this.buildCommitMessage(workItem, taskId);

    const commitResult = await this.runCommand("git", ["commit", "-m", commitMsg]);
    if (commitResult.success) {
      console.log(`[senior-dev] Committed: ${commitMsg.split("\n")[0]}`);
    } else {
      console.log(`[senior-dev] Commit skipped: ${commitResult.stderr}`);
    }
  }

  /**
   * Extract task ID from work item (e.g., "epic-123.task-1" from spec path)
   */
  private extractTaskId(workItem: WorkItem): string {
    if (workItem.spec_path) {
      // Extract from path like .flow/tasks/epic-123.1.md
      const match = workItem.spec_path.match(/([^/]+)\.md$/);
      if (match) {
        return match[1];
      }
    }
    // Use work item ID as fallback
    return workItem.id.substring(0, 8);
  }

  /**
   * Build commit message with task reference
   */
  private buildCommitMessage(workItem: WorkItem, taskId: string): string {
    const type = this.inferCommitType(workItem.title);
    const scope = this.inferScope(workItem);

    return `${type}${scope}: ${workItem.title}

Task: ${taskId}
Work Item: ${workItem.id}

Implemented with TDD approach.`;
  }

  /**
   * Infer commit type from work item title
   */
  private inferCommitType(title: string): string {
    const lower = title.toLowerCase();
    if (lower.includes("fix") || lower.includes("bug")) {
      return "fix";
    }
    if (lower.includes("test")) {
      return "test";
    }
    if (lower.includes("doc")) {
      return "docs";
    }
    if (lower.includes("refactor")) {
      return "refactor";
    }
    if (lower.includes("style") || lower.includes("format")) {
      return "style";
    }
    if (lower.includes("chore") || lower.includes("update dep")) {
      return "chore";
    }
    return "feat";
  }

  /**
   * Infer scope from work item
   */
  private inferScope(workItem: WorkItem): string {
    // Try to extract scope from spec path or metadata
    if (workItem.spec_path) {
      const parts = workItem.spec_path.split("/");
      if (parts.length > 2) {
        return `(${parts[parts.length - 2]})`;
      }
    }
    return "";
  }

  /**
   * Derive test file path from work item
   */
  private deriveTestPath(workItem: WorkItem): string {
    // Default convention: colocate tests with source
    const baseName = workItem.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .substring(0, 40);
    return join(this.repoRoot, "src", `${baseName}.test.ts`);
  }

  /**
   * Execute a command and capture output
   */
  private runCommand(cmd: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        cwd: this.repoRoot,
        stdio: "pipe",
        env: { ...process.env },
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
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
        });
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          stdout,
          stderr: err.message,
          exitCode: null,
        });
      });
    });
  }
}
