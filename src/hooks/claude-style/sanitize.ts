/**
 * Sanitization utilities for hook payloads.
 *
 * Tool results may contain binary data, large buffers, or non-JSON-safe values.
 * These utilities ensure safe serialization for hook protocols.
 */

// =============================================================================
// Constants
// =============================================================================

/** Maximum string length before truncation (100KB). */
const MAX_STRING_LENGTH = 100_000;

/** Maximum object traversal depth. */
const MAX_DEPTH = 10;

/** Maximum output size after JSON serialization (100KB). */
const MAX_OUTPUT_SIZE = 100_000;

/** Placeholder for binary buffers. */
const BUFFER_PLACEHOLDER = "[Binary Buffer]";

/** Placeholder for circular references. */
const CIRCULAR_PLACEHOLDER = "[Circular Reference]";

/** Placeholder for truncated strings. */
const TRUNCATED_SUFFIX = "... [truncated]";

// =============================================================================
// Sanitization
// =============================================================================

/**
 * Sanitize a value for safe hook transmission.
 *
 * Handles:
 * 1. Truncates strings over 100KB
 * 2. Replaces binary buffers with placeholder
 * 3. Limits object depth to 10
 * 4. Removes circular references
 * 5. Ensures JSON-serializable output
 *
 * @param result - The value to sanitize
 * @returns A JSON-safe, sanitized copy of the value
 */
export function sanitizeForHook(result: unknown): unknown {
  // Handle undefined early (JSON.stringify(undefined) returns undefined, not a string)
  if (result === undefined) {
    return null;
  }

  const seen = new WeakSet();
  const sanitized = sanitizeValue(result, seen, 0);

  // Final JSON round-trip ensures serializable + enforces size limit
  try {
    const json = JSON.stringify(sanitized);
    if (json === undefined) {
      // Shouldn't happen after sanitization, but guard anyway
      return null;
    }
    if (json.length > MAX_OUTPUT_SIZE) {
      // Truncate the JSON string and re-parse to get valid JSON
      const truncatedJson = json.slice(0, MAX_OUTPUT_SIZE - 50);
      // Find last complete structure
      const lastComplete = findLastCompleteJson(truncatedJson);
      if (lastComplete) {
        return JSON.parse(lastComplete);
      }
      // Fallback: return truncation notice
      return { _truncated: true, _originalSize: json.length };
    }
    return JSON.parse(json);
  } catch {
    return { _error: "Failed to serialize result" };
  }
}

/**
 * Recursively sanitize a value.
 */
function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle primitives
  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // Handle functions (not JSON-safe)
  if (typeof value === "function") {
    return "[Function]";
  }

  // Handle symbols (not JSON-safe)
  if (typeof value === "symbol") {
    return value.toString();
  }

  // Handle bigint (not JSON-safe)
  if (typeof value === "bigint") {
    return value.toString();
  }

  // Handle objects (including arrays, buffers, etc.)
  if (typeof value === "object") {
    // Check depth limit
    if (depth >= MAX_DEPTH) {
      return "[Max Depth Exceeded]";
    }

    // Check circular reference
    if (seen.has(value)) {
      return CIRCULAR_PLACEHOLDER;
    }
    seen.add(value);

    // Handle Buffer/Uint8Array (binary data)
    if (isBuffer(value)) {
      return BUFFER_PLACEHOLDER;
    }

    // Handle Date
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle Error
    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncateString(value.message),
        stack: value.stack ? truncateString(value.stack) : undefined,
      };
    }

    // Handle Arrays
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, seen, depth + 1));
    }

    // Handle plain objects
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const val = (value as Record<string, unknown>)[key];
      sanitized[key] = sanitizeValue(val, seen, depth + 1);
    }
    return sanitized;
  }

  // Unknown type fallback
  return "[Unknown Type]";
}

/**
 * Truncate a string if it exceeds the maximum length.
 */
function truncateString(str: string): string {
  if (str.length <= MAX_STRING_LENGTH) {
    return str;
  }
  return str.slice(0, MAX_STRING_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/**
 * Check if a value is a Buffer or typed array (binary data).
 */
function isBuffer(value: unknown): boolean {
  if (Buffer.isBuffer(value)) {
    return true;
  }
  if (value instanceof ArrayBuffer) {
    return true;
  }
  if (ArrayBuffer.isView(value)) {
    return true;
  }
  return false;
}

/**
 * Find the last position that creates valid JSON by truncating.
 * Returns the truncated JSON string or null if not possible.
 */
function findLastCompleteJson(truncated: string): string | null {
  // Try to find a good cut point by working backwards
  // Look for structural endings: }, ], "
  for (let i = truncated.length - 1; i >= 0; i--) {
    const char = truncated[i];
    if (char === "}" || char === "]" || char === '"') {
      const candidate = truncated.slice(0, i + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Continue searching
      }
    }
  }
  return null;
}

// =============================================================================
// Exports for Testing
// =============================================================================

export const _testOnly = {
  MAX_STRING_LENGTH,
  MAX_DEPTH,
  MAX_OUTPUT_SIZE,
  BUFFER_PLACEHOLDER,
  CIRCULAR_PLACEHOLDER,
  truncateString,
  isBuffer,
};
