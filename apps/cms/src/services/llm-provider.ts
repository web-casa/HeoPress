// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * LLM Provider abstraction — POST-GA Task #1.
 *
 * Provides a unified interface to call OpenAI, Anthropic, Gemini or NVIDIA
 * for intent analysis in the AI Copilot. Each provider formats the
 * CORE_SKILLS as tool definitions in its native schema and returns
 * structured tool calls.
 *
 * Configuration:
 *   LLM_PROVIDER = 'openai' | 'anthropic' | 'claude' | 'gemini' | 'nvidia' | 'echo'
 *                ('vertex' and 'workers-ai' were removed in HeoPress P02; see
 *                 REMOVED_LLM_PROVIDERS)
 *   LLM_MODEL          — optional provider-specific model override
 *   OPENAI_API_KEY       — required when LLM_PROVIDER = 'openai'
 *   ANTHROPIC_API_KEY    — required when LLM_PROVIDER = 'anthropic' or 'claude'
 *   GEMINI_API_KEY       — required when LLM_PROVIDER = 'gemini'
 *   NVIDIA_API_KEY       — required when LLM_PROVIDER = 'nvidia'
 *
 * The `echo` provider is a no-LLM fallback that uses the legacy keyword
 * matcher (backward compat with the mock parser).
 */

import { serviceFetch } from './service-fetch';
import { CORE_SKILLS } from '@heopress/ai-skills';
import type { AISkillDefinition } from '@heopress/ai-skills';
import { removedLlmProviderMessage } from '../config/preflight';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Token counts reported by the upstream. Each field is `null` when that count
 * was not reported; the whole object is absent when neither was.
 */
export interface LLMUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  /** Omitted (not zero) when the provider response carries no usage. */
  usage?: LLMUsage;
}

export interface LLMChatOptions {
  /** Override the Copilot instructions for a specialized caller. */
  systemPrompt?: string;
  /** Defaults to true for Copilot callers. */
  tools?: boolean;
  /** Aborts the upstream HTTP request (deadline or caller cancellation). */
  signal?: AbortSignal;
  /** Output token cap (default 1024); the model gateway reserves for exactly this. */
  maxTokens?: number;
  /** The model gateway's task type for this call, when it differs from the binding's (e.g. `translation`). */
  taskType?: string;
}

/**
 * An error response of a native provider: the status and, when the body
 * reported it, the usage (an error can still be billed). The message keeps
 * the upstream text for legacy callers; the model gateway reads only the
 * status and usage (HeoPress P04 7.4).
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly usage: LLMUsage | undefined,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** Usage from an error body, in any of the three native formats. */
function errorUsage(text: string): LLMUsage | undefined {
  try {
    const body = JSON.parse(text) as {
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
    };
    return (
      readUsage(body.usage?.prompt_tokens ?? body.usage?.input_tokens, body.usage?.completion_tokens ?? body.usage?.output_tokens) ??
      readUsage(body.usageMetadata?.promptTokenCount, body.usageMetadata?.candidatesTokenCount)
    );
  } catch {
    return undefined;
  }
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Reads each count independently so a partially reported usage keeps the
 * known field; returns undefined only when neither count is usable.
 */
function readUsage(input: unknown, output: unknown): LLMUsage | undefined {
  const usage = { inputTokens: readCount(input), outputTokens: readCount(output) };
  return usage.inputTokens === null && usage.outputTokens === null ? undefined : usage;
}

export interface LLMProvider {
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the HeoPress AI Copilot — an assistant embedded in a headless CMS admin panel.
Your job is to help users manage their content, collections, and schema through natural language.

Rules:
- When the user asks you to perform an action, call the appropriate tool.
- If you cannot determine the action, respond with a helpful message asking for clarification.
- Never fabricate data. If you need information, use the list tools first.
- Be concise. Respond in the same language as the user.
- For dangerous operations (delete, schema changes), explain what will happen before calling the tool.`;

// ---------------------------------------------------------------------------
// Helpers — convert CORE_SKILLS to provider-specific tool schemas
// ---------------------------------------------------------------------------

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: AISkillDefinition['parameters'];
  };
}

function skillsToOpenAITools(): OpenAITool[] {
  return (Object.values(CORE_SKILLS) as AISkillDefinition[]).map((skill) => ({
    type: 'function' as const,
    function: {
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters,
    },
  }));
}

/** The Copilot instructions, for the model gateway's OpenAI-compatible requests (HeoPress P04 7.4). */
export function copilotSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/** The Copilot tools as plain definitions (name, description, JSON-schema parameters). */
export function copilotTools(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return skillsToOpenAITools().map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters as Record<string, unknown> }));
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: AISkillDefinition['parameters'];
}

function skillsToAnthropicTools(): AnthropicTool[] {
  return (Object.values(CORE_SKILLS) as AISkillDefinition[]).map((skill) => ({
    name: skill.name,
    description: skill.description,
    input_schema: skill.parameters,
  }));
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: AISkillDefinition['parameters'];
}

function skillsToGeminiFunctionDeclarations(): GeminiFunctionDeclaration[] {
  return (Object.values(CORE_SKILLS) as AISkillDefinition[]).map((skill) => ({
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
  }));
}

function normalizeGeminiModel(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

/**
 * Shape of a Gemini `:generateContent` response — identical for the public
 * Generative Language API and for Vertex AI, which is why both providers can
 * share {@link parseGeminiResponse}.
 */
interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Builds the `:generateContent` request body shared by the public Gemini API
 * and Vertex AI: system instruction, mapped turns, and CORE_SKILLS exposed as
 * function declarations with automatic function-calling.
 */
function buildGeminiRequestBody(
  messages: LLMMessage[],
  options: LLMChatOptions = {},
): Record<string, unknown> {
  const contents = messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));

  return {
    systemInstruction: {
      parts: [{ text: options.systemPrompt ?? SYSTEM_PROMPT }],
    },
    contents,
    ...(options.tools === false
      ? {}
      : {
          tools: [{ functionDeclarations: skillsToGeminiFunctionDeclarations() }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        }),
    generationConfig: {
      maxOutputTokens: options.maxTokens ?? 1024,
    },
  };
}

/** Extracts text content and tool calls from a Gemini/Vertex response. */
function parseGeminiResponse(data: GeminiGenerateContentResponse): LLMResponse {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content =
    parts
      .map((part) => part.text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n') || null;
  const toolCalls: LLMToolCall[] = parts
    .map((part) => part.functionCall)
    .filter((call): call is { name: string; args?: Record<string, unknown> } =>
      typeof call?.name === 'string',
    )
    .map((call) => ({
      name: call.name,
      arguments: call.args ?? {},
    }));

  const usage = readUsage(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount);
  return { content, toolCalls, ...(usage ? { usage } : {}) };
}

// ---------------------------------------------------------------------------
// OpenAI Provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  protected readonly apiKey: string;
  protected readonly model: string;
  /** API root without a trailing slash. `/chat/completions` is appended per call. */
  protected readonly baseUrl: string;
  /** Human-readable provider name used in error messages. */
  protected readonly label: string;

  constructor(
    apiKey: string,
    model = 'gpt-4o-mini',
    baseUrl = 'https://api.openai.com/v1',
    label = 'OpenAI',
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.label = label;
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMResponse> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: options.systemPrompt ?? SYSTEM_PROMPT }, ...messages],
      ...(options.tools === false ? {} : { tools: skillsToOpenAITools(), tool_choice: 'auto' }),
      max_tokens: options.maxTokens ?? 1024,
    };

    const res = await serviceFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new ProviderHttpError(`${this.label} API error ${res.status}: ${err}`, res.status, errorUsage(err));
    }

    const data = (await res.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: Array<{
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices[0]?.message;
    const toolCalls: LLMToolCall[] =
      choice?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      })) ?? [];

    const usage = readUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens);
    return {
      content: choice?.content ?? null,
      toolCalls,
      ...(usage ? { usage } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// NVIDIA Provider
// ---------------------------------------------------------------------------

/**
 * NVIDIA hosted inference (build.nvidia.com / NVIDIA NIM). The endpoint is
 * OpenAI-compatible, so this reuses {@link OpenAIProvider} end-to-end and only
 * swaps the base URL, the default model, and the error label.
 *
 * Note: this calls NVIDIA's hosted API — it is billed by NVIDIA, not by AWS.
 * Self-hosting a NIM container on an AWS GPU instance also exposes the same
 * OpenAI-compatible surface; point `NVIDIA_BASE_URL` at that container instead.
 *
 * `[Inference]` The default model id is a commonly-available NIM model but the
 * live catalogue changes over time — override with `LLM_MODEL` as needed.
 */
export class NvidiaProvider extends OpenAIProvider {
  constructor(
    apiKey: string,
    model = 'meta/llama-3.1-8b-instruct',
    baseUrl = 'https://integrate.api.nvidia.com/v1',
  ) {
    super(apiKey, model, baseUrl, 'NVIDIA');
  }
}

// ---------------------------------------------------------------------------
// Anthropic Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMResponse> {
    // Anthropic separates system from messages
    const userMessages = messages.map((m) => ({
      role: m.role === 'system' ? ('user' as const) : m.role,
      content: m.content,
    }));

    const body = {
      model: this.model,
      system: options.systemPrompt ?? SYSTEM_PROMPT,
      messages: userMessages,
      ...(options.tools === false ? {} : { tools: skillsToAnthropicTools() }),
      max_tokens: options.maxTokens ?? 1024,
    };

    const res = await serviceFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new ProviderHttpError(`Anthropic API error ${res.status}: ${err}`, res.status, errorUsage(err));
    }

    const data = (await res.json()) as {
      usage?: { input_tokens?: number; output_tokens?: number };
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: Record<string, unknown> }
      >;
    };

    let content: string | null = null;
    const toolCalls: LLMToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content = block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name, arguments: block.input });
      }
    }

    const usage = readUsage(data.usage?.input_tokens, data.usage?.output_tokens);
    return { content, toolCalls, ...(usage ? { usage } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Gemini Provider
// ---------------------------------------------------------------------------

export class GeminiProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'gemini-3.5-flash') {
    this.apiKey = apiKey;
    this.model = normalizeGeminiModel(model);
  }

  async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMResponse> {
    const body = buildGeminiRequestBody(messages, options);

    const res = await serviceFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new ProviderHttpError(`Gemini API error ${res.status}: ${err}`, res.status, errorUsage(err));
    }

    const data = (await res.json()) as GeminiGenerateContentResponse;
    return parseGeminiResponse(data);
  }
}

// ---------------------------------------------------------------------------
// Echo Provider (backward-compat mock — keyword matching)
// ---------------------------------------------------------------------------

export class EchoProvider implements LLMProvider {
  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      return { content: 'No message received.', toolCalls: [] };
    }

    const lower = lastUserMsg.content.toLowerCase();

    // Simple keyword-based intent matching (legacy behavior)
    if (lower.includes('list collections') || lower.includes('show collections')) {
      return { content: null, toolCalls: [{ name: 'listCollections', arguments: {} }] };
    }

    if (lower.includes('create collection')) {
      const nameMatch = lastUserMsg.content.match(/create collection\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'createCollection', arguments: { name: nameMatch?.[1] ?? 'untitled' } }],
      };
    }

    if (lower.includes('delete collection')) {
      const nameMatch = lastUserMsg.content.match(/delete collection\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'deleteCollection', arguments: { name: nameMatch?.[1] ?? '' } }],
      };
    }

    if (lower.includes('list items') || lower.includes('show items')) {
      const collMatch = lastUserMsg.content.match(
        /(?:list|show) items\s+(?:in|from|of)\s+["']?(\w+)["']?/i,
      );
      return {
        content: null,
        toolCalls: [{ name: 'listItems', arguments: { collection: collMatch?.[1] ?? '' } }],
      };
    }

    if (lower.includes('create item')) {
      const collMatch = lastUserMsg.content.match(/create item\s+(?:in|for)\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'createItem', arguments: { collection: collMatch?.[1] ?? '' } }],
      };
    }

    if (lower.includes('delete item')) {
      const idMatch = lastUserMsg.content.match(/delete item\s+["']?(\w+)["']?/i);
      return {
        content: null,
        toolCalls: [{ name: 'deleteItem', arguments: { id: idMatch?.[1] ?? '' } }],
      };
    }

    return {
      content: 'Could not determine action from your message.',
      toolCalls: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface LLMProviderEnv {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  /** Optional NVIDIA endpoint override (e.g. a self-hosted NIM container). */
  NVIDIA_BASE_URL?: string;
}

/**
 * Creates the appropriate LLM provider based on environment config.
 * Falls back to `EchoProvider` when no provider is configured.
 */
export function createLLMProvider(env: LLMProviderEnv): LLMProvider {
  const provider = env.LLM_PROVIDER ?? 'echo';

  switch (provider) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        console.warn('[llm] OPENAI_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new OpenAIProvider(env.OPENAI_API_KEY, env.LLM_MODEL);
    }

    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        console.warn('[llm] ANTHROPIC_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.LLM_MODEL);
    }

    case 'claude': {
      if (!env.ANTHROPIC_API_KEY) {
        console.warn('[llm] ANTHROPIC_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.LLM_MODEL);
    }

    case 'gemini': {
      if (!env.GEMINI_API_KEY) {
        console.warn('[llm] GEMINI_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new GeminiProvider(env.GEMINI_API_KEY, env.LLM_MODEL);
    }

    case 'nvidia': {
      if (!env.NVIDIA_API_KEY) {
        console.warn('[llm] NVIDIA_API_KEY not set, falling back to echo provider');
        return new EchoProvider();
      }
      return new NvidiaProvider(
        env.NVIDIA_API_KEY,
        env.LLM_MODEL,
        env.NVIDIA_BASE_URL ?? undefined,
      );
    }

    case 'vertex':
    case 'workers-ai':
      // Removed in HeoPress P02; the startup preflight already refuses these.
      throw new Error(removedLlmProviderMessage(provider));

    default:
      return new EchoProvider();
  }
}

// ---------------------------------------------------------------------------
// Configured provider resolution (no silent echo fallback)
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  claude: 'claude-sonnet-4-20250514',
  gemini: 'gemini-3.5-flash',
  nvidia: 'meta/llama-3.1-8b-instruct',
};

export interface ConfiguredLLM {
  provider: LLMProvider;
  /** Provider name from LLM_PROVIDER (e.g. 'openai'). */
  name: string;
  /** Resolved model identifier, recorded in run metrics and provenance. */
  model: string;
}

/**
 * Resolves a real LLM provider from the environment, or `null` when none is
 * configured. Unlike `createLLMProvider`, this never falls back to the echo
 * provider — generation skills use it to fail loudly (LLM_NOT_CONFIGURED)
 * instead of silently returning stub output.
 */
export function createConfiguredLLMProvider(env: LLMProviderEnv): ConfiguredLLM | null {
  const name = env.LLM_PROVIDER;
  if (!name || name === 'echo') return null;

  const hasCredentials =
    (name === 'openai' && Boolean(env.OPENAI_API_KEY)) ||
    ((name === 'anthropic' || name === 'claude') && Boolean(env.ANTHROPIC_API_KEY)) ||
    (name === 'gemini' && Boolean(env.GEMINI_API_KEY)) ||
    (name === 'nvidia' && Boolean(env.NVIDIA_API_KEY));
  if (!hasCredentials) return null;

  return {
    provider: createLLMProvider(env),
    name,
    model: env.LLM_MODEL ?? PROVIDER_DEFAULT_MODELS[name] ?? 'default',
  };
}
