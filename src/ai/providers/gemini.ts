/**
 * PharmaTRACK AI Engine — Google Gemini adapter.
 *
 * Different protocol, different streaming shape (`:streamGenerateContent` with
 * `alt=sse`), and — importantly — the API key travels in a header
 * (`x-goog-api-key`) rather than the `?key=` query string the legacy code used.
 * Keys in URLs end up in logs, proxies and browser history; the header form is
 * the one Google documents for server-side use and the one we ship.
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

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const BASELINE: AICapability[] = ['text_generation', 'streaming'];

export class GeminiAdapter implements ProviderAdapter {
  readonly kind = 'gemini' as const;
  readonly protocol = 'gemini' as const;
  readonly defaultBaseUrl = DEFAULT_BASE;
  readonly supportsTemperature = true;
  readonly baselineCapabilities = BASELINE;

  private url(ctx: CallContext, path: string): string {
    return joinUrl(normalizeBaseUrl(ctx.config.baseUrl, DEFAULT_BASE), path);
  }

  private headers(config: { apiKey?: string }): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey ?? '' };
  }

  private body(req: AIRequest): Record<string, unknown> {
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    // Gemini takes the system prompt out of band; if a caller only used system
    // turns we keep them as the first user turn instead of dropping them.
    if (!contents.length) {
      contents.push({ role: 'user', parts: [{ text: req.messages.map((m) => m.content).join('\n\n') }] });
    }
    if (req.images?.length) {
      const last = contents[contents.length - 1] as { parts: Array<Record<string, unknown>> };
      for (const img of req.images) {
        last.parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const body: Record<string, unknown> = { contents };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return body;
  }

  async complete(ctx: CallContext, req: AIRequest) {
    const res = await request(this.url(ctx, `/models/${encodeURIComponent(ctx.model)}:generateContent`), {
      method: 'POST',
      headers: this.headers(ctx.config),
      body: JSON.stringify(this.body(req)),
      signal: ctx.signal,
    });
    const json = await readJson(res);
    const text = geminiText(json);
    if (text === null) throw new HTTPError(200, JSON.stringify(json ?? {}), 'Gemini returned no candidate text.');
    return { text, usage: geminiUsage(json) };
  }

  async *stream(ctx: CallContext, req: AIRequest): AsyncGenerator<AIStreamDelta> {
    const res = await request(
      this.url(ctx, `/models/${encodeURIComponent(ctx.model)}:streamGenerateContent?alt=sse`),
      {
        method: 'POST',
        headers: this.headers(ctx.config),
        body: JSON.stringify(this.body(req)),
        signal: ctx.signal,
      },
    );
    if (!res.body) {
      const json = await readJson(res);
      yield { text: geminiText(json) ?? '', usage: geminiUsage(json) };
      return;
    }
    for await (const event of parseSse(res.body)) {
      if (typeof event.data === 'string') continue;
      const json = event.data as Record<string, any>;
      if (json?.error) throw new HTTPError(200, JSON.stringify(json), errorMessageFrom(json, 'Gemini stream error.'));
      const text = geminiText(json);
      if (text) yield { text };
      const usage = geminiUsage(json);
      if (usage) yield { text: '', usage };
    }
  }

  async listModels(ctx: CallContext): Promise<ModelInfo[]> {
    const res = await request(this.url(ctx, '/models?pageSize=200'), {
      method: 'GET',
      headers: this.headers(ctx.config),
      signal: ctx.signal,
    });
    const json = await readJson(res);
    const list = (json as { models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> })?.models;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({
        id: String(m.name ?? '').replace(/^models\//, ''),
        label: m.displayName,
        contextWindow: m.inputTokenLimit,
        capabilities: [
          ...BASELINE,
          ...(m.supportedGenerationMethods?.includes('streamGenerateContent') ? (['streaming'] as AICapability[]) : []),
        ],
        source: 'provider' as const,
      }))
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
      const res = await request(this.url(ctx, '/models?pageSize=200'), {
        method: 'GET',
        headers: this.headers(ctx.config),
        signal: ctx.signal,
      });
      const json = (await readJson(res)) as { models?: Array<{ name?: string }> };
      const ids = (json?.models ?? []).map((m) => String(m.name ?? '').replace(/^models\//, ''));
      const ok = ids.includes(ctx.model);
      out.push(
        check(
          'Model availability',
          ok,
          ok
            ? `${ctx.model} is available to this key (${ids.length} models listed).`
            : ids.length
              ? `“${ctx.model}” is not in the model list — check the id (use “Fetch models”).`
              : 'No models were listed for this key.',
        ),
      );
    } catch (err) {
      const status = err instanceof HTTPError ? err.status : 0;
      out.push(
        check(
          'Model availability',
          false,
          status === 401 || status === 403
            ? 'Authentication failed — check the API key.'
            : (err as Error).message,
        ),
      );
    }
    return out;
  }
}

function geminiText(json: unknown): string | null {
  const candidates = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  return parts.map((p) => p?.text ?? '').join('');
}

function geminiUsage(json: unknown) {
  const usage = (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })?.usageMetadata;
  if (!usage) return undefined;
  return { inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount };
}
