/**
 * Pipeline E2E Tests
 *
 * End-to-end tests for the multi-agent pipeline CLI commands.
 * Requires PostgreSQL and Redis to be running.
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Skip if not in e2e mode
const isE2E = process.env.PIPELINE_E2E === "1";

describe.skipIf(!isE2E)("Pipeline E2E", () => {
  const PID_FILE = join(homedir(), ".openclaw", "orchestrator.pid");

  function run(cmd: string): string {
    return execSync(`pnpm openclaw ${cmd}`, {
      encoding: "utf-8",
      timeout: 30000,
    });
  }

  function runJson<T>(cmd: string): T {
    const output = run(`${cmd} --json`);
    return JSON.parse(output) as T;
  }

  beforeAll(async () => {
    // Clean up any existing orchestrator
    try {
      run("orchestrator stop --force");
    } catch {
      // Ignore if not running
    }

    // Clean up PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  });

  afterAll(async () => {
    // Stop orchestrator
    try {
      run("orchestrator stop --force");
    } catch {
      // Ignore
    }
  });

  describe("orchestrator commands", () => {
    it("should report not running when stopped", () => {
      const result = runJson<{ running: boolean }>("orchestrator status");
      expect(result.running).toBe(false);
    });

    it("should start orchestrator", async () => {
      const result = runJson<{ success: boolean; pid: number }>("orchestrator start");
      expect(result.success).toBe(true);
      expect(result.pid).toBeGreaterThan(0);

      // Wait for startup
      await new Promise((r) => setTimeout(r, 3000));
    });

    it("should report running after start", () => {
      const result = runJson<{ running: boolean; pid: number }>("orchestrator status");
      expect(result.running).toBe(true);
      expect(result.pid).toBeGreaterThan(0);
    });

    it("should stop orchestrator", () => {
      const result = runJson<{ success: boolean }>("orchestrator stop");
      expect(result.success).toBe(true);
    });

    it("should report not running after stop", () => {
      const result = runJson<{ running: boolean }>("orchestrator status");
      expect(result.running).toBe(false);
    });
  });

  describe("pipeline commands", () => {
    beforeAll(async () => {
      // Start orchestrator for pipeline tests
      run("orchestrator start");
      await new Promise((r) => setTimeout(r, 3000));
    });

    afterAll(() => {
      run("orchestrator stop --force");
    });

    it("should submit a goal", () => {
      const result = runJson<{
        success: boolean;
        workItemId: string;
        status: string;
      }>("pipeline submit 'Test goal for e2e testing'");

      expect(result.success).toBe(true);
      expect(result.workItemId).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should list work items", () => {
      const result = runJson<{ items: Array<{ id: string }> }>("pipeline status");
      expect(result.items).toBeDefined();
      expect(result.items.length).toBeGreaterThan(0);
    });

    it("should get specific work item status", () => {
      // First submit a goal
      const submit = runJson<{ workItemId: string }>("pipeline submit 'Another test goal'");

      // Then check its status
      const result = runJson<{ workItem: { id: string; title: string } }>(
        `pipeline status ${submit.workItemId}`,
      );

      expect(result.workItem).toBeDefined();
      expect(result.workItem.id).toBe(submit.workItemId);
    });

    it("should support priority option", () => {
      const result = runJson<{
        success: boolean;
        workItemId: string;
      }>("pipeline submit 'High priority goal' --priority 10");

      expect(result.success).toBe(true);
    });

    it("should support type option", () => {
      const result = runJson<{
        success: boolean;
        workItemId: string;
      }>("pipeline submit 'Quick task' --type task");

      expect(result.success).toBe(true);
    });
  });
});
