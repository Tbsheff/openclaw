#!/usr/bin/env node
/**
 * Agent runner - spawns a specific agent by role.
 *
 * Usage:
 *   node dist/agent-runner.js <role>
 *   node dist/agent-runner.js pm
 *   node dist/agent-runner.js senior-dev
 *
 * Environment variables:
 *   AGENT_INSTANCE_ID - Unique instance ID (auto-generated if not set)
 *   REDIS_HOST - Redis host (default: localhost)
 *   REDIS_PORT - Redis port (default: 6380)
 *   POSTGRES_HOST - PostgreSQL host (default: localhost)
 *   POSTGRES_PORT - PostgreSQL port (default: 5433)
 */

import type { AgentRole } from "../events/types.js";
import { ArchitectAgent } from "./roles/architect.js";
import { CIAgent } from "./roles/ci-agent.js";
import { CodeSimplifierAgent } from "./roles/code-simplifier.js";
import { CTOReviewAgent } from "./roles/cto-review.js";
import { DomainExpertAgent } from "./roles/domain-expert.js";
import { PMAgent } from "./roles/pm.js";
import { SeniorDevAgent } from "./roles/senior-dev.js";
import { StaffEngineerAgent } from "./roles/staff-engineer.js";
import { UIReviewAgent } from "./roles/ui-review.js";

const AGENT_MAP: Record<AgentRole, new (instanceId?: string) => { start(): Promise<void> }> = {
  pm: PMAgent,
  "domain-expert": DomainExpertAgent,
  architect: ArchitectAgent,
  "cto-review": CTOReviewAgent,
  "senior-dev": SeniorDevAgent,
  "staff-engineer": StaffEngineerAgent,
  "code-simplifier": CodeSimplifierAgent,
  "ui-review": UIReviewAgent,
  "ci-agent": CIAgent,
};

async function main() {
  const role = process.argv[2] as AgentRole;

  if (!role || !AGENT_MAP[role]) {
    console.error("Usage: agent-runner <role>");
    console.error("Available roles:", Object.keys(AGENT_MAP).join(", "));
    process.exit(1);
  }

  const AgentClass = AGENT_MAP[role];
  const instanceId = process.env.AGENT_INSTANCE_ID;

  console.log(`[agent-runner] Starting ${role} agent...`);

  const agent = new AgentClass(instanceId);
  await agent.start();
}

main().catch((err) => {
  console.error("[agent-runner] Fatal error:", err);
  process.exit(1);
});
