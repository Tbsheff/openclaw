#!/usr/bin/env tsx
/**
 * Database migration runner for OpenClaw pipeline.
 *
 * Usage:
 *   pnpm db:migrate          # Run all migrations
 *   pnpm db:migrate --reset  # Drop and recreate database
 *   pnpm db:status           # Check connection status
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "../src/db/migrations");

interface Config {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function getConfig(): Config {
  return {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: parseInt(process.env.POSTGRES_PORT ?? "5433", 10),
    database: process.env.POSTGRES_DB ?? "openclaw",
    user: process.env.POSTGRES_USER ?? "openclaw",
    password: process.env.POSTGRES_PASSWORD ?? "openclaw",
  };
}

async function checkConnection(config: Config): Promise<boolean> {
  const client = new pg.Client(config);
  try {
    await client.connect();
    const result = await client.query("SELECT version()");
    console.log("Connected to:", result.rows[0].version);
    return true;
  } catch (err) {
    console.error("Connection failed:", (err as Error).message);
    return false;
  } finally {
    await client.end();
  }
}

async function runMigrations(config: Config): Promise<void> {
  const client = new pg.Client(config);

  try {
    await client.connect();
    console.log("Connected to database");

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get applied migrations
    const { rows: applied } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY id",
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Get migration files
    const files = await readdir(MIGRATIONS_DIR);
    const sqlFiles = files.filter((f) => f.endsWith(".sql")).toSorted((a, b) => a.localeCompare(b));

    // Run pending migrations
    for (const file of sqlFiles) {
      if (appliedSet.has(file)) {
        console.log(`  [skip] ${file} (already applied)`);
        continue;
      }

      console.log(`  [run] ${file}`);
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`  [ok] ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  [fail] ${file}:`, (err as Error).message);
        throw err;
      }
    }

    console.log("Migrations complete");
  } finally {
    await client.end();
  }
}

// Strict identifier pattern: alphanumeric + underscore only (prevents SQL injection)
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(name: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: must match ${IDENTIFIER_PATTERN} (got "${name}")`);
  }
}

async function resetDatabase(config: Config): Promise<void> {
  // Validate identifiers before using in SQL
  validateIdentifier(config.database, "database name");
  validateIdentifier(config.user, "user name");

  // Connect to postgres database to drop/create the target
  const adminConfig = { ...config, database: "postgres" };
  const adminClient = new pg.Client(adminConfig);

  try {
    await adminClient.connect();
    console.log("Connected to postgres database");

    // Drop connections to target database
    await adminClient.query(
      `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `,
      [config.database],
    );

    // Drop and recreate (identifiers validated above)
    await adminClient.query(`DROP DATABASE IF EXISTS ${config.database}`);
    console.log(`Dropped database: ${config.database}`);

    await adminClient.query(`CREATE DATABASE ${config.database} OWNER ${config.user}`);
    console.log(`Created database: ${config.database}`);
  } finally {
    await adminClient.end();
  }

  // Run migrations on fresh database
  await runMigrations(config);
}

async function main() {
  const argsSet = new Set(process.argv.slice(2));
  const config = getConfig();

  if (argsSet.has("--status") || argsSet.has("status")) {
    const connected = await checkConnection(config);
    process.exit(connected ? 0 : 1);
  }

  if (argsSet.has("--reset") || argsSet.has("reset")) {
    console.log("Resetting database...");
    await resetDatabase(config);
    return;
  }

  console.log("Running migrations...");
  await runMigrations(config);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
