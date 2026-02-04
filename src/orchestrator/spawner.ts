/**
 * Agent Spawner
 *
 * Manages lifecycle of agent processes (spawn/stop).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { AgentRole } from "../events/types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface AgentProcess {
  role: AgentRole;
  instanceId: string;
  process: ChildProcess;
  startedAt: Date;
  pid: number;
}

export interface SpawnerConfig {
  agentRunnerPath?: string;
  nodeArgs?: string[];
  devMode?: boolean; // Use tsx instead of node
}

// =============================================================================
// SPAWNER
// =============================================================================

export class Spawner extends EventEmitter {
  private agents: Map<string, AgentProcess> = new Map();
  private readonly agentRunnerPath: string;
  private readonly nodeArgs: string[];
  private readonly devMode: boolean;

  constructor(config: SpawnerConfig = {}) {
    super();
    this.devMode = config.devMode ?? process.env.NODE_ENV !== "production";
    this.agentRunnerPath =
      config.agentRunnerPath ??
      (this.devMode
        ? join(process.cwd(), "src/agents/agent-runner.ts")
        : join(process.cwd(), "dist/agents/agent-runner.js"));
    this.nodeArgs = config.nodeArgs ?? [];
  }

  /**
   * Spawn a new agent process.
   */
  spawn(role: AgentRole, instanceId?: string): AgentProcess {
    const id = instanceId ?? `${role}-${Date.now()}`;

    if (this.agents.has(id)) {
      throw new Error(`Agent ${id} already running`);
    }

    console.log(`[spawner] Spawning ${role} agent: ${id}`);

    // Use tsx in dev mode for TypeScript support
    const command = this.devMode ? "node" : "node";
    const args = this.devMode
      ? ["--import", "tsx", ...this.nodeArgs, this.agentRunnerPath, role]
      : [...this.nodeArgs, this.agentRunnerPath, role];

    const child = spawn(command, args, {
      env: {
        ...process.env,
        AGENT_INSTANCE_ID: id,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const agent: AgentProcess = {
      role,
      instanceId: id,
      process: child,
      startedAt: new Date(),
      pid: child.pid!,
    };

    // Forward stdout/stderr
    child.stdout?.on("data", (data) => {
      process.stdout.write(`[${id}] ${data}`);
    });

    child.stderr?.on("data", (data) => {
      process.stderr.write(`[${id}] ${data}`);
    });

    // Handle exit
    child.on("exit", (code, signal) => {
      console.log(`[spawner] Agent ${id} exited: code=${code}, signal=${signal}`);
      this.agents.delete(id);
      this.emit("exit", { role, instanceId: id, code, signal });
    });

    child.on("error", (err) => {
      console.error(`[spawner] Agent ${id} error:`, err.message);
      this.emit("error", { role, instanceId: id, error: err });
    });

    this.agents.set(id, agent);
    this.emit("spawn", agent);

    return agent;
  }

  /**
   * Stop an agent process gracefully.
   */
  async stop(instanceId: string, timeoutMs = 5000): Promise<void> {
    const agent = this.agents.get(instanceId);
    if (!agent) {
      return;
    }

    console.log(`[spawner] Stopping agent: ${instanceId}`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill after timeout
        console.log(`[spawner] Force killing agent: ${instanceId}`);
        agent.process.kill("SIGKILL");
        resolve();
      }, timeoutMs);

      agent.process.once("exit", () => {
        clearTimeout(timeout);
        this.agents.delete(instanceId);
        resolve();
      });

      // Send SIGTERM for graceful shutdown
      agent.process.kill("SIGTERM");
    });
  }

  /**
   * Stop all agent processes.
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    const ids = Array.from(this.agents.keys());
    await Promise.all(ids.map((id) => this.stop(id, timeoutMs)));
  }

  /**
   * Get running agents.
   */
  getRunning(): AgentProcess[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by role.
   */
  getByRole(role: AgentRole): AgentProcess[] {
    return this.getRunning().filter((a) => a.role === role);
  }

  /**
   * Count running agents by role.
   */
  countByRole(role: AgentRole): number {
    return this.getByRole(role).length;
  }

  /**
   * Check if an agent is running.
   */
  isRunning(instanceId: string): boolean {
    return this.agents.has(instanceId);
  }
}
