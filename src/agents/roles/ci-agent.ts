/**
 * CI Agent
 *
 * Creates PRs and monitors CI pipeline, auto-fixing failures.
 *
 * Responsibilities:
 * - Listen for events from ui-review or code-simplifier
 * - Create GitHub PR using `gh pr create`
 * - Monitor CI status via `gh pr checks`
 * - On CI failure: read logs, attempt fix, re-push (max 3 attempts)
 * - On success: mark work item as done
 * - On persistent failure: escalate (update status to 'failed')
 *
 * Required gh CLI token scopes:
 * - repo (full control of private repositories)
 * - workflow (update GitHub Action workflows)
 * - read:org (read org membership, for org repos)
 */

import { spawn } from "node:child_process";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

const MAX_FIX_ATTEMPTS = 3;
const CI_POLL_INTERVAL_MS = 30000; // 30 seconds
const CI_TIMEOUT_MS = 600000; // 10 minutes

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface CICheckResult {
  name: string;
  status: "pass" | "fail" | "pending" | "skipped";
  conclusion: string;
  url: string;
}

interface CIStatus {
  passed: boolean;
  pending: boolean;
  checks: CICheckResult[];
  failedChecks: CICheckResult[];
}

export class CIAgent extends BaseAgent {
  private repoRoot: string;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "ci-agent",
      instanceId,
    };
    super(config);
    this.repoRoot = process.cwd();
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[ci-agent] Processing: ${workItem.title}`);

    // Accept events from ui-review or code-simplifier
    if (message.event_type !== "review_completed" && message.event_type !== "work_assigned") {
      console.log(`[ci-agent] Ignoring event type: ${message.event_type}`);
      return;
    }

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[ci-agent] Work item ${workItem.id} already claimed`);
      return;
    }

    const fixAttempts = (workItem.metadata?.ci_fix_attempts as number) ?? 0;

    try {
      // Build branch name: openclaw/<epic-id>/<task-id>
      const branchName = this.buildBranchName(workItem);

      // Ensure we're on the correct branch and push changes
      await this.ensureBranchAndPush(branchName, workItem);

      // Create or get existing PR
      const prUrl = await this.createOrGetPR(workItem, branchName);
      console.log(`[ci-agent] PR URL: ${prUrl}`);

      // Monitor CI status until completion or timeout
      const ciStatus = await this.monitorCI(prUrl);

      if (ciStatus.passed) {
        // CI passed - mark as done
        await this.updateWorkStatus(workItem.id, "done");
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "pm");
        await this.publish({
          workItemId: workItem.id,
          eventType: "ci_status",
          targetRole: "pm",
          payload: {
            pr_url: prUrl,
            status: "success",
            checks_passed: ciStatus.checks.length,
          },
        });
        console.log(`[ci-agent] CI passed, PR ready: ${prUrl}`);
      } else if (fixAttempts >= MAX_FIX_ATTEMPTS) {
        // Too many fix attempts - escalate to failed
        const errorMsg = `CI failures persist after ${MAX_FIX_ATTEMPTS} fix attempts`;
        await this.updateWorkStatus(workItem.id, "failed", errorMsg);
        // Assign to target role before publishing so they can claim the work
        await this.assignToRole(workItem.id, "pm");
        await this.publish({
          workItemId: workItem.id,
          eventType: "ci_status",
          targetRole: "pm",
          payload: {
            pr_url: prUrl,
            status: "failed",
            error: errorMsg,
            failed_checks: ciStatus.failedChecks.map((c) => c.name),
          },
        });
        console.log(`[ci-agent] Escalated to failed: ${workItem.title}`);
      } else {
        // CI failed - attempt to fix
        console.log(
          `[ci-agent] CI failed, attempting fix (attempt ${fixAttempts + 1}/${MAX_FIX_ATTEMPTS})`,
        );

        // Increment fix attempts
        await this.incrementFixAttempts(workItem.id, fixAttempts);

        // Read CI logs and attempt fix
        const fixed = await this.attemptFix(workItem, prUrl, ciStatus, branchName);

        if (fixed) {
          // Push fixes and re-trigger CI
          await this.pushFixes(branchName, workItem);

          // Re-queue for CI monitoring
          // Assign to target role before publishing so they can claim the work
          await this.assignToRole(workItem.id, "ci-agent");
          await this.publish({
            workItemId: workItem.id,
            eventType: "work_assigned",
            targetRole: "ci-agent",
            payload: {
              retry: true,
              fix_attempt: fixAttempts + 1,
              pr_url: prUrl,
            },
          });
        } else {
          // Could not fix - escalate
          const errorMsg = "Unable to automatically fix CI failures";
          await this.updateWorkStatus(workItem.id, "failed", errorMsg);
          // Assign to target role before publishing so they can claim the work
          await this.assignToRole(workItem.id, "pm");
          await this.publish({
            workItemId: workItem.id,
            eventType: "ci_status",
            targetRole: "pm",
            payload: {
              pr_url: prUrl,
              status: "failed",
              error: errorMsg,
              failed_checks: ciStatus.failedChecks.map((c) => c.name),
            },
          });
        }
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      console.error(`[ci-agent] Error: ${errorMsg}`);
      await this.updateWorkStatus(workItem.id, "failed", errorMsg);
      throw err;
    }
  }

  /**
   * Build branch name: openclaw/<epic-id>/<task-id>
   */
  private buildBranchName(workItem: WorkItem): string {
    const epicId = workItem.parent_id ?? "main";
    const taskId = workItem.id.substring(0, 8);
    return `openclaw/${epicId.substring(0, 8)}/${taskId}`;
  }

  /**
   * Ensure branch exists and push any uncommitted changes
   */
  private async ensureBranchAndPush(branchName: string, _workItem: WorkItem): Promise<void> {
    // Safety check: verify working tree is clean before git operations
    const statusCheck = await this.runCommand("git", ["status", "--porcelain"]);
    if (statusCheck.stdout.trim()) {
      throw new Error(
        `Working tree is dirty, cannot safely switch branches. ` +
          `Uncommitted changes: ${statusCheck.stdout.trim().split("\n").length} files`,
      );
    }

    // Check if branch exists remotely
    const remoteBranches = await this.runCommand("git", ["branch", "-r"]);
    const branchExists = remoteBranches.stdout.includes(`origin/${branchName}`);

    if (!branchExists) {
      // Create branch from current HEAD
      await this.runCommand("git", ["checkout", "-b", branchName]);
    } else {
      // Checkout existing branch
      await this.runCommand("git", ["checkout", branchName]);
      await this.runCommand("git", ["pull", "origin", branchName, "--rebase"]);
    }

    // Push branch to remote
    const pushResult = await this.runCommand("git", ["push", "-u", "origin", branchName]);
    if (!pushResult.success) {
      console.log(`[ci-agent] Push warning: ${pushResult.stderr}`);
    }
  }

  /**
   * Create PR or get existing PR URL
   */
  private async createOrGetPR(workItem: WorkItem, branchName: string): Promise<string> {
    // Check if PR already exists
    const existingPR = await this.runCommand("gh", [
      "pr",
      "view",
      branchName,
      "--json",
      "url",
      "--jq",
      ".url",
    ]);

    if (existingPR.success && existingPR.stdout.trim()) {
      return existingPR.stdout.trim();
    }

    // Create new PR
    const prBody = this.buildPRBody(workItem);
    const result = await this.runCommand("gh", [
      "pr",
      "create",
      "--title",
      `[${workItem.id.substring(0, 8)}] ${workItem.title}`,
      "--body",
      prBody,
      "--head",
      branchName,
    ]);

    if (result.success) {
      return result.stdout.trim();
    }

    // If PR creation failed, try to get existing PR URL
    const fallback = await this.runCommand("gh", [
      "pr",
      "view",
      branchName,
      "--json",
      "url",
      "--jq",
      ".url",
    ]);

    if (fallback.success && fallback.stdout.trim()) {
      return fallback.stdout.trim();
    }

    throw new Error(`Failed to create PR: ${result.stderr}`);
  }

  /**
   * Build PR body with work item reference
   */
  private buildPRBody(workItem: WorkItem): string {
    return `## Summary

Implements work item: \`${workItem.id}\`

${workItem.description ?? ""}

## Work Item Details

- **Type:** ${workItem.type}
- **Priority:** ${workItem.priority}
- **Parent:** ${workItem.parent_id ?? "None"}

## Checklist

- [ ] Tests pass locally
- [ ] Code follows project style
- [ ] Documentation updated (if needed)

---
*Created by OpenClaw CI Agent*`;
  }

  /**
   * Monitor CI status until completion or timeout
   */
  private async monitorCI(prUrl: string): Promise<CIStatus> {
    const startTime = Date.now();

    while (Date.now() - startTime < CI_TIMEOUT_MS) {
      const status = await this.getCIStatus(prUrl);

      if (!status.pending) {
        return status;
      }

      console.log(`[ci-agent] CI still running, waiting ${CI_POLL_INTERVAL_MS / 1000}s...`);
      await this.sleep(CI_POLL_INTERVAL_MS);
    }

    // Timeout - treat as failure
    return {
      passed: false,
      pending: false,
      checks: [],
      failedChecks: [
        {
          name: "timeout",
          status: "fail",
          conclusion: "CI timed out",
          url: prUrl,
        },
      ],
    };
  }

  /**
   * Get current CI status using gh pr checks
   */
  private async getCIStatus(prUrl: string): Promise<CIStatus> {
    const result = await this.runCommand("gh", [
      "pr",
      "checks",
      prUrl,
      "--json",
      "name,state,conclusion,detailsUrl",
    ]);

    if (!result.success) {
      console.log(`[ci-agent] Failed to get CI status: ${result.stderr}`);
      // If no checks available yet, treat as pending
      if (result.stderr.includes("no checks")) {
        return { passed: false, pending: true, checks: [], failedChecks: [] };
      }
      return {
        passed: false,
        pending: false,
        checks: [],
        failedChecks: [
          {
            name: "unknown",
            status: "fail",
            conclusion: result.stderr,
            url: prUrl,
          },
        ],
      };
    }

    try {
      const checks = JSON.parse(result.stdout) as Array<{
        name: string;
        state: string;
        conclusion: string;
        detailsUrl: string;
      }>;

      const mappedChecks: CICheckResult[] = checks.map((c) => ({
        name: c.name,
        status: this.mapCheckStatus(c.state, c.conclusion),
        conclusion: c.conclusion ?? c.state,
        url: c.detailsUrl ?? prUrl,
      }));

      const pending = mappedChecks.some((c) => c.status === "pending");
      const failedChecks = mappedChecks.filter((c) => c.status === "fail");
      const passed = !pending && failedChecks.length === 0;

      return { passed, pending, checks: mappedChecks, failedChecks };
    } catch {
      return { passed: false, pending: true, checks: [], failedChecks: [] };
    }
  }

  /**
   * Map GitHub check state/conclusion to our status
   */
  private mapCheckStatus(
    state: string,
    conclusion: string,
  ): "pass" | "fail" | "pending" | "skipped" {
    if (state === "PENDING" || state === "QUEUED" || state === "IN_PROGRESS") {
      return "pending";
    }
    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") {
      return "pass";
    }
    if (conclusion === "SKIPPED") {
      return "skipped";
    }
    return "fail";
  }

  /**
   * Increment fix attempts counter in metadata
   */
  private async incrementFixAttempts(workItemId: string, current: number): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE work_items
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ci_fix_attempts}', $1::jsonb)
         WHERE id = $2`,
        [(current + 1).toString(), workItemId],
      );
    });
  }

  /**
   * Attempt to fix CI failures by reading logs and applying fixes
   */
  private async attemptFix(
    workItem: WorkItem,
    _prUrl: string,
    ciStatus: CIStatus,
    branchName: string,
  ): Promise<boolean> {
    console.log(`[ci-agent] Analyzing ${ciStatus.failedChecks.length} failed checks...`);

    for (const check of ciStatus.failedChecks) {
      console.log(`[ci-agent] Failed check: ${check.name} - ${check.conclusion}`);

      // Get detailed logs for the failed check
      const logs = await this.getCheckLogs(branchName, check.name);
      if (logs) {
        console.log(`[ci-agent] Check logs (truncated): ${logs.substring(0, 500)}...`);

        // Analyze logs and attempt fix
        const fixed = await this.analyzeAndFix(check.name, logs, workItem);
        if (!fixed) {
          console.log(`[ci-agent] Could not auto-fix: ${check.name}`);
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Get logs for a specific check
   */
  private async getCheckLogs(branchName: string, checkName: string): Promise<string | null> {
    // Get run ID for the check
    const runsResult = await this.runCommand("gh", [
      "run",
      "list",
      "--branch",
      branchName,
      "--json",
      "databaseId,name,status",
      "--limit",
      "10",
    ]);

    if (!runsResult.success) {
      return null;
    }

    try {
      const runs = JSON.parse(runsResult.stdout) as Array<{
        databaseId: number;
        name: string;
        status: string;
      }>;

      // Find matching run
      const matchingRun = runs.find(
        (r) => r.name.includes(checkName) || checkName.includes(r.name),
      );
      if (!matchingRun) {
        return null;
      }

      // Get logs for the run
      const logsResult = await this.runCommand("gh", [
        "run",
        "view",
        matchingRun.databaseId.toString(),
        "--log-failed",
      ]);

      return logsResult.success ? logsResult.stdout : null;
    } catch {
      return null;
    }
  }

  /**
   * Analyze failure logs and attempt to fix
   */
  private async analyzeAndFix(
    checkName: string,
    logs: string,
    _workItem: WorkItem,
  ): Promise<boolean> {
    // Common failure patterns and fixes
    const lowerLogs = logs.toLowerCase();

    // Type errors
    if (lowerLogs.includes("type error") || lowerLogs.includes("ts error")) {
      console.log("[ci-agent] Detected TypeScript errors, running type check...");
      const buildResult = await this.runCommand("pnpm", ["build"]);
      if (!buildResult.success) {
        // TODO: Use LLM to analyze and fix type errors
        console.log("[ci-agent] Build failed, needs manual fix");
        return false;
      }
      return true;
    }

    // Lint errors
    if (
      lowerLogs.includes("lint") ||
      lowerLogs.includes("eslint") ||
      lowerLogs.includes("oxlint")
    ) {
      console.log("[ci-agent] Detected lint errors, running auto-fix...");
      const checkResult = await this.runCommand("pnpm", ["check", "--fix"]);
      return checkResult.success;
    }

    // Test failures
    if (lowerLogs.includes("test") && (lowerLogs.includes("fail") || lowerLogs.includes("error"))) {
      console.log("[ci-agent] Detected test failures");
      // TODO: Use LLM to analyze test failures and fix
      // For now, just re-run tests to see if flaky
      const testResult = await this.runCommand("pnpm", ["test"]);
      return testResult.success;
    }

    // Format errors
    if (lowerLogs.includes("format") || lowerLogs.includes("prettier")) {
      console.log("[ci-agent] Detected formatting errors, running format...");
      const formatResult = await this.runCommand("pnpm", ["format"]);
      return formatResult.success;
    }

    // Unknown failure type
    console.log(`[ci-agent] Unknown failure type for check: ${checkName}`);
    return false;
  }

  /**
   * Push fixes to the branch
   */
  private async pushFixes(branchName: string, workItem: WorkItem): Promise<void> {
    // Stage all changes
    await this.runCommand("git", ["add", "-A"]);

    // Check if there are changes to commit
    const statusResult = await this.runCommand("git", ["status", "--porcelain"]);
    if (!statusResult.stdout.trim()) {
      console.log("[ci-agent] No changes to commit");
      return;
    }

    // Commit fixes
    const commitMsg = `fix(ci): auto-fix CI failures for ${workItem.id.substring(0, 8)}`;
    await this.runCommand("git", ["commit", "-m", commitMsg]);

    // Push to remote
    const pushResult = await this.runCommand("git", ["push", "origin", branchName]);
    if (!pushResult.success) {
      throw new Error(`Failed to push fixes: ${pushResult.stderr}`);
    }

    console.log("[ci-agent] Pushed fixes to branch");
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

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
