/**
 * macOS Keychain integration for Claude CLI OAuth tokens
 *
 * Reads/refreshes Claude Code's OAuth credentials stored via `claude setup-token`.
 * The keychain entry is:
 * - Service: "Claude Code-credentials"
 * - Account: current username
 * - Data: JSON with claudeAiOauth.{accessToken, refreshToken, expiresAt, ...}
 */

import { exec } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { log } from "./constants.js";

const execAsync = promisify(exec);

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const ANTHROPIC_OAUTH_REFRESH_URL = "https://console.anthropic.com/oauth/refresh";

export interface ClaudeKeychainCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface KeychainPayload {
  claudeAiOauth?: ClaudeKeychainCredentials;
  mcpOAuth?: Record<string, unknown>;
}

/**
 * Read Claude OAuth credentials from macOS Keychain
 */
export async function readClaudeKeychainCredentials(): Promise<ClaudeKeychainCredentials | null> {
  if (os.platform() !== "darwin") {
    log.debug("Keychain access only supported on macOS");
    return null;
  }

  const username = os.userInfo().username;

  try {
    const { stdout } = await execAsync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${username}" -w 2>/dev/null`,
      { timeout: 5000 },
    );

    const payload: KeychainPayload = JSON.parse(stdout.trim());
    if (!payload.claudeAiOauth?.accessToken) {
      log.debug("No claudeAiOauth in keychain payload");
      return null;
    }

    return payload.claudeAiOauth;
  } catch (error) {
    log.debug("Failed to read Claude keychain credentials", { error });
    return null;
  }
}

/**
 * Write Claude OAuth credentials to macOS Keychain
 */
async function writeClaudeKeychainCredentials(
  credentials: ClaudeKeychainCredentials,
): Promise<boolean> {
  if (os.platform() !== "darwin") {
    return false;
  }

  const username = os.userInfo().username;

  try {
    // Read existing payload to preserve mcpOAuth
    let existingPayload: KeychainPayload = {};
    try {
      const { stdout } = await execAsync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${username}" -w 2>/dev/null`,
        { timeout: 5000 },
      );
      existingPayload = JSON.parse(stdout.trim());
    } catch {
      // No existing entry, that's fine
    }

    const newPayload: KeychainPayload = {
      ...existingPayload,
      claudeAiOauth: credentials,
    };

    const jsonPayload = JSON.stringify(newPayload);

    // Delete existing entry first
    await execAsync(
      `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${username}" 2>/dev/null || true`,
      { timeout: 5000 },
    );

    // Add new entry
    await execAsync(
      `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${username}" -w '${jsonPayload.replace(/'/g, "'\"'\"'")}'`,
      { timeout: 5000 },
    );

    log.info("Updated Claude keychain credentials", {
      expiresAt: new Date(credentials.expiresAt).toISOString(),
    });

    return true;
  } catch (error) {
    log.error("Failed to write Claude keychain credentials", { error });
    return false;
  }
}

/**
 * Refresh Claude OAuth token using the refresh token
 */
async function refreshClaudeOAuthToken(
  refreshToken: string,
): Promise<ClaudeKeychainCredentials | null> {
  try {
    const response = await fetch(ANTHROPIC_OAUTH_REFRESH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error("Claude OAuth refresh failed", { status: response.status, error });
      return null;
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: data.scope?.split(" ") || [],
      subscriptionType: data.subscription_type,
      rateLimitTier: data.rate_limit_tier,
    };
  } catch (error) {
    log.error("Claude OAuth refresh error", { error });
    return null;
  }
}

/**
 * Get valid Claude OAuth token, refreshing if needed
 *
 * This is the main entry point for getting Anthropic credentials from the keychain.
 * It handles:
 * 1. Reading from keychain
 * 2. Checking expiration
 * 3. Refreshing if needed
 * 4. Updating keychain with new credentials
 */
export async function ensureClaudeKeychainToken(): Promise<{
  accessToken: string;
  expiresAt: number;
} | null> {
  const credentials = await readClaudeKeychainCredentials();
  if (!credentials) {
    return null;
  }

  const now = Date.now();
  const expiresAt = credentials.expiresAt;

  // Check if token is still valid (with buffer)
  if (expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
    log.debug("Using cached Claude keychain token", {
      expiresIn: Math.round((expiresAt - now) / 1000 / 60) + " minutes",
    });
    return {
      accessToken: credentials.accessToken,
      expiresAt: credentials.expiresAt,
    };
  }

  // Token expired or expiring soon - refresh it
  log.info("Claude keychain token expiring, refreshing...", {
    expiresAt: new Date(expiresAt).toISOString(),
  });

  const refreshed = await refreshClaudeOAuthToken(credentials.refreshToken);
  if (!refreshed) {
    // If refresh fails but token still valid, use it
    if (expiresAt > now) {
      log.warn("Token refresh failed but current token still valid");
      return {
        accessToken: credentials.accessToken,
        expiresAt: credentials.expiresAt,
      };
    }
    return null;
  }

  // Save refreshed credentials to keychain
  await writeClaudeKeychainCredentials(refreshed);

  return {
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
  };
}

/**
 * Sync Claude keychain credentials to auth-profiles store
 * Call this to update the anthropic:default profile with fresh keychain token
 */
export async function syncClaudeKeychainToAuthProfile(): Promise<{
  accessToken: string;
  expiresAt: number;
} | null> {
  const result = await ensureClaudeKeychainToken();
  if (!result) {
    return null;
  }

  // The caller should update the auth-profiles store with this token
  return result;
}
