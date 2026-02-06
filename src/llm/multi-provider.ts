/**
 * Multi-Provider LLM Client
 *
 * Routes to appropriate provider based on model string:
 * - anthropic/* -> Anthropic API
 * - openai-codex/* -> OpenAI Codex API
 * - openai/* -> OpenAI API
 * - openrouter/* -> OpenRouter API
 */

import { z } from "zod";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";

// =============================================================================
// TYPES
// =============================================================================

export interface LLMConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: "off" | "low" | "medium" | "high";
}

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

// =============================================================================
// PROVIDER DETECTION
// =============================================================================

type Provider = "anthropic" | "openai-codex" | "openai" | "openrouter";

interface ProviderInfo {
  provider: Provider;
  modelId: string;
  apiUrl: string;
}

function parseModel(model: string): ProviderInfo {
  const [providerPart, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");

  switch (providerPart) {
    case "anthropic":
      return {
        provider: "anthropic",
        modelId: modelId || "claude-sonnet-4-5-20250514",
        apiUrl: "https://api.anthropic.com/v1/messages",
      };
    case "openai-codex":
      return {
        provider: "openai-codex",
        modelId: modelId || "gpt-5.3-codex",
        apiUrl: "https://api.openai.com/v1/responses",
      };
    case "openai":
      return {
        provider: "openai",
        modelId: modelId || "gpt-4o",
        apiUrl: "https://api.openai.com/v1/chat/completions",
      };
    case "openrouter":
      return {
        provider: "openrouter",
        modelId: modelId || "anthropic/claude-3-sonnet",
        apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      };
    default:
      // Assume full model string is an Anthropic model
      return {
        provider: "anthropic",
        modelId: model,
        apiUrl: "https://api.anthropic.com/v1/messages",
      };
  }
}

// =============================================================================
// API KEY RESOLUTION
// =============================================================================

const apiKeyCache: Map<Provider, string> = new Map();

async function getApiKey(provider: Provider): Promise<string> {
  const cached = apiKeyCache.get(provider);
  if (cached) return cached;

  try {
    const auth = await resolveApiKeyForProvider({ provider });
    if (auth.apiKey) {
      apiKeyCache.set(provider, auth.apiKey);
      return auth.apiKey;
    }
  } catch {
    // Fall through to env var
  }

  // Fallback to environment variables
  const envVarMap: Record<Provider, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    "openai-codex": "OPENAI_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };

  const envKey = process.env[envVarMap[provider]];
  if (envKey) {
    apiKeyCache.set(provider, envKey);
    return envKey;
  }

  throw new Error(`No API key found for provider: ${provider}`);
}

// =============================================================================
// ANTHROPIC API
// =============================================================================

async function callAnthropic(
  config: LLMConfig,
  providerInfo: ProviderInfo,
  systemPrompt: string,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  const apiKey = await getApiKey("anthropic");

  // Convert messages to Anthropic format (no system role in messages)
  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const response = await fetch(providerInfo.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: providerInfo.modelId,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature ?? 0.7,
      system: systemPrompt,
      messages: anthropicMessages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  const textContent = data.content?.find((c: { type: string }) => c.type === "text");

  return {
    content: textContent?.text ?? "",
    model: data.model,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

// =============================================================================
// OPENAI-STYLE API (OpenAI, OpenAI Codex, OpenRouter)
// =============================================================================

async function callOpenAIStyle(
  config: LLMConfig,
  providerInfo: ProviderInfo,
  systemPrompt: string,
  messages: LLMMessage[],
): Promise<LLMResponse> {
  const apiKey = await getApiKey(providerInfo.provider);

  // Build messages array with system prompt
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // OpenRouter needs additional headers
  if (providerInfo.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://openclaw.ai";
    headers["X-Title"] = "OpenClaw Orchestrator";
  }

  const response = await fetch(providerInfo.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: providerInfo.modelId,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature ?? 0.7,
      messages: openaiMessages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`${providerInfo.provider} API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? data.output?.[0]?.content ?? "";

  return {
    content,
    model: data.model,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
    },
  };
}

// =============================================================================
// MAIN CLIENT
// =============================================================================

export class MultiProviderLLM {
  private config: LLMConfig;
  private providerInfo: ProviderInfo;

  constructor(config: LLMConfig) {
    this.config = config;
    this.providerInfo = parseModel(config.model);
    console.log(`[llm] Using ${this.providerInfo.provider}/${this.providerInfo.modelId}`);
  }

  /**
   * Generate a completion
   */
  async complete(params: {
    systemPrompt?: string;
    messages: LLMMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const effectiveConfig: LLMConfig = {
      ...this.config,
      maxTokens: params.maxTokens ?? this.config.maxTokens,
      temperature: params.temperature ?? this.config.temperature,
    };

    const systemPrompt = params.systemPrompt ?? "";
    const response = await this.callProvider(effectiveConfig, systemPrompt, params.messages);
    return response.content;
  }

  /**
   * Generate structured output using JSON mode or tool use
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
    // For now, use prompt-based JSON extraction
    // TODO: Implement proper tool use for Anthropic and function calling for OpenAI
    const jsonPrompt = `${params.systemPrompt ?? ""}

You must respond with valid JSON matching this schema:
${JSON.stringify(zodToJsonSchema(params.schema), null, 2)}

Output ONLY the JSON, no other text.`;

    const content = await this.complete({
      systemPrompt: jsonPrompt,
      messages: params.messages,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return params.schema.parse(parsed);
  }

  private async callProvider(
    config: LLMConfig,
    systemPrompt: string,
    messages: LLMMessage[],
  ): Promise<LLMResponse> {
    switch (this.providerInfo.provider) {
      case "anthropic":
        return callAnthropic(config, this.providerInfo, systemPrompt, messages);
      case "openai-codex":
      case "openai":
      case "openrouter":
        return callOpenAIStyle(config, this.providerInfo, systemPrompt, messages);
      default:
        throw new Error(`Unknown provider: ${this.providerInfo.provider}`);
    }
  }
}

// =============================================================================
// SCHEMA CONVERSION (simplified)
// =============================================================================

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName;

  if (typeName === "ZodObject" || "shape" in schema) {
    const objectSchema = schema as z.ZodObject<z.ZodRawShape>;
    const shape = objectSchema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = value as z.ZodType;
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!fieldSchema.isOptional()) {
        required.push(key);
      }
    }

    return { type: "object", properties, required };
  }

  if (typeName === "ZodArray") {
    const arraySchema = schema as z.ZodArray<z.ZodType>;
    return { type: "array", items: zodToJsonSchema(arraySchema.element) };
  }

  if (typeName === "ZodString") return { type: "string" };
  if (typeName === "ZodNumber") return { type: "number" };
  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodOptional" && "unwrap" in schema) {
    return zodToJsonSchema((schema as z.ZodOptional<z.ZodType>).unwrap());
  }
  if (typeName === "ZodEnum" && "options" in schema) {
    return { type: "string", enum: (schema as unknown as { options: string[] }).options };
  }

  return { type: "string" };
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create an LLM client for the given config
 */
export function createMultiProviderLLM(config: LLMConfig): MultiProviderLLM {
  return new MultiProviderLLM(config);
}
