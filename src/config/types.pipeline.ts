/**
 * Pipeline configuration types.
 */

export interface PipelineConfig {
  /**
   * Auto-start pipeline infrastructure (Docker containers) and orchestrator when gateway starts.
   * Requires Docker to be installed and running.
   */
  autoStart?: boolean;

  /**
   * Path to docker-compose file for pipeline infrastructure.
   * Default: docker-compose.pipeline.yml in repo root.
   */
  composeFile?: string;

  /**
   * Database connection string (PostgreSQL).
   * Default: postgresql://openclaw:openclaw@localhost:5433/openclaw
   */
  databaseUrl?: string;

  /**
   * Redis host for event streaming.
   * Default: localhost
   */
  redisHost?: string;

  /**
   * Redis port for event streaming.
   * Default: 6380
   */
  redisPort?: number;
}
