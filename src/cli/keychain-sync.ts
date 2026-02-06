/**
 * Sync Claude keychain credentials to auth-profiles
 *
 * Usage: openclaw keychain-sync
 *
 * This reads the Claude OAuth credentials from macOS Keychain
 * (stored by `claude setup-token`) and syncs them to the
 * auth-profiles.json used by OpenClaw.
 */

import {
  readClaudeKeychainCredentials,
  ensureClaudeKeychainToken,
} from "../agents/auth-profiles/keychain.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../agents/auth-profiles/store.js";

export async function keychainSyncCommand(): Promise<void> {
  console.log("[keychain-sync] Reading Claude credentials from keychain...");

  const result = await ensureClaudeKeychainToken();
  if (!result) {
    console.error("[keychain-sync] No Claude credentials found in keychain.");
    console.error("Run `claude setup-token` to authenticate with Anthropic first.");
    process.exit(1);
  }

  console.log(`[keychain-sync] Token valid until: ${new Date(result.expiresAt).toISOString()}`);

  // Update main agent auth-profiles
  const store = ensureAuthProfileStore();
  store.profiles["anthropic:default"] = {
    type: "token",
    provider: "anthropic",
    token: result.accessToken,
    expires: result.expiresAt,
  };
  saveAuthProfileStore(store);

  console.log("[keychain-sync] Updated auth-profiles.json with keychain token");
  console.log(`[keychain-sync] Token prefix: ${result.accessToken.slice(0, 25)}...`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  keychainSyncCommand().catch((err) => {
    console.error("[keychain-sync] Error:", err.message);
    process.exit(1);
  });
}
