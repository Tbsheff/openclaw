/**
 * Worker Model Configuration
 *
 * Allows per-worker model configuration for orchestrator agents.
 * Reads from ~/.openclaw/orchestrator/workers.yaml or uses defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentRole } from "../events/types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface WorkerModelConfig {
  /** Model ID (e.g., "anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.3-codex") */
  model: string;
  /** Max tokens for completion */
  maxTokens?: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** Thinking/reasoning level */
  thinking?: "off" | "low" | "medium" | "high";
}

export interface OrchestratorWorkersConfig {
  /** Default model for all workers if not specified per-role */
  default: WorkerModelConfig;
  /** Per-role model overrides */
  roles?: Partial<Record<AgentRole, WorkerModelConfig>>;
}

// =============================================================================
// DEFAULTS
// =============================================================================

const DEFAULT_CONFIG: OrchestratorWorkersConfig = {
  default: {
    model: "openai-codex/gpt-5.3-codex",
    maxTokens: 8192,
    temperature: 0.7,
    thinking: "medium",
  },
  roles: {
    // Planning roles - need strong reasoning
    pm: {
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
    },
    "domain-expert": {
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
    },
    architect: {
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
    },
    // Review roles - need careful analysis
    "cto-review": {
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
    },
    "staff-engineer": {
      model: "anthropic/claude-sonnet-4-5",
      thinking: "high",
    },
    // Implementation roles - Codex for code
    "senior-dev": {
      model: "openai-codex/gpt-5.3-codex",
      maxTokens: 16384,
    },
    "code-simplifier": {
      model: "openai-codex/gpt-5.3-codex",
    },
    // CI/UI - lighter weight
    "ci-agent": {
      model: "openai-codex/gpt-5.3-codex",
    },
    "ui-review": {
      model: "anthropic/claude-haiku-4-5",
    },
  },
};

// =============================================================================
// CONFIG LOADING
// =============================================================================

let cachedConfig: OrchestratorWorkersConfig | null = null;

/**
 * Get the config file path
 */
function getConfigPath(): string {
  return join(homedir(), ".openclaw", "orchestrator", "workers.yaml");
}

/**
 * Load worker config from file or use defaults
 */
export function loadWorkerConfig(): OrchestratorWorkersConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as Partial<OrchestratorWorkersConfig>;

      // Merge with defaults
      cachedConfig = {
        default: { ...DEFAULT_CONFIG.default, ...parsed.default },
        roles: { ...DEFAULT_CONFIG.roles, ...parsed.roles },
      };

      console.log(`[worker-config] Loaded config from ${configPath}`);
    } catch (err) {
      console.warn(`[worker-config] Failed to load ${configPath}:`, (err as Error).message);
      cachedConfig = DEFAULT_CONFIG;
    }
  } else {
    cachedConfig = DEFAULT_CONFIG;
  }

  return cachedConfig;
}

/**
 * Get model config for a specific worker role
 */
export function getWorkerModelConfig(role: AgentRole): WorkerModelConfig {
  const config = loadWorkerConfig();
  const roleConfig = config.roles?.[role];

  if (roleConfig) {
    // Merge role-specific with defaults
    return {
      ...config.default,
      ...roleConfig,
    };
  }

  return config.default;
}

/**
 * Clear cached config (for testing or hot-reload)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
