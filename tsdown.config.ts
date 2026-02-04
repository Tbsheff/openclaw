import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    dts: true,
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/agents/agent-runner.ts",
    outDir: "dist/agents",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/orchestrator/index.ts",
    outDir: "dist/orchestrator",
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
