/**
 * CI Agent
 *
 * Creates PRs and monitors CI pipeline, auto-fixing failures.
 */

import { spawn } from "node:child_process";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

const MAX_FIX_ATTEMPTS = 3;

export class CIAgent extends BaseAgent {
  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "ci-agent",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[ci-agent] Creating PR: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[ci-agent] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Create PR
      const prUrl = await this.createPR(workItem);

      // Monitor CI status
      const fixAttempts = (workItem.metadata?.ci_fix_attempts as number) ?? 0;
      const ciPassed = await this.monitorCI(prUrl);

      if (ciPassed) {
        // CI passed - mark as done
        await this.updateWorkStatus(workItem.id, "done");
        await this.publish({
          workItemId: workItem.id,
          eventType: "ci_status",
          targetRole: "pm", // Notify PM of completion
          payload: {
            pr_url: prUrl,
            status: "success",
          },
        });
        console.log(`[ci-agent] PR ready: ${prUrl}`);
      } else if (fixAttempts >= MAX_FIX_ATTEMPTS) {
        // Too many fix attempts - escalate
        await this.updateWorkStatus(
          workItem.id,
          "blocked",
          "CI failures persist after max fix attempts",
        );
        console.log(`[ci-agent] Escalated: ${workItem.title} (max fix attempts)`);
      } else {
        // CI failed - attempt fix
        await this.db.transaction(async (client) => {
          await client.query(
            "UPDATE work_items SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ci_fix_attempts}', $1::jsonb) WHERE id = $2",
            [(fixAttempts + 1).toString(), workItem.id],
          );
        });

        await this.attemptFix(workItem);

        // Re-trigger CI check
        await this.publish({
          workItemId: workItem.id,
          eventType: "work_assigned",
          targetRole: "ci-agent",
          payload: { retry: true },
        });
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  private async createPR(workItem: WorkItem): Promise<string> {
    return new Promise((resolve, reject) => {
      const branchName = `feature/${workItem.id}`;

      // Create PR using gh CLI
      const proc = spawn(
        "gh",
        [
          "pr",
          "create",
          "--title",
          workItem.title,
          "--body",
          `Implements work item: ${workItem.id}\n\n${workItem.description ?? ""}`,
          "--head",
          branchName,
        ],
        {
          cwd: process.cwd(),
          stdio: "pipe",
        },
      );

      let stdout = "";
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          const prUrl = stdout.trim();
          resolve(prUrl);
        } else {
          // PR might already exist
          resolve(`https://github.com/org/repo/pulls`);
        }
      });

      proc.on("error", (err) => {
        console.error("[ci-agent] Failed to create PR:", err.message);
        reject(err);
      });
    });
  }

  private async monitorCI(prUrl: string): Promise<boolean> {
    // TODO: Use gh CLI to monitor CI status
    // gh pr checks <pr-url> --watch

    console.log(`[ci-agent] Monitoring CI for ${prUrl}...`);

    // Placeholder - assume CI passes
    return true;
  }

  private async attemptFix(workItem: WorkItem): Promise<void> {
    // TODO: Read CI logs, identify failure, attempt fix
    console.log(`[ci-agent] Attempting to fix CI failures...`);
  }
}
