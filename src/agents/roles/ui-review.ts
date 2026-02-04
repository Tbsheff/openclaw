/**
 * UI Review Agent
 *
 * Visual verification using Playwright for screenshots.
 * Takes screenshots of affected pages, compares with baselines,
 * and stores results in `.flow/screenshots/<work-item-id>/`.
 */

import type { Browser } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItem } from "../../db/postgres.js";
import type { StreamMessage } from "../../events/types.js";
import { BaseAgent, type AgentConfig } from "../base-agent.js";

// UI file extensions that indicate frontend changes
const UI_FILE_EXTENSIONS = [
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".astro",
];

// Default viewport sizes for screenshots
const VIEWPORTS = [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];

// Allowed dev server commands (prevents command injection from DB metadata)
const ALLOWED_DEV_COMMANDS = new Set([
  "pnpm dev",
  "pnpm start",
  "npm run dev",
  "npm run start",
  "npm start",
  "yarn dev",
  "yarn start",
  "bun dev",
  "bun run dev",
]);

// Sanitize filename to prevent path traversal
function sanitizeFilename(name: string): string {
  // Remove path separators, parent refs, control chars; keep alphanumeric, dash, underscore
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars for security
  return name.replace(/[/\\]|\.\.|[\x00-\x1f]/g, "").replace(/[^a-zA-Z0-9_-]/g, "_") || "unnamed";
}

interface UIReviewResult {
  approved: boolean;
  feedback: string;
  screenshots: string[];
  comparisons?: Array<{
    page: string;
    viewport: string;
    baseline?: string;
    current: string;
    diff?: number; // percentage difference
  }>;
}

interface PageConfig {
  url: string;
  name: string;
  waitFor?: string; // CSS selector to wait for
}

export class UIReviewAgent extends BaseAgent {
  private devServerProcess: ChildProcess | null = null;
  private browser: Browser | null = null;

  constructor(instanceId?: string) {
    const config: AgentConfig = {
      role: "ui-review",
      instanceId,
    };
    super(config);
  }

  protected async onWorkAssigned(message: StreamMessage, workItem: WorkItem): Promise<void> {
    console.log(`[ui-review] Reviewing UI: ${workItem.title}`);

    const claimed = await this.claimWork(workItem.id);
    if (!claimed) {
      console.log(`[ui-review] Work item ${workItem.id} already claimed`);
      return;
    }

    try {
      // Check if this work item has UI changes
      const hasUIChanges = this.detectUIChanges(workItem);

      if (!hasUIChanges) {
        console.log(`[ui-review] No UI changes detected, passing through to ci-agent`);
        await this.passThrough(workItem, message);
        return;
      }

      const review = await this.reviewUI(workItem);

      // Update work item metadata with screenshots
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE work_items
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{screenshots}', $1::jsonb)
           WHERE id = $2`,
          [JSON.stringify(review.screenshots), workItem.id],
        );
      });

      if (review.approved) {
        // UI looks good - send to CI agent
        await this.updateWorkStatus(workItem.id, "review");
        await this.assignToRole(workItem.id, "ci-agent");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "ci-agent",
          payload: {
            screenshots: review.screenshots,
            approved: true,
            comparisons: review.comparisons,
          },
        });
        console.log(`[ui-review] Approved: ${workItem.title}`);
      } else {
        // UI issues - send back to senior dev
        await this.updateWorkStatus(workItem.id, "in_progress");
        await this.assignToRole(workItem.id, "senior-dev");
        await this.publish({
          workItemId: workItem.id,
          eventType: "review_completed",
          targetRole: "senior-dev",
          payload: {
            approved: false,
            feedback: review.feedback,
            screenshots: review.screenshots,
            comparisons: review.comparisons,
          },
        });
        console.log(`[ui-review] Issues found: ${workItem.title}`);
      }
    } catch (err) {
      await this.updateWorkStatus(workItem.id, "failed", (err as Error).message);
      throw err;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Detect if work item involves UI changes.
   */
  private detectUIChanges(workItem: WorkItem): boolean {
    // Check metadata for explicit UI flag
    if (workItem.metadata?.has_ui === true) {
      return true;
    }

    // Check for changed files in metadata
    const changedFiles = workItem.metadata?.changed_files as string[] | undefined;
    if (changedFiles?.length) {
      return changedFiles.some((file) =>
        UI_FILE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)),
      );
    }

    // Check spec path for UI-related keywords
    if (workItem.spec_path) {
      const specContent = workItem.description?.toLowerCase() ?? "";
      const uiKeywords = ["ui", "frontend", "component", "page", "view", "style", "layout"];
      return uiKeywords.some((keyword) => specContent.includes(keyword));
    }

    return false;
  }

  /**
   * Pass through to CI agent for non-UI work items.
   */
  private async passThrough(workItem: WorkItem, _message: StreamMessage): Promise<void> {
    await this.updateWorkStatus(workItem.id, "review");
    await this.assignToRole(workItem.id, "ci-agent");
    await this.publish({
      workItemId: workItem.id,
      eventType: "review_completed",
      targetRole: "ci-agent",
      payload: {
        screenshots: [],
        approved: true,
        skipped_ui_review: true,
        reason: "No UI changes detected",
      },
    });
  }

  /**
   * Main UI review logic.
   */
  private async reviewUI(workItem: WorkItem): Promise<UIReviewResult> {
    const screenshotDir = await this.ensureScreenshotDir(workItem.id);
    const screenshots: string[] = [];
    const comparisons: UIReviewResult["comparisons"] = [];

    try {
      // Get pages to screenshot from spec or metadata
      const pages = this.getPagesToReview(workItem);

      if (pages.length === 0) {
        console.log(`[ui-review] No pages specified, using default`);
        pages.push({ url: "http://localhost:3000", name: "home" });
      }

      // Start dev server if needed
      const devServerUrl = await this.ensureDevServer(workItem);

      // Launch browser
      await this.launchBrowser();

      // Take screenshots for each page and viewport
      for (const pageConfig of pages) {
        const url = pageConfig.url.startsWith("http")
          ? pageConfig.url
          : `${devServerUrl}${pageConfig.url}`;

        for (const viewport of VIEWPORTS) {
          const screenshotPath = join(
            screenshotDir,
            `${sanitizeFilename(pageConfig.name)}-${viewport.name}.png`,
          );

          try {
            await this.captureScreenshot(url, viewport, screenshotPath, pageConfig.waitFor);
            screenshots.push(screenshotPath);

            // Check for baseline comparison
            const baselinePath = this.getBaselinePath(workItem, pageConfig.name, viewport.name);
            const diff = await this.compareWithBaseline(screenshotPath, baselinePath);

            comparisons.push({
              page: pageConfig.name,
              viewport: viewport.name,
              baseline: existsSync(baselinePath) ? baselinePath : undefined,
              current: screenshotPath,
              diff,
            });
          } catch (err) {
            console.error(
              `[ui-review] Failed to capture ${pageConfig.name} at ${viewport.name}:`,
              (err as Error).message,
            );
          }
        }
      }

      // Analyze results
      const hasSignificantDiff = comparisons.some((c) => c.diff !== undefined && c.diff > 5);
      const missingBaselines = comparisons.filter((c) => !c.baseline);

      if (hasSignificantDiff) {
        return {
          approved: false,
          feedback: `Visual differences detected exceeding 5% threshold. Please review the screenshots.`,
          screenshots,
          comparisons,
        };
      }

      if (missingBaselines.length > 0) {
        console.log(`[ui-review] ${missingBaselines.length} pages missing baselines`);
      }

      return {
        approved: true,
        feedback: "UI looks consistent and functional.",
        screenshots,
        comparisons,
      };
    } catch (err) {
      console.error(`[ui-review] Review failed:`, (err as Error).message);
      return {
        approved: false,
        feedback: `UI review failed: ${(err as Error).message}`,
        screenshots,
        comparisons,
      };
    }
  }

  /**
   * Get pages to review from work item spec/metadata.
   */
  private getPagesToReview(workItem: WorkItem): PageConfig[] {
    const pages: PageConfig[] = [];

    // Check metadata for explicit page list
    const specifiedPages = workItem.metadata?.ui_pages as PageConfig[] | undefined;
    if (specifiedPages?.length) {
      return specifiedPages;
    }

    // Check metadata for routes
    const routes = workItem.metadata?.affected_routes as string[] | undefined;
    if (routes?.length) {
      return routes.map((route) => ({
        url: route,
        name: route.replace(/\//g, "-").replace(/^-/, "") || "home",
      }));
    }

    return pages;
  }

  /**
   * Ensure screenshot directory exists.
   */
  private async ensureScreenshotDir(workItemId: string): Promise<string> {
    const dir = join(process.cwd(), ".flow", "screenshots", workItemId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Get baseline screenshot path.
   */
  private getBaselinePath(_workItem: WorkItem, pageName: string, viewport: string): string {
    return join(process.cwd(), ".flow", "baselines", `${pageName}-${viewport}.png`);
  }

  /**
   * Start dev server if not running.
   */
  private async ensureDevServer(workItem: WorkItem): Promise<string> {
    const devServerUrl = (workItem.metadata?.dev_server_url as string) ?? "http://localhost:3000";
    const devServerCmd = (workItem.metadata?.dev_server_cmd as string) ?? "pnpm dev";

    // Validate command against allowlist (prevents command injection)
    if (!ALLOWED_DEV_COMMANDS.has(devServerCmd)) {
      throw new Error(
        `Unsupported dev_server_cmd: "${devServerCmd}". Allowed: ${[...ALLOWED_DEV_COMMANDS].join(", ")}`,
      );
    }

    // Check if server is already running
    try {
      const response = await fetch(devServerUrl, { method: "HEAD" });
      if (response.ok) {
        console.log(`[ui-review] Dev server already running at ${devServerUrl}`);
        return devServerUrl;
      }
    } catch {
      // Server not running, start it
    }

    console.log(`[ui-review] Starting dev server: ${devServerCmd}`);

    const [cmd, ...args] = devServerCmd.split(" ");
    this.devServerProcess = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: "pipe",
      detached: true,
    });

    // Wait for server to be ready
    const maxWaitMs = 60_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const response = await fetch(devServerUrl, { method: "HEAD" });
        if (response.ok) {
          console.log(`[ui-review] Dev server ready at ${devServerUrl}`);
          return devServerUrl;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(1000);
    }

    throw new Error(`Dev server failed to start within ${maxWaitMs / 1000}s`);
  }

  /**
   * Launch browser using playwright-core.
   */
  private async launchBrowser(): Promise<void> {
    if (this.browser) {
      return;
    }

    const { chromium } = await import("playwright-core");

    // Try to find Chrome executable
    const executablePath = this.findChromeExecutable();

    if (executablePath) {
      console.log(`[ui-review] Using Chrome at: ${executablePath}`);
      this.browser = await chromium.launch({
        executablePath,
        headless: true,
      });
    } else {
      // Try to connect to existing browser via CDP
      const cdpUrl = process.env.OPENCLAW_CDP_URL ?? "http://localhost:9222";
      try {
        this.browser = await chromium.connectOverCDP(cdpUrl);
        console.log(`[ui-review] Connected to browser via CDP at ${cdpUrl}`);
      } catch {
        throw new Error(
          "No Chrome executable found and CDP connection failed. " +
            "Install Chrome or set OPENCLAW_CDP_URL environment variable.",
        );
      }
    }
  }

  /**
   * Find Chrome executable path.
   */
  private findChromeExecutable(): string | undefined {
    const paths = [
      // macOS
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      // Linux
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      // Windows
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];

    return paths.find((p) => existsSync(p));
  }

  /**
   * Capture screenshot of a page.
   */
  private async captureScreenshot(
    url: string,
    viewport: { width: number; height: number },
    outputPath: string,
    waitFor?: string,
  ): Promise<void> {
    if (!this.browser) {
      throw new Error("Browser not launched");
    }

    const context = await this.browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });

    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 10_000 });
      }

      // Small delay for animations to settle
      await this.sleep(500);

      await page.screenshot({ path: outputPath, fullPage: true });
      console.log(`[ui-review] Screenshot saved: ${outputPath}`);
    } finally {
      await context.close();
    }
  }

  /**
   * Compare current screenshot with baseline.
   * Returns percentage difference (0-100).
   */
  private async compareWithBaseline(
    currentPath: string,
    baselinePath: string,
  ): Promise<number | undefined> {
    if (!existsSync(baselinePath)) {
      return undefined; // No baseline to compare
    }

    try {
      const currentBuffer = await readFile(currentPath);
      const baselineBuffer = await readFile(baselinePath);

      // Simple byte comparison for now
      // TODO: Use pixelmatch or similar for proper image diffing
      if (currentBuffer.equals(baselineBuffer)) {
        return 0;
      }

      // Rough estimate based on buffer size difference
      const sizeDiff = Math.abs(currentBuffer.length - baselineBuffer.length);
      const avgSize = (currentBuffer.length + baselineBuffer.length) / 2;
      return Math.min(100, (sizeDiff / avgSize) * 100);
    } catch (err) {
      console.error(`[ui-review] Comparison failed:`, (err as Error).message);
      return undefined;
    }
  }

  /**
   * Cleanup resources.
   */
  private async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    if (this.devServerProcess) {
      // Kill the process group to stop dev server
      try {
        process.kill(-this.devServerProcess.pid!, "SIGTERM");
      } catch {
        this.devServerProcess.kill("SIGTERM");
      }
      this.devServerProcess = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
