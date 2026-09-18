/**
 * 通用大模型调用客户端
 * 支持双模型：OpenAI (Chat Completions) 和 Claude (Anthropic Messages)
 * 通过 model-routing 按任务类型自动路由
 */

import {
  getRoute,
  getRouteCandidates,
  getApiKey,
  getBaseUrl,
  type ModelProvider,
  type TaskType,
} from '../config/model-routing.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  content: string;
  provider: ModelProvider;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatOptions {
  /** 任务类型，用于自动路由到对应模型 */
  task?: TaskType;
  /** 显式指定 provider（覆盖路由） */
  provider?: ModelProvider;
  /** 显式指定模型（覆盖路由） */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  minOutputChars?: number;
}

export class ModelClient {
  private readonly lastRequestAt = new Map<ModelProvider, number>();

  /**
   * 统一聊天接口
   * 优先按 task 路由，其次按显式 provider/model
   */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    let provider: ModelProvider = options.provider || 'openai';
    let model = options.model;
    let routes = [{ provider, model: model || '' }];

    if (options.task) {
      const route = getRoute(options.task);
      provider = route.provider;
      model = model || route.model;
      routes = getRouteCandidates(options.task);
      routes[0] = { provider, model };
    }

    if (!model) {
      model = provider === 'claude'
        ? process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
        : process.env.OPENAI_MODEL || 'gpt-5.6-terra';
    }

    routes[0] = { provider, model };
    let lastError: unknown;
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      try {
        return await this.requestRoute(messages, route, options);
      } catch (error) {
        lastError = error;
        const fallback = routes[routeIndex + 1];
        if (!fallback || !isRouteFailoverEligible(error)) throw error;
        console.warn(`[模型切换] ${route.provider}/${route.model} 请求失败，切换到 ${fallback.provider}/${fallback.model}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('模型路由全部失败');
  }

  private async requestRoute(
    messages: ChatMessage[],
    route: { provider: ModelProvider; model: string },
    options: ChatOptions
  ): Promise<ChatResponse> {
    const configuredRetries = Number(process.env.MODEL_MAX_RETRIES || 0);
    const defaultAttempts = Number.isSafeInteger(configuredRetries) && configuredRetries >= 0
      ? configuredRetries + 1
      : 1;
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? defaultAttempts));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.waitForPacing(route.provider);
        if (route.provider === 'claude') {
          const response = await this.chatClaude(messages, route.model, options);
          assertUsefulResponse(response.content, options, route.model);
          return response;
        }
        const response = await this.chatOpenAI(messages, route.model, options);
        assertUsefulResponse(response.content, options, route.model);
        return response;
      } catch (error) {
        const retryable = isRetryableModelError(error);
        if (!retryable) throw error;
        if (error instanceof ModelRequestError && error.code === 'EMPTY_RESPONSE') throw error;
        if (attempt >= maxAttempts) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `中转站上游暂不可用；为避免重复计费，已停止自动重试。稍后手动继续即可。原始错误：${detail}`
          );
        }
        await delay(800 * attempt);
      }
    }

    throw new Error('模型调用失败');
  }

  private async waitForPacing(provider: ModelProvider): Promise<void> {
    const configured = Number(process.env.MODEL_MIN_INTERVAL_MS || 500);
    const interval = Number.isFinite(configured) ? Math.max(0, configured) : 500;
    const waitMs = interval - (Date.now() - (this.lastRequestAt.get(provider) || 0));
    if (waitMs > 0) await delay(waitMs);
    this.lastRequestAt.set(provider, Date.now());
  }

  /**
   * 判断模型是否使用 Responses API（gpt-5.x 系列在中转站只支持 Responses API）
   */
  private useResponsesApi(model: string): boolean {
    return /gpt-5/i.test(model) || process.env.OPENAI_USE_RESPONSES_API === 'true';
  }

  /**
   * OpenAI 调用入口：自动选择 Responses API 或 Chat Completions
   */
  private async chatOpenAI(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions
  ): Promise<ChatResponse> {
    if (this.useResponsesApi(model)) {
      return this.chatOpenAIResponses(messages, model, options);
    }
    return this.chatOpenAICompletions(messages, model, options);
  }

  /**
   * OpenAI Responses API 格式（gpt-5.x 系列，中转站 code.rayinai.com）
   */
  private async chatOpenAIResponses(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions
  ): Promise<ChatResponse> {
    const apiKey = getApiKey('openai');
    const baseUrl = getBaseUrl('openai');

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY 未配置，请在 .env 中填写');
    }

    // Responses API 的 input 格式
    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMsgs = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model,
      input: conversationMsgs,
      max_output_tokens: options.maxTokens ?? 4096,
    };

    if (systemMsg) {
      body.instructions = systemMsg.content;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    // 推理努力
    const effort = process.env.OPENAI_REASONING_EFFORT;
    if (effort) {
      body.reasoning = { effort };
    }

    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.MODEL_TIMEOUT_MS || 120000)),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OpenAI ${model} Responses] 调用失败 [${response.status}]: ${errorText}`);
    }

    const data = await parseJsonResponse(response, `OpenAI ${model} Responses`);

    // 解析 Responses API 输出
    const output = (data.output as Array<Record<string, unknown>>) || [];
    let text = '';
    for (const item of output) {
      if (item.type === 'message') {
        const contents = (item.content as Array<Record<string, unknown>>) || [];
        for (const c of contents) {
          if (c.type === 'output_text') {
            text += (c.text as string) || '';
          }
        }
      }
    }

    const usage = (data.usage as Record<string, number>) || {};
    assertNonEmptyResponse(text, 'openai', model, usage.output_tokens || 0);

    return {
      content: text,
      provider: 'openai' as const,
      model,
      usage: {
        promptTokens: usage.input_tokens || 0,
        completionTokens: usage.output_tokens || 0,
        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      },
    };
  }

  /**
   * OpenAI Chat Completions 格式（gpt-4o 等旧模型）
   */
  private async chatOpenAICompletions(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions
  ): Promise<ChatResponse> {
    const apiKey = getApiKey('openai');
    const baseUrl = getBaseUrl('openai');

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY 未配置，请在 .env 中填写');
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.MODEL_TIMEOUT_MS || 120000)),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OpenAI ${model}] 调用失败 [${response.status}]: ${errorText}`);
    }

    const data = await parseJsonResponse(response, `OpenAI ${model}`);
    const content = (data.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown> | undefined;
    const text = (content?.content as string) || '';
    const usage = (data.usage as Record<string, number>) || {};
    assertNonEmptyResponse(text, 'openai', model, usage.completion_tokens || 0);

    return {
      content: text,
      provider: 'openai' as const,
      model,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
    };
  }

  /**
   * Claude (Anthropic) Messages 格式
   * 兼容中转站 code.rayinai.com
   */
  private async chatClaude(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions
  ): Promise<ChatResponse> {
    const apiKey = getApiKey('claude');
    const baseUrl = getBaseUrl('claude');

    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY 未配置，请在 .env 中填写');
    }

    if (useClaudeOpenAICompatibility(baseUrl)) {
      return this.chatClaudeCompletions(messages, model, options, apiKey, baseUrl);
    }

    // Claude 不支持 system role，需要把 system 消息提取到 system 字段
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: conversationMessages,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const response = await fetch(buildApiUrl(baseUrl, '/messages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.MODEL_TIMEOUT_MS || 120000)),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[Claude ${model}] 调用失败 [${response.status}]: ${errorText}`);
    }

    const data = await parseJsonResponse(response, `Claude ${model}`);

    // Claude 返回 content 数组，取 text 类型的拼接
    const contentBlocks = (data.content as Array<{ type: string; text?: string }>) || [];
    const content = contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join('');

    const usage = (data.usage as Record<string, number>) || {};
    assertNonEmptyResponse(content, 'claude', model, usage.output_tokens || 0);

    return {
      content,
      provider: 'claude' as const,
      model,
      usage: {
        promptTokens: usage.input_tokens || 0,
        completionTokens: usage.output_tokens || 0,
        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      },
    };
  }

  private async chatClaudeCompletions(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions,
    apiKey: string,
    baseUrl: string
  ): Promise<ChatResponse> {
    const response = await fetch(buildApiUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.MODEL_TIMEOUT_MS || 120000)),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[Claude ${model} OpenAI-compatible] 调用失败 [${response.status}]: ${errorText}`);
    }
    const data = await parseJsonResponse(response, `Claude ${model} OpenAI-compatible`);
    const message = (data.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === 'string' ? message.content : '';
    const usage = (data.usage as Record<string, number>) || {};
    assertNonEmptyResponse(content, 'claude', model, usage.completion_tokens || 0);
    return {
      content,
      provider: 'claude',
      model,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
    };
  }

  /**
   * 快捷生成：system + user 两条消息
   */
  async generate(
    systemPrompt: string,
    userPrompt: string,
    options?: ChatOptions
  ): Promise<string> {
    const response = await this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options
    );
    return response.content;
  }
}

// 单例
let defaultClient: ModelClient | null = null;
export function getModelClient(): ModelClient {
  if (!defaultClient) {
    defaultClient = new ModelClient();
  }
  return defaultClient;
}

class ModelRequestError extends Error {
  constructor(message: string, readonly code: 'EMPTY_RESPONSE') {
    super(message);
    this.name = 'ModelRequestError';
  }
}

async function parseJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const trimmed = text.trimStart();

  if (!contentType.includes('json') && trimmed.startsWith('<')) {
    throw new Error(`[${label}] 返回了 HTML 而不是 JSON，请检查 base URL、模型接口类型或中转站登录状态`);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    const preview = text.slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`[${label}] 返回内容不是有效 JSON: ${error instanceof Error ? error.message : String(error)}; preview=${preview}`);
  }
}

function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ModelRequestError) return true;
  return isTransientTransportError(error);
}

function isRouteFailoverEligible(error: unknown): boolean {
  if (error instanceof ModelRequestError && error.code === 'EMPTY_RESPONSE') return true;
  if (isTransientTransportError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\[(?:400|404)\].*(?:model|unsupported)|model.*(?:not found|unsupported|unavailable)/i.test(message);
}

function isTransientTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /中转站上游暂不可用|fetch failed|ECONNRESET|ETIMEDOUT|TimeoutError|aborted|TRANSPORT|HTTP 408|HTTP 409|HTTP 429|HTTP 5\d\d|\[5\d\d\]|\[429\]/i.test(message);
}

function assertNonEmptyResponse(
  content: string,
  provider: ModelProvider,
  model: string,
  completionTokens: number
): void {
  if (content.trim()) return;
  throw new ModelRequestError(
    `${provider}/${model} completed with no visible content (completion_tokens=${completionTokens})`,
    'EMPTY_RESPONSE'
  );
}

function assertUsefulResponse(content: string, options: ChatOptions, model: string): void {
  if (process.env.MODEL_STRICT_OUTPUT === 'false') return;
  const normalized = content.trim();
  const minimum = options.minOutputChars ?? defaultMinOutputChars(options.task);
  if (normalized.length < minimum) {
    throw new ModelRequestError(
      `${model} returned a suspiciously short response (${normalized.length} chars; require ${minimum})`,
      'EMPTY_RESPONSE'
    );
  }
  if (/\b(?:as an ai language model|i cannot access|i can't access|cannot browse|无法访问|不能访问)\b/i.test(normalized)) {
    throw new ModelRequestError(
      `${model} returned a capability-refusal placeholder instead of doing the task`,
      'EMPTY_RESPONSE'
    );
  }
}

function defaultMinOutputChars(task: TaskType | undefined): number {
  switch (task) {
    case 'discovery':
    case 'protocol':
    case 'outline':
      return 800;
    case 'summary':
    case 'citation':
    case 'quality':
    case 'qualityCrossReview':
      return 400;
    case 'writing':
    case 'coherence':
    case 'polish':
      return 180;
    default:
      return 1;
  }
}

function useClaudeOpenAICompatibility(baseUrl: string): boolean {
  const configured = process.env.ANTHROPIC_API_MODE?.trim().toLowerCase();
  if (configured) return configured === 'openai-completions';
  return /code\.rayinai\.com/i.test(baseUrl);
}

function buildApiUrl(baseUrl: string, path: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}${path}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
