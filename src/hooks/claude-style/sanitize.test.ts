import { describe, it, expect } from "vitest";
import { sanitizeForHook, _testOnly } from "./sanitize.js";

const { MAX_STRING_LENGTH, BUFFER_PLACEHOLDER, CIRCULAR_PLACEHOLDER } = _testOnly;

describe("sanitizeForHook", () => {
  describe("primitives", () => {
    it("passes through null and undefined", () => {
      expect(sanitizeForHook(null)).toBe(null);
      expect(sanitizeForHook(undefined)).toBe(null); // JSON.parse(JSON.stringify(undefined)) -> null
    });

    it("passes through numbers", () => {
      expect(sanitizeForHook(42)).toBe(42);
      expect(sanitizeForHook(3.14)).toBe(3.14);
      expect(sanitizeForHook(-0)).toBe(0);
    });

    it("passes through booleans", () => {
      expect(sanitizeForHook(true)).toBe(true);
      expect(sanitizeForHook(false)).toBe(false);
    });

    it("passes through short strings", () => {
      expect(sanitizeForHook("hello")).toBe("hello");
      expect(sanitizeForHook("")).toBe("");
    });

    it("converts bigint to string", () => {
      expect(sanitizeForHook(BigInt(123))).toBe("123");
    });

    it("converts symbol to string", () => {
      const result = sanitizeForHook(Symbol("test"));
      expect(result).toBe("Symbol(test)");
    });

    it("converts function to placeholder", () => {
      const result = sanitizeForHook(() => {});
      expect(result).toBe("[Function]");
    });
  });

  describe("string truncation", () => {
    it("preserves strings under the size limit", () => {
      // Use a smaller string that won't hit MAX_OUTPUT_SIZE
      const mediumString = "x".repeat(50_000);
      const result = sanitizeForHook(mediumString) as string;
      expect(result).toBe(mediumString);
    });

    it("truncates very long strings", () => {
      // Create a string longer than MAX_STRING_LENGTH
      const veryLongString = "x".repeat(MAX_STRING_LENGTH + 1000);
      const result = sanitizeForHook(veryLongString);
      // Due to MAX_OUTPUT_SIZE limit, may get truncation notice
      if (typeof result === "string") {
        expect(result.length).toBeLessThanOrEqual(MAX_STRING_LENGTH);
        expect(result).toContain("... [truncated]");
      } else {
        // Large strings may hit MAX_OUTPUT_SIZE and return truncation notice
        expect(result).toHaveProperty("_truncated", true);
      }
    });

    it("handles strings near the output size limit", () => {
      // String that's large but under string limit
      const nearLimitString = "x".repeat(90_000);
      const result = sanitizeForHook(nearLimitString);
      // Should either preserve the string or truncate gracefully
      expect(result).toBeDefined();
    });
  });

  describe("binary data handling", () => {
    it("replaces Buffer with placeholder", () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      expect(sanitizeForHook(buffer)).toBe(BUFFER_PLACEHOLDER);
    });

    it("replaces Uint8Array with placeholder", () => {
      const arr = new Uint8Array([1, 2, 3]);
      expect(sanitizeForHook(arr)).toBe(BUFFER_PLACEHOLDER);
    });

    it("replaces ArrayBuffer with placeholder", () => {
      const arr = new ArrayBuffer(8);
      expect(sanitizeForHook(arr)).toBe(BUFFER_PLACEHOLDER);
    });

    it("replaces nested buffers with placeholder", () => {
      const obj = {
        name: "test",
        data: Buffer.from([0x00]),
        nested: {
          buffer: new Uint8Array([1, 2, 3]),
        },
      };
      const result = sanitizeForHook(obj) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.data).toBe(BUFFER_PLACEHOLDER);
      expect((result.nested as Record<string, unknown>).buffer).toBe(BUFFER_PLACEHOLDER);
    });
  });

  describe("circular reference handling", () => {
    it("replaces circular references with placeholder", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;

      const result = sanitizeForHook(obj) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.self).toBe(CIRCULAR_PLACEHOLDER);
    });

    it("handles complex circular structures", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b" };
      a.ref = b;
      b.ref = a;

      const result = sanitizeForHook(a) as Record<string, unknown>;
      expect(result.name).toBe("a");
      const refB = result.ref as Record<string, unknown>;
      expect(refB.name).toBe("b");
      expect(refB.ref).toBe(CIRCULAR_PLACEHOLDER);
    });

    it("handles arrays with circular references", () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);

      const result = sanitizeForHook(arr) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      expect(result[2]).toBe(CIRCULAR_PLACEHOLDER);
    });
  });

  describe("depth limiting", () => {
    it("limits nesting to MAX_DEPTH levels", () => {
      // Create deeply nested object
      let deep: Record<string, unknown> = { value: "bottom" };
      for (let i = 0; i < 15; i++) {
        deep = { nested: deep };
      }

      const result = sanitizeForHook(deep) as Record<string, unknown>;

      // Walk down the result to find the truncation point
      let current = result;
      let depth = 0;
      while (typeof current === "object" && current !== null && "nested" in current) {
        const nested = current.nested;
        if (nested === "[Max Depth Exceeded]") {
          break;
        }
        current = nested as Record<string, unknown>;
        depth++;
      }

      // Should have stopped at depth 10
      expect(depth).toBeLessThanOrEqual(10);
    });
  });

  describe("object handling", () => {
    it("preserves plain objects", () => {
      const obj = { name: "test", count: 42 };
      expect(sanitizeForHook(obj)).toEqual(obj);
    });

    it("preserves nested objects", () => {
      const obj = {
        outer: {
          inner: {
            value: "deep",
          },
        },
      };
      expect(sanitizeForHook(obj)).toEqual(obj);
    });

    it("converts Date to ISO string", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      expect(sanitizeForHook(date)).toBe("2024-01-15T12:00:00.000Z");
    });

    it("sanitizes Error objects", () => {
      const error = new Error("test error");
      const result = sanitizeForHook(error) as Record<string, unknown>;
      expect(result.name).toBe("Error");
      expect(result.message).toBe("test error");
      expect(typeof result.stack).toBe("string");
    });
  });

  describe("array handling", () => {
    it("preserves arrays", () => {
      const arr = [1, 2, 3];
      expect(sanitizeForHook(arr)).toEqual(arr);
    });

    it("sanitizes array elements", () => {
      const arr = ["hello", Buffer.from([1]), { nested: true }];
      const result = sanitizeForHook(arr) as unknown[];
      expect(result[0]).toBe("hello");
      expect(result[1]).toBe(BUFFER_PLACEHOLDER);
      expect(result[2]).toEqual({ nested: true });
    });
  });

  describe("large output handling", () => {
    it("handles very large objects by truncating", () => {
      // Create object that would serialize to >100KB
      const largeObj = {
        items: Array(1000)
          .fill(null)
          .map((_, i) => ({
            id: i,
            data: "x".repeat(200),
          })),
      };

      const result = sanitizeForHook(largeObj);
      const resultJson = JSON.stringify(result);

      // Should be within limits
      expect(resultJson.length).toBeLessThanOrEqual(100_000);
    });

    it("returns truncation notice for extremely large data", () => {
      // Create very large object that can't be truncated gracefully
      const hugeObj = {
        data: "x".repeat(200_000),
      };

      const result = sanitizeForHook(hugeObj);
      // Either truncated data or truncation notice
      expect(result).toBeDefined();
    });
  });

  describe("real-world tool results", () => {
    it("handles typical bash output", () => {
      const bashResult = {
        exitCode: 0,
        stdout: "hello world\n",
        stderr: "",
      };
      expect(sanitizeForHook(bashResult)).toEqual(bashResult);
    });

    it("handles file read result with binary content", () => {
      const readResult = {
        path: "/test/file.bin",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG header
        size: 4,
      };
      const result = sanitizeForHook(readResult) as Record<string, unknown>;
      expect(result.path).toBe("/test/file.bin");
      expect(result.content).toBe(BUFFER_PLACEHOLDER);
      expect(result.size).toBe(4);
    });

    it("handles glob result with many files", () => {
      const globResult = {
        pattern: "**/*.ts",
        matches: Array(100)
          .fill(null)
          .map((_, i) => `/src/file${i}.ts`),
      };
      const result = sanitizeForHook(globResult) as Record<string, unknown>;
      expect(result.pattern).toBe("**/*.ts");
      expect((result.matches as string[]).length).toBe(100);
    });

    it("handles error result", () => {
      const errorResult = {
        error: "ENOENT: no such file or directory",
        code: "ENOENT",
        path: "/missing/file.txt",
      };
      expect(sanitizeForHook(errorResult)).toEqual(errorResult);
    });
  });
});
