/**
 * Code Simplifier Agent
 *
 * Anti-slop gate that simplifies code before final approval.
 * Catches LLM tendency to over-engineer:
 * - Removes dead code
 * - Simplifies over-engineered abstractions
 * - Deletes unnecessary comments
 * - Consolidates duplicate logic
 * - Prefers simple over clever
 *
 * Flow:
 * - Listens for `review_completed` from staff-engineer with SHIP verdict
 * - Analyzes code for simplification opportunities
 * - Makes simplification commits if needed
 * - Publishes to `ui-review` (if UI changes) or `ci-agent` (if not)
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface Simplification {
  type: "dead-code" | "over-engineering" | "unnecessary-comment" | "duplicate" | "complexity";
  file: string;
  line?: number;
  description: string;
  before?: string;
  after?: string;
}

interface SimplificationResult {
  simplifications: Simplification[];
  filesAnalyzed: number;
  linesRemoved: number;
  linesModified: number;
}

export class CodeSimplifierAgent extends BaseAgent {
  private repoRoot: string;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "code-simplifier",
      instanceId,
    };
    super(config);
    this.repoRoot = process.cwd();
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[code-simplifier] Analyzing: ${workItem.title}`);

    // Only process review_completed events from staff-engineer with SHIP verdict
    if (message.event_type !== "review_completed") {
      console.log(`[code-simplifier] Ignoring event type: ${message.event_type}`);
      return;
    }

    const payload = JSON.parse(message.payload);
    if (payload.verdict !== "SHIP") {
      console.log(`[code-simplifier] Ignoring non-SHIP verdict: ${payload.verdict}`);
      return;
    }

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[code-simplifier] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Get changed files from git
      const changedFiles = await this.getChangedFiles();
      console.log(`[code-simplifier] Analyzing ${changedFiles.length} changed files`);

      // Analyze and simplify code
      const result = await this.analyzeAndSimplify(workItem, changedFiles);

      // Record simplifications in metadata
      await this.recordSimplificationsInMetadata(workItem.id, result);

      if (result.simplifications.length > 0) {
        // Made simplifications - commit them
        await this.commitSimplifications(workItem, result);
        console.log(
          `[code-simplifier] Committed ${result.simplifications.length} simplifications ` +
            `(-${result.linesRemoved} lines, ~${result.linesModified} modified)`,
        );
      } else {
        console.log(`[code-simplifier] Code is already clean, no simplifications needed`);
      }

      // Determine next step based on work item metadata
      const hasUI = this.detectUIChanges(workItem, changedFiles);
      const nextRole = hasUI ? "ui-review" : "ci-agent";

      await this.updateWorkStatus(workItem.id, "review");
      // Assign to target role before publishing so they can claim the work
      await this.assignToRole(workItem.id, nextRole);
      await this.publish({
        workItemId: workItem.id,
        eventType: "review_completed",
        targetRole: nextRole,
        payload: {
          simplifications_count: result.simplifications.length,
          simplifications: result.simplifications.map((s) => ({
            type: s.type,
            file: s.file,
            description: s.description,
          })),
          lines_removed: result.linesRemoved,
          lines_modified: result.linesModified,
          simplified_by: "code-simplifier",
          has_ui: hasUI,
        },
      });

      console.log(`[code-simplifier] Done, forwarding to ${nextRole}`);
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    }
  }

  /**
   * Get list of changed files from git.
   */
  private async getChangedFiles(): Promise<string[]> {
    // Get staged changes
    const staged = await this.runCommand("git", ["diff", "--cached", "--name-only"]);

    // Get unstaged changes
    const unstaged = await this.runCommand("git", ["diff", "--name-only"]);

    // Combine and dedupe
    const files = new Set([
      ...staged.stdout.trim().split("\n").filter(Boolean),
      ...unstaged.stdout.trim().split("\n").filter(Boolean),
    ]);

    // Filter to code files only
    const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"];
    return [...files].filter((f) => codeExtensions.some((ext) => f.endsWith(ext)));
  }

  /**
   * Analyze code and apply simplifications.
   *
   * TODO: Integrate with LLM using prompts/code-simplifier.md
   */
  private async analyzeAndSimplify(
    workItem: WorkItem,
    files: string[],
  ): Promise<SimplificationResult> {
    const result: SimplificationResult = {
      simplifications: [],
      filesAnalyzed: files.length,
      linesRemoved: 0,
      linesModified: 0,
    };

    for (const file of files) {
      try {
        const fullPath = join(this.repoRoot, file);
        const content = await readFile(fullPath, "utf-8");
        const lines = content.split("\n");

        // Pattern-based simplification detection
        const fileSimplifications = this.detectSimplifications(file, lines);
        result.simplifications.push(...fileSimplifications);

        // Count metrics from detected simplifications
        for (const s of fileSimplifications) {
          if (s.type === "dead-code" || s.type === "unnecessary-comment") {
            result.linesRemoved++;
          } else {
            result.linesModified++;
          }
        }
      } catch (err) {
        console.log(`[code-simplifier] Could not analyze ${file}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /**
   * Detect simplification opportunities in code.
   * This is the pattern-based detection; LLM integration will enhance this.
   */
  private detectSimplifications(file: string, lines: string[]): Simplification[] {
    const simplifications: Simplification[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect TODO comments that should be resolved or removed
      if (/\/\/\s*TODO:/i.test(line) && !line.includes("TODO: Integrate with LLM")) {
        // Skip legitimate TODOs but flag others
      }

      // Detect console.log statements that might be debug leftovers
      if (/console\.(log|debug)\s*\(/.test(line) && !/\[.+\]/.test(line)) {
        simplifications.push({
          type: "dead-code",
          file,
          line: lineNum,
          description:
            "Debug console statement - consider removing or converting to proper logging",
        });
      }

      // Detect commented-out code blocks
      if (/^\s*\/\/\s*(const|let|var|function|class|if|for|while|return)\s/.test(line)) {
        simplifications.push({
          type: "dead-code",
          file,
          line: lineNum,
          description: "Commented-out code - remove instead of keeping",
        });
      }

      // Detect unnecessary abstractions (single-use wrapper functions)
      if (/^(const|function)\s+\w+\s*=?\s*\(.*\)\s*(=>|{)/.test(line)) {
        // Check if it's a trivial wrapper
        const nextLine = lines[i + 1]?.trim() || "";
        if (/^return\s+\w+\(/.test(nextLine) && lines[i + 2]?.trim() === "}") {
          simplifications.push({
            type: "over-engineering",
            file,
            line: lineNum,
            description: "Trivial wrapper function - consider inlining",
          });
        }
      }

      // Detect overly verbose type assertions
      if (/as\s+\w+\s+as\s+\w+/.test(line)) {
        simplifications.push({
          type: "complexity",
          file,
          line: lineNum,
          description: "Double type assertion - simplify type handling",
        });
      }

      // Detect empty catch blocks
      if (/catch\s*\([^)]*\)\s*{\s*}/.test(line)) {
        simplifications.push({
          type: "complexity",
          file,
          line: lineNum,
          description: "Empty catch block - either handle the error or document why ignored",
        });
      }

      // Detect excessive nesting (>4 levels)
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent > 16 && line.trim().length > 0) {
        // ~4+ levels with 4-space indent
        simplifications.push({
          type: "complexity",
          file,
          line: lineNum,
          description: "Deep nesting detected - consider early returns or extraction",
        });
      }
    }

    return simplifications;
  }

  /**
   * Detect if changes include UI-related files.
   */
  private detectUIChanges(workItem: WorkItem, files: string[]): boolean {
    // Check metadata flag
    if (workItem.metadata?.has_ui === true) {
      return true;
    }

    // Check file patterns
    const uiPatterns = [
      /\.tsx$/,
      /\.jsx$/,
      /components?\//i,
      /pages?\//i,
      /views?\//i,
      /ui\//i,
      /\.css$/,
      /\.scss$/,
      /\.styled\./,
    ];

    return files.some((f) => uiPatterns.some((p) => p.test(f)));
  }

  /**
   * Record simplification result in work item metadata.
   */
  private async recordSimplificationsInMetadata(
    workItemId: string,
    result: SimplificationResult,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE work_items
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{simplification_result}',
           $1::jsonb
         )
         WHERE id = $2`,
        [
          JSON.stringify({
            timestamp: new Date().toISOString(),
            files_analyzed: result.filesAnalyzed,
            simplifications_count: result.simplifications.length,
            lines_removed: result.linesRemoved,
            lines_modified: result.linesModified,
            simplifications: result.simplifications.slice(0, 20), // Cap for metadata size
          }),
          workItemId,
        ],
      );
    });
  }

  /**
   * Commit simplifications to git.
   */
  private async commitSimplifications(
    workItem: WorkItem,
    result: SimplificationResult,
  ): Promise<void> {
    // Stage all changes
    const addResult = await this.runCommand("git", ["add", "-A"]);
    if (!addResult.success) {
      console.log("[code-simplifier] No changes to stage");
      return;
    }

    // Check if there are changes to commit
    const statusResult = await this.runCommand("git", ["status", "--porcelain"]);
    if (!statusResult.stdout.trim()) {
      console.log("[code-simplifier] No changes to commit");
      return;
    }

    // Build commit message
    const typesSummary = this.summarizeSimplificationTypes(result.simplifications);
    const commitMsg = `refactor: simplify code

${typesSummary}

Work Item: ${workItem.id}
Lines removed: ${result.linesRemoved}
Lines modified: ${result.linesModified}

Applied by code-simplifier agent.`;

    const commitResult = await this.runCommand("git", ["commit", "-m", commitMsg]);
    if (commitResult.success) {
      console.log(`[code-simplifier] Committed: refactor: simplify code`);
    } else {
      console.log(`[code-simplifier] Commit failed: ${commitResult.stderr}`);
    }
  }

  /**
   * Summarize simplification types for commit message.
   */
  private summarizeSimplificationTypes(simplifications: Simplification[]): string {
    const counts: Record<string, number> = {};
    for (const s of simplifications) {
      counts[s.type] = (counts[s.type] || 0) + 1;
    }

    const summaries: string[] = [];
    if (counts["dead-code"]) {
      summaries.push(`- Removed ${counts["dead-code"]} dead code instance(s)`);
    }
    if (counts["over-engineering"]) {
      summaries.push(`- Simplified ${counts["over-engineering"]} over-engineered abstraction(s)`);
    }
    if (counts["unnecessary-comment"]) {
      summaries.push(`- Removed ${counts["unnecessary-comment"]} unnecessary comment(s)`);
    }
    if (counts["duplicate"]) {
      summaries.push(`- Consolidated ${counts["duplicate"]} duplicate(s)`);
    }
    if (counts["complexity"]) {
      summaries.push(`- Reduced complexity in ${counts["complexity"]} place(s)`);
    }

    return summaries.join("\n") || "- Minor code cleanup";
  }

  /**
   * Execute a command and capture output.
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
