/**
 * PharmaTRACK AI Engine — Anthropic (Claude) adapter.
 *
 * Its own request format (`/v1/messages`, `system` as a top-level field,
 * `max_tokens` required, `x-api-key` + `anthropic-version` headers) and its own
 * streaming events (`content_block_delta`, `message_delta`). Anthropic requires
 * the browser-side `anthropic-dangerous-direct-browser-access` header for
 * direct calls, which is exactly the kind of detail that belongs in an adapter
 * and nowhere else.
 */
import type {
  AICapability,
  AIConnectionTest,
  AIRequest,
  AIStreamDelta,
  ModelInfo,
} from '../types';
import {
  HTTPError,
  check,
  errorMessageFrom,
  joinUrl,
  normalizeBaseUrl,
  readJson,
  request,
  type CallContext,
  type ProviderAdapter,
} from './base';
import { parseSse } from '../streaming';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const BASELINE: AICapability[] = ['text_generation', 'streaming'];
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic requires max_tokens; this is the fallback when none is requested. */
const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;
  readonly protocol = 'anthropic' as const;
  readonly defaultBaseUrl = DEFAULT_BASE;
  readonly supportsTemperature = true;
  readonly baselineCapabilities = BASELINE;

  private headers(config: { apiKey?: string }): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': ANTHROPIC_VERSION,
      // Required for direct browser → Anthropic calls (PharmaTRACK has no server).
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  private body(ctx: CallContext, req: AIRequest, stream: boolean): Record<string, unknown> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
    if (!messages.length) messages.push({ role: 'user', content: '(no message)' });
    const body: Record<string, unknown> = {
      model: ctx.model,
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return body;
  }

  async complete(ctx: CallContext, req: AIRequest) {
    const res = await request(joinUrl(normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE), '/messages'), {
      method: 'POST',
      headers: this.headers(ctx.config),
      body: JSON.stringify(this.body(ctx, req, false)),
      signal: ctx.signal,
    });
    const json = await readJson(res);
    const text = anthropicText(json);
    if (text === null) throw new HTTPError(200, JSON.stringify(json ?? {}), 'Claude returned no text content.');
    return { text, usage: anthropicUsage(json) };
  }

  async *stream(ctx: CallContext, req: AIRequest): AsyncGenerator<AIStreamDelta> {
    const res = await request(joinUrl(normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE), '/messages'), {
      method: 'POST',
      headers: this.headers(ctx.config),
      body: JSON.stringify(this.body(ctx, req, true)),
      signal: ctx.signal,
    });
    if (!res.body) {
      const json = await readJson(res);
      yield { text: anthropicText(json) ?? '', usage: anthropicUsage(json) };
      return;
    }
    for await (const event of parseSse(res.body)) {
      const payload = (event.data ?? {}) as Record<string, any>;
      const type = payload.type ?? event.event;
      if (type === 'error') {
        throw new HTTPError(200, JSON.stringify(payload), errorMessageFrom(payload, 'Claude stream error.'));
      }
      if (type === 'content_block_delta') {
        const text = payload.delta?.text ?? '';
        if (text) yield { text };
      } else if (type === 'message_delta' && payload.usage) {
        yield {
          text: '',
          usage: { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens },
        };
      }
    }
  }

  async listModels(ctx: CallContext): Promise<ModelInfo[]> {
    const res = await request(joinUrl(normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE), '/models?limit=100'), {
      method: 'GET',
      headers: this.headers(ctx.config),
      signal: ctx.signal,
    });
    const json = await readJson(res);
    const list = (json as { data?: Array<{ id?: string; display_name?: string }> })?.data;
    if (!Array.isArray(list)) return [];
    return list
      .map((m) => ({ id: String(m.id ?? ''), label: m.display_name, capabilities: [...BASELINE], source: 'provider' as const }))
      .filter((m) => m.id);
  }

  async probe(ctx: CallContext): Promise<AIConnectionTest['checks']> {
    const out: AIConnectionTest['checks'] = [];
    const base = normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE);
    out.push(check('Endpoint', /^https?:\/\//i.test(base), base));
    out.push(check('API key', Boolean(ctx.config.apiKey), ctx.config.apiKey ? 'Key present' : 'No API key set'));
    if (!ctx.config.apiKey) {
      out.push(check('Model availability', false, 'Skipped — add an API key first'));
      return out;
    }
    try {
      const res = await request(joinUrl(base, '/models?limit=100'), {
        method: 'GET',
        headers: this.headers(ctx.config),
        signal: ctx.signal,
      });
      const json = (await readJson(res)) as { data?: Array<{ id?: string }> };
      const ids = (json?.data ?? []).map((m) => String(m.id));
      const ok = !ids.length || ids.includes(ctx.model);
      out.push(
        check(
          'Model availability',
          ok,
          ok
            ? ids.length
              ? `${ctx.model} is available to this key (${ids.length} models listed).`
              : 'Claude did not list models; the model will be tried directly.'
            : `“${ctx.model}” is not in the model list — check the id (use “Fetch models”).`,
        ),
      );
    } catch (err) {
      const status = err instanceof HTTPError ? err.status : 0;
      out.push(
        check(
          'Model availability',
          false,
          status === 401 || status === 403 ? 'Authentication failed — check the API key.' : (err as Error).message,
        ),
      );
    }
    return out;
  }
}

function anthropicText(json: unknown): string | null {
  const content = (json as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return null;
  return content.filter((c) => c?.type === 'text' || typeof c?.text === 'string').map((c) => c.text ?? '').join('');
}

function anthropicUsage(json: unknown) {
  const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number } })?.usage;
  if (!usage) return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
