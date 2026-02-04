/**
 * PostgreSQL client for pipeline state management.
 *
 * Provides typed access to work_items, agent_runs, and pipeline_events tables.
 * Uses connection pooling for efficient database access.
 */

import pg from "pg";

// Re-export pool for direct access when needed
export type { Pool, PoolClient } from "pg";

// =============================================================================
// TYPES
// =============================================================================

export type WorkStatus = "pending" | "in_progress" | "review" | "blocked" | "done" | "failed";
export type WorkType = "project" | "epic" | "task";
export type AgentRole =
  | "pm"
  | "domain-expert"
  | "architect"
  | "cto-review"
  | "senior-dev"
  | "staff-engineer"
  | "code-simplifier"
  | "ui-review"
  | "ci-agent";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkItem {
  id: string;
  type: WorkType;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: WorkStatus;
  priority: number;
  assigned_agent: AgentRole | null;
  assigned_instance: string | null;
  spec_path: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface AgentRun {
  id: string;
  work_item_id: string;
  agent_role: AgentRole;
  agent_instance: string | null;
  status: RunStatus;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  event_id: string | null;
  parent_run_id: string | null;
  metadata: Record<string, unknown>;
}

export interface PipelineEvent {
  id: string;
  stream_id: string;
  event_type: string;
  source_agent: AgentRole | null;
  target_agent: AgentRole | null;
  work_item_id: string | null;
  agent_run_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface AgentHeartbeat {
  id: string;
  agent_role: AgentRole;
  instance_id: string;
  last_heartbeat: Date;
  current_work_item_id: string | null;
  pid: number | null;
  hostname: string | null;
  metadata: Record<string, unknown>;
}

// =============================================================================
// CONNECTION CONFIG
// =============================================================================

export interface PostgresConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
  maxConnections?: number;
  idleTimeout?: number;
}

const DEFAULT_CONFIG: PostgresConfig = {
  // Use connection string to ensure correct port (5433)
  connectionString:
    process.env.PIPELINE_DATABASE_URL ?? "postgresql://openclaw:openclaw@localhost:5433/openclaw",
  maxConnections: 10,
  idleTimeout: 30000,
};

// =============================================================================
// DATABASE CLIENT
// =============================================================================

export class PipelineDB {
  private pool: pg.Pool;
  private closed = false;

  constructor(config: PostgresConfig = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    this.pool = new pg.Pool({
      connectionString: mergedConfig.connectionString,
      host: mergedConfig.host,
      port: mergedConfig.port,
      database: mergedConfig.database,
      user: mergedConfig.user,
      password: mergedConfig.password,
      max: mergedConfig.maxConnections,
      idleTimeoutMillis: mergedConfig.idleTimeout,
    });

    // Handle pool errors
    this.pool.on("error", (err) => {
      console.error("[PipelineDB] Pool error:", err.message);
    });
  }

  /**
   * Test database connectivity.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.pool.query("SELECT 1");
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }

  // ===========================================================================
  // WORK ITEMS
  // ===========================================================================

  /**
   * Create a new work item.
   */
  async createWorkItem(params: {
    type: WorkType;
    title: string;
    description?: string;
    parent_id?: string;
    assigned_agent?: AgentRole;
    spec_path?: string;
    priority?: number;
    metadata?: Record<string, unknown>;
  }): Promise<WorkItem> {
    const result = await this.pool.query<WorkItem>(
      `INSERT INTO work_items (type, title, description, parent_id, assigned_agent, spec_path, priority, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        params.type,
        params.title,
        params.description ?? null,
        params.parent_id ?? null,
        params.assigned_agent ?? null,
        params.spec_path ?? null,
        params.priority ?? 0,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    return result.rows[0];
  }

  /**
   * Get a work item by ID.
   */
  async getWorkItem(id: string): Promise<WorkItem | null> {
    const result = await this.pool.query<WorkItem>("SELECT * FROM work_items WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  /**
   * Get pending work for a specific agent role.
   */
  async getPendingWork(role: AgentRole, limit = 10): Promise<WorkItem[]> {
    const result = await this.pool.query<WorkItem>(
      `SELECT * FROM work_items
       WHERE status = 'pending'
         AND assigned_agent = $1
         AND attempt_count < max_attempts
       ORDER BY priority DESC, created_at ASC
       LIMIT $2`,
      [role, limit],
    );
    return result.rows;
  }

  /**
   * Claim a work item atomically.
   * Returns true if claim was successful, false if item was already claimed.
   */
  async claimWork(itemId: string, role: AgentRole, instanceId: string): Promise<boolean> {
    const result = await this.pool.query<{ claim_work: boolean }>(
      "SELECT claim_work($1, $2, $3) as claim_work",
      [itemId, role, instanceId],
    );
    return result.rows[0]?.claim_work ?? false;
  }

  /**
   * Update work item status.
   */
  async updateWorkStatus(id: string, status: WorkStatus, error?: string): Promise<WorkItem | null> {
    const result = await this.pool.query<WorkItem>(
      `UPDATE work_items
       SET status = $2,
           last_error = $3,
           completed_at = CASE WHEN $2 IN ('done', 'failed') THEN NOW() ELSE completed_at END
       WHERE id = $1
       RETURNING *`,
      [id, status, error ?? null],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Get child work items.
   */
  async getChildWorkItems(parentId: string): Promise<WorkItem[]> {
    const result = await this.pool.query<WorkItem>(
      "SELECT * FROM work_items WHERE parent_id = $1 ORDER BY created_at ASC",
      [parentId],
    );
    return result.rows;
  }

  /**
   * Assign work item to a role for handoff.
   * Updates assigned_agent and resets status to pending so the target role can claim it.
   */
  async assignToRole(itemId: string, targetRole: AgentRole): Promise<WorkItem | null> {
    const result = await this.pool.query<WorkItem>(
      `UPDATE work_items
       SET assigned_agent = $2,
           assigned_instance = NULL,
           status = 'pending'
       WHERE id = $1
       RETURNING *`,
      [itemId, targetRole],
    );
    return result.rows[0] ?? null;
  }

  // ===========================================================================
  // AGENT RUNS
  // ===========================================================================

  /**
   * Create an agent run record.
   */
  async createAgentRun(params: {
    work_item_id: string;
    agent_role: AgentRole;
    agent_instance?: string;
    event_id?: string;
    parent_run_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentRun> {
    const result = await this.pool.query<AgentRun>(
      `INSERT INTO agent_runs (work_item_id, agent_role, agent_instance, event_id, parent_run_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.work_item_id,
        params.agent_role,
        params.agent_instance ?? null,
        params.event_id ?? null,
        params.parent_run_id ?? null,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    return result.rows[0];
  }

  /**
   * Start an agent run.
   */
  async startAgentRun(id: string): Promise<AgentRun | null> {
    const result = await this.pool.query<AgentRun>(
      `UPDATE agent_runs
       SET status = 'running', started_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Complete an agent run.
   */
  async completeAgentRun(
    id: string,
    success: boolean,
    result?: Record<string, unknown>,
    error?: string,
  ): Promise<AgentRun | null> {
    const queryResult = await this.pool.query<AgentRun>(
      `UPDATE agent_runs
       SET status = $2,
           completed_at = NOW(),
           result = $3,
           error = $4
       WHERE id = $1
       RETURNING *`,
      [id, success ? "completed" : "failed", JSON.stringify(result ?? null), error ?? null],
    );
    return queryResult.rows[0] ?? null;
  }

  // ===========================================================================
  // PIPELINE EVENTS
  // ===========================================================================

  /**
   * Log a pipeline event (idempotent by stream_id).
   */
  async logEvent(params: {
    stream_id: string;
    event_type: string;
    source_agent?: AgentRole;
    target_agent?: AgentRole;
    work_item_id?: string;
    agent_run_id?: string;
    payload?: Record<string, unknown>;
  }): Promise<PipelineEvent | null> {
    const result = await this.pool.query<PipelineEvent>(
      `INSERT INTO pipeline_events (stream_id, event_type, source_agent, target_agent, work_item_id, agent_run_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stream_id) DO NOTHING
       RETURNING *`,
      [
        params.stream_id,
        params.event_type,
        params.source_agent ?? null,
        params.target_agent ?? null,
        params.work_item_id ?? null,
        params.agent_run_id ?? null,
        JSON.stringify(params.payload ?? {}),
      ],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Get recent events.
   */
  async getRecentEvents(limit = 100): Promise<PipelineEvent[]> {
    const result = await this.pool.query<PipelineEvent>(
      "SELECT * FROM pipeline_events ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return result.rows;
  }

  /**
   * Get agent runs for a work item.
   */
  async getAgentRuns(workItemId: string): Promise<AgentRun[]> {
    const result = await this.pool.query<AgentRun>(
      "SELECT * FROM agent_runs WHERE work_item_id = $1 ORDER BY queued_at DESC",
      [workItemId],
    );
    return result.rows;
  }

  /**
   * Get recent top-level work items.
   */
  async getRecentWorkItems(limit = 20): Promise<WorkItem[]> {
    const result = await this.pool.query<WorkItem>(
      `SELECT * FROM work_items
       WHERE parent_id IS NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /**
   * Get all heartbeats (for status display).
   */
  async getAllHeartbeats(): Promise<AgentHeartbeat[]> {
    const result = await this.pool.query<AgentHeartbeat>(
      "SELECT * FROM agent_heartbeats ORDER BY agent_role, instance_id",
    );
    return result.rows;
  }

  // ===========================================================================
  // HEARTBEATS
  // ===========================================================================

  /**
   * Update agent heartbeat.
   */
  async updateHeartbeat(params: {
    agent_role: AgentRole;
    instance_id: string;
    current_work_item_id?: string;
    pid?: number;
    hostname?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_heartbeats (agent_role, instance_id, last_heartbeat, current_work_item_id, pid, hostname)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       ON CONFLICT (agent_role, instance_id)
       DO UPDATE SET
         last_heartbeat = NOW(),
         current_work_item_id = $3,
         pid = $4,
         hostname = $5`,
      [
        params.agent_role,
        params.instance_id,
        params.current_work_item_id ?? null,
        params.pid ?? null,
        params.hostname ?? null,
      ],
    );
  }

  /**
   * Get stale heartbeats (agents that haven't checked in recently).
   */
  async getStaleHeartbeats(staleThresholdMs: number): Promise<AgentHeartbeat[]> {
    const result = await this.pool.query<AgentHeartbeat>(
      `SELECT * FROM agent_heartbeats
       WHERE last_heartbeat < NOW() - INTERVAL '1 millisecond' * $1`,
      [staleThresholdMs],
    );
    return result.rows;
  }

  /**
   * Remove heartbeat for a terminated agent.
   */
  async removeHeartbeat(role: AgentRole, instanceId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM agent_heartbeats WHERE agent_role = $1 AND instance_id = $2",
      [role, instanceId],
    );
  }

  // ===========================================================================
  // TRANSACTIONS
  // ===========================================================================

  /**
   * Execute a function within a transaction.
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let defaultInstance: PipelineDB | null = null;

/**
 * Get or create the default PipelineDB instance.
 */
export function getDB(config?: PostgresConfig): PipelineDB {
  if (!defaultInstance) {
    defaultInstance = new PipelineDB(config);
  }
  return defaultInstance;
}

/**
 * Close the default instance.
 */
export async function closeDB(): Promise<void> {
  if (defaultInstance) {
    await defaultInstance.close();
    defaultInstance = null;
  }
}
