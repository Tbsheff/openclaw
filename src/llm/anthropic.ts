/**
 * Anthropic LLM client for pipeline agents.
 *
 * Uses the Anthropic API directly via fetch for simplicity.
 * Supports structured output via tool use.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// =============================================================================
// TYPES
// =============================================================================

export interface LLMConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: "text" | "tool_use";
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// =============================================================================
// LLM CLIENT
// =============================================================================

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const API_URL = "https://api.anthropic.com/v1/messages";

export class AnthropicClient {
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private systemPromptCache: Map<string, string> = new Map();

  constructor(config: LLMConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;

    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
  }

  /**
   * Load a system prompt from the prompts directory.
   */
  async loadSystemPrompt(promptName: string): Promise<string> {
    const cached = this.systemPromptCache.get(promptName);
    if (cached) {
      return cached;
    }

    const promptPath = join(process.cwd(), "prompts", `${promptName}.md`);
    try {
      const content = await readFile(promptPath, "utf-8");
      this.systemPromptCache.set(promptName, content);
      return content;
    } catch (err) {
      console.warn(`[LLM] Failed to load prompt ${promptName}:`, (err as Error).message);
      return "";
    }
  }

  /**
   * Generate a completion with the given messages.
   */
  async complete(params: {
    systemPrompt?: string;
    messages: LLMMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens ?? this.maxTokens,
        temperature: params.temperature ?? this.temperature,
        system: params.systemPrompt ?? "",
        messages: params.messages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const textContent = data.content.find((c) => c.type === "text");
    return textContent?.text ?? "";
  }

  /**
   * Generate structured output using tool use.
   */
  async completeWithSchema<T>(params: {
    systemPrompt?: string;
    messages: LLMMessage[];
    schema: z.ZodSchema<T>;
    schemaName: string;
    schemaDescription: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<T> {
    // Convert Zod schema to JSON schema for tool definition
    const jsonSchema = zodToJsonSchema(params.schema);

    const tool = {
      name: params.schemaName,
      description: params.schemaDescription,
      input_schema: jsonSchema,
    };

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: params.maxTokens ?? this.maxTokens,
        temperature: params.temperature ?? this.temperature,
        system: params.systemPrompt ?? "",
        messages: params.messages,
        tools: [tool],
        tool_choice: { type: "tool", name: params.schemaName },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const toolUse = data.content.find((c) => c.type === "tool_use");

    if (!toolUse || !toolUse.input) {
      throw new Error("No tool use in response");
    }

    // Validate with Zod schema
    return params.schema.parse(toolUse.input);
  }
}

// =============================================================================
// SCHEMA CONVERSION
// =============================================================================

/**
 * Convert a Zod schema to JSON Schema format for Anthropic tool use.
 * Uses zod-to-json-schema pattern compatible with Zod v4.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Use runtime type checking approach for Zod v4 compatibility
  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName;

  // Handle ZodObject
  if (typeName === "ZodObject" || "shape" in schema) {
    const objectSchema = schema as z.ZodObject<z.ZodRawShape>;
    const shape = objectSchema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = value as z.ZodType;
      properties[key] = zodToJsonSchema(fieldSchema);

      // Check if field is optional
      if (!fieldSchema.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  // Handle ZodArray
  if (typeName === "ZodArray" || "element" in schema) {
    const arraySchema = schema as z.ZodArray<z.ZodType>;
    return {
      type: "array",
      items: zodToJsonSchema(arraySchema.element),
    };
  }

  // Handle ZodString
  if (typeName === "ZodString") {
    return { type: "string" };
  }

  // Handle ZodNumber
  if (typeName === "ZodNumber") {
    return { type: "number" };
  }

  // Handle ZodBoolean
  if (typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  // Handle ZodOptional
  if (typeName === "ZodOptional" && "unwrap" in schema) {
    const optionalSchema = schema as z.ZodOptional<z.ZodType>;
    return zodToJsonSchema(optionalSchema.unwrap());
  }

  // Handle ZodDefault
  if (typeName === "ZodDefault" && "removeDefault" in schema) {
    const defaultSchema = schema as z.ZodDefault<z.ZodType>;
    return zodToJsonSchema(defaultSchema.removeDefault());
  }

  // Handle ZodEnum
  if (typeName === "ZodEnum" && "options" in schema) {
    const enumSchema = schema as unknown as { options: string[] };
    return {
      type: "string",
      enum: enumSchema.options,
    };
  }

  // Default fallback
  return { type: "string" };
}

// =============================================================================
// SINGLETON
// =============================================================================

let defaultClient: AnthropicClient | null = null;

/**
 * Get or create the default Anthropic client.
 */
export function getLLM(config?: LLMConfig): AnthropicClient {
  if (!defaultClient) {
    defaultClient = new AnthropicClient(config);
  }
  return defaultClient;
}
