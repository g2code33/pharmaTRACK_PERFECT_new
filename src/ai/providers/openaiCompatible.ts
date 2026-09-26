/**
 * PharmaTRACK AI Engine — the OpenAI-compatible adapter.
 *
 * One adapter serves OpenAI itself, NVIDIA NIM, Groq, OpenRouter, Mistral and
 * every "Custom OpenAI-compatible" endpoint, because they speak the same
 * protocol (`POST {base}/chat/completions`). Provider *identity* is data
 * (label, base URL, model, optional org/project headers) — that is the whole
 * point of separating identity from protocol.
 */
import type {
  AICapability,
  AIConnectionTest,
  AIRequest,
  AIStreamDelta,
  ModelInfo,
  ProviderConfig,
  ProviderKind,
} from '../types';
import {
  HTTPError,
  apiRoot,
  check,
  errorMessageFrom,
  joinUrl,
  kindRequiresKey,
  normalizeBaseUrl,
  readJson,
  request,
  type CallContext,
  type ProviderAdapter,
} from './base';
import { parseSse, usageFrom } from '../streaming';

/** Protocol baseline: `/chat/completions` always returns text and can stream. */
const BASELINE: AICapability[] = ['text_generation', 'streaming'];

export const OPENAI_COMPATIBLE_DEFAULTS: Record<string, { baseUrl: string; label: string }> = {
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', label: 'NVIDIA' },
  openai: { baseUrl: 'https://api.openai.com/v1', label: 'OpenAI' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', label: 'Groq' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', label: 'Mistral' },
  custom: { baseUrl: '', label: 'Custom (OpenAI compatible)' },
  local: { baseUrl: 'http://localhost:11434/v1', label: 'Local model' },
};

/** Models some providers reject without an explicit temperature. */
function temperatureSupported(model: string): boolean {
  return !/^(o[1-9]|gpt-5)/i.test(model);
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  readonly protocol = 'openai-compatible' as const;
  readonly defaultBaseUrl: string;
  readonly supportsTemperature = true;
  readonly baselineCapabilities = BASELINE;

  constructor(kind: ProviderKind) {
    this.kind = kind;
    this.defaultBaseUrl = OPENAI_COMPATIBLE_DEFAULTS[kind]?.baseUrl ?? '';
  }

  /** Base (…/v1) and, when the user pasted a full path, that exact URL. */
  private urls(config: ProviderConfig): { root: string; completions: string; models: string } {
    const base = normalizeBaseUrl(config.baseUrl, this.defaultBaseUrl);
    const root = apiRoot(base);
    if (/\/(chat\/completions)$/i.test(base)) {
      return {
        root,
        completions: base,
        models: joinUrl(base.replace(/\/chat\/completions$/i, ''), '/models'),
      };
    }
    return { root, completions: joinUrl(root, '/chat/completions'), models: joinUrl(root, '/models') };
  }

  private headers(config: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey ?? ''}`,
    };
    if (config.organization) headers['OpenAI-Organization'] = config.organization;
    if (config.project) headers['OpenAI-Project'] = config.project;
    // OpenRouter asks for these; harmless everywhere else.
    if (config.kind === 'openrouter') {
      headers['HTTP-Referer'] = 'https://pharmatrack.app';
      headers['X-Title'] = 'PharmaTRACK';
    }
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (key && value) headers[key] = value;
    }
    return headers;
  }

  private body(ctx: CallContext, req: AIRequest, stream: boolean): Record<string, unknown> {
    const messages = req.messages.map((m) => {
      if (!req.images?.length || m.role !== 'user') return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...req.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          })),
        ],
      };
    });
    const body: Record<string, unknown> = { model: ctx.model, messages, stream };
    if (stream) body.stream_options = { include_usage: true };
    if (req.temperature !== undefined && temperatureSupported(ctx.model)) {
      body.temperature = req.temperature;
    }
    if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
    return body;
  }

  async complete(ctx: CallContext, req: AIRequest) {
    const { completions } = this.urls(ctx.config);
    const res = await request(completions, {
      method: 'POST',
      headers: this.headers(ctx.config),
      body: JSON.stringify(this.body(ctx, req, false)),
      signal: ctx.signal,
    });
    const json = await readJson(res);
    const text = extractText(json);
    if (text === null) {
      throw new HTTPError(200, JSON.stringify(json ?? {}), 'The provider returned no message content.');
    }
    return { text, usage: usageFrom(json) };
  }

  async *stream(ctx: CallContext, req: AIRequest): AsyncGenerator<AIStreamDelta> {
    const { completions } = this.urls(ctx.config);
    const res = await request(completions, {
      method: 'POST',
      headers: this.headers(ctx.config),
      body: JSON.stringify(this.body(ctx, req, true)),
      signal: ctx.signal,
    });
    if (!res.body) {
      // A provider that ignores `stream: true` still returns usable JSON.
      const json = await readJson(res);
      const text = extractText(json) ?? '';
      yield { text, usage: usageFrom(json) };
      return;
    }
    let finishUsage: AIStreamDelta['usage'];
    for await (const event of parseSse(res.body)) {
      if (event.data === '[DONE]') break;
      if (typeof event.data === 'string') {
        if (event.data.trim()) yield { text: event.data };
        continue;
      }
      const json = event.data as Record<string, any>;
      // Some gateways report failures mid-stream as an error object.
      if (json?.error) throw new HTTPError(200, JSON.stringify(json), errorMessageFrom(json, 'Provider error during streaming.'));
      const choice = json?.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      const text = textOf(delta);
      finishUsage = usageFrom(json) ?? finishUsage;
      if (text) yield { text };
    }
    if (finishUsage) yield { text: '', usage: finishUsage };
  }

  async listModels(ctx: CallContext): Promise<ModelInfo[]> {
    const { models } = this.urls(ctx.config);
    const res = await request(models, { method: 'GET', headers: this.headers(ctx.config), signal: ctx.signal });
    const json = await readJson(res);
    const list = (json as { data?: Array<{ id?: string; name?: string; context_length?: number; context_window?: number }> })?.data;
    if (!Array.isArray(list)) return [];
    return list
      .map((m) => ({
        id: String(m.id ?? m.name ?? ''),
        contextWindow: m.context_length ?? m.context_window,
        capabilities: [...BASELINE],
        source: 'provider' as const,
      }))
      .filter((m) => m.id);
  }

  /**
   * Steps 1–3 of Test Connection for OpenAI-compatible providers. Step 4 (a
   * real generation) is run by the engine so every provider reports it the same
   * way.
   */
  async probe(ctx: CallContext): Promise<AIConnectionTest['checks']> {
    const out: AIConnectionTest['checks'] = [];
    const base = normalizeBaseUrl(ctx.config.baseUrl, this.defaultBaseUrl);
    out.push(
      check(
        'Endpoint',
        /^https?:\/\//i.test(base),
        /^https?:\/\//i.test(base)
          ? base
          : 'Set a base URL starting with http:// or https:// (use “Test connection” again after saving).',
      ),
    );
    const needsKey = kindRequiresKey(ctx.config.kind);
    out.push(
      check(
        'API key',
        Boolean(ctx.config.apiKey) || !needsKey,
        ctx.config.apiKey
          ? 'Key present'
          : needsKey
            ? 'No API key set'
            : 'No key needed — this is a local server on this device',
      ),
    );

    // A local server has no key, so it is still probed; only a genuinely
    // unusable endpoint (or a missing key where one is required) stops here.
    if (!/^https?:\/\//i.test(base) || (!ctx.config.apiKey && needsKey)) {
      out.push(check('Model availability', false, 'Skipped — fix the API key / endpoint first'));
      return out;
    }

    const { models } = this.urls(ctx.config);
    try {
      const res = await request(models, { method: 'GET', headers: this.headers(ctx.config), signal: ctx.signal });
      const json = await readJson(res);
      const list = (json as { data?: Array<{ id?: string }> })?.data ?? [];
      const ids = list.map((m) => String(m.id)).filter(Boolean);
      const wanted = ctx.model;
      if (!ids.length) {
        out.push(check('Model availability', true, 'The provider listing was empty; the model will be tried directly.'));
      } else if (ids.includes(wanted)) {
        out.push(check('Model availability', true, `${wanted} is offered by this provider (${ids.length} models listed).`));
      } else {
        out.push(
          check(
            'Model availability',
            false,
            `“${wanted}” was not in the provider's model list — check the model id (use “Fetch models”).`,
          ),
        );
      }
    } catch (err) {
      const status = err instanceof HTTPError ? err.status : 0;
      const detail = err instanceof HTTPError ? statusDetail(status, err.body) : (err as Error).message;
      out.push(check('Model availability', false, detail));
    }
    return out;
  }
}

function statusDetail(status: number, body: string): string {
  const clean = errorMessageFrom(safeJson(body), `HTTP ${status}`);
  if (status === 401 || status === 403) return `Authentication failed — ${clean}`;
  if (status === 404) return `No model list at this endpoint — ${clean}`;
  return `HTTP ${status} — ${clean}`;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Pulls text out of `choices[0].message.content` (string or content parts). */
function extractText(json: unknown): string | null {
  const choice = (json as { choices?: Array<{ message?: unknown; text?: string }> })?.choices?.[0];
  if (!choice) return null;
  const fromMessage = textOf(choice.message);
  if (fromMessage) return fromMessage;
  if (typeof choice.text === 'string') return choice.text;
  return null;
}

function textOf(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const obj = node as { content?: unknown; reasoning_content?: unknown };
  const content = obj.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string' ? part : typeof (part as { text?: string })?.text === 'string' ? (part as { text: string }).text : '',
      )
      .join('');
  }
  // Some reasoning models put the visible text in a separate field.
  if (typeof obj.reasoning_content === 'string') return obj.reasoning_content;
  return '';
}

/** Factory used by the provider registry. */
export function createOpenAICompatibleAdapter(kind: ProviderKind): ProviderAdapter {
  return new OpenAICompatibleAdapter(kind);
}
