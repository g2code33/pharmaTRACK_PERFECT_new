/**
 * PharmaTRACK AI Engine — provider adapter contract.
 *
 * An adapter owns exactly three things:
 *   1. how a request is spoken on the wire (protocol),
 *   2. which models it can offer (discovery or manual),
 *   3. how its errors are shaped.
 *
 * It does NOT own routing, fallback, retries, context building, storage or UI.
 * That separation is what keeps adding a provider a ~50-line file instead of a
 * rewrite — and what will let a local inference server drop in later.
 */
import type {
  AICapability,
  AIChatTurn,
  AICheckResult,
  AIConnectionTest,
  AIProtocol,
  AIRequest,
  AIResponse,
  AIStreamDelta,
  ModelInfo,
  ProviderConfig,
  ProviderKind,
} from '../types';

/**
 * Kinds that answer with no credentials at all: a model server running on this
 * device (Ollama, llama.cpp, LM Studio). Adapters read this so a keyless
 * endpoint is still probed instead of being reported as "missing API key".
 */
export const KEYLESS_KINDS: ProviderKind[] = ['local'];

/** True when this kind authenticates. This is the single source of truth. */
export function kindRequiresKey(kind: ProviderKind): boolean {
  return !KEYLESS_KINDS.includes(kind);
}

/** Everything an adapter needs for one call. */
export interface CallContext {
  config: ProviderConfig;
  /** Convenience: the resolved model id (config.model unless overridden). */
  model: string;
  /** Aborts when the user hits Stop or the timeout fires. */
  signal: AbortSignal;
}

/** What the adapter reads off the wire before normalisation. */
export interface RawCompletion {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}

export interface ProviderAdapter {
  /** Provider family this adapter serves. */
  readonly kind: ProviderConfig['kind'];
  /** Protocol spoken on the wire. */
  readonly protocol: AIProtocol;
  /** Default base URL, used to prefill Settings. */
  readonly defaultBaseUrl: string;
  /** Reasoning models reject `temperature`; the manager skips it when false. */
  readonly supportsTemperature: boolean;
  /**
   * What this protocol guarantees for ANY model behind it. Deliberately tiny:
   * everything else must come from the registry, model discovery or the user.
   */
  readonly baselineCapabilities: AICapability[];

  /** One non-streaming completion. */
  complete(ctx: CallContext, req: AIRequest): Promise<RawCompletion>;

  /** Streaming completion; adapters that cannot stream omit this. */
  stream?(ctx: CallContext, req: AIRequest): AsyncGenerator<AIStreamDelta>;

  /** Available models, when the provider exposes a list endpoint. */
  listModels?(ctx: CallContext): Promise<ModelInfo[]>;

  /**
   * Cheap "is this key/endpoint/model usable" probe. The adapter is not asked
   * to produce the *report* — the engine runs the same four checks for every
   * provider, so Test Connection behaves identically everywhere.
   */
  probe?(ctx: CallContext): Promise<AIConnectionTest['checks']>;
}

/* ------------------------------------------------------------------ */
/* Shared HTTP helpers (used by every adapter, in one place)          */
/* ------------------------------------------------------------------ */

export class HTTPError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
    /** Raw `Retry-After` header, when the provider sent one. */
    readonly retryAfter?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HTTPError';
  }
}

/** Normalises a base URL: no trailing slash, no duplicate /v1 segment. */
export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const raw = (baseUrl || '').trim() || fallback;
  return raw.replace(/\/+$/, '');
}

/** Joins a base URL with a path without doubling or dropping slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * `baseUrl` that already ends in the API version root (…/v1), so OpenAI-style
 * paths are appended straight on. Some users paste the full completions URL
 * into the custom provider — cope with that instead of doubling the path.
 */
export function apiRoot(baseUrl: string, version = 'v1'): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/(chat\/completions|completions|messages|responses)$/i.test(base)) return base;
  if (new RegExp(`/${version}$`, 'i').test(base)) return base;
  return `${base}/${version}`;
}

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Human message out of a provider JSON error body. */
export function errorMessageFrom(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const err = obj.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const message = (err as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof obj.message === 'string') return obj.message;
    if (Array.isArray(obj.errors) && obj.errors.length) {
      const first = obj.errors[0] as Record<string, unknown>;
      if (first && typeof first.message === 'string') return first.message;
    }
  }
  return fallback;
}

/**
 * Runs a fetch and throws `HTTPError` for non-2xx. Keeping this in one place
 * means every adapter reports the same shape, which is what makes the error
 * categorisation in ai/errors.ts trustworthy.
 */
export async function request(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The body holds the provider's own explanation ("Invalid API key"), and
    // the header tells us how long a rate limit lasts — both are needed by the
    // error normaliser, so they travel with the error instead of being lost.
    throw new HTTPError(res.status, body, undefined, res.headers?.get?.('retry-after') ?? undefined);
  }
  return res;
}

/** Concatenates system + user turns into one prompt (providers without roles). */
export function flattenMessages(messages: AIChatTurn[]): string {
  return messages.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content)).join('\n\n');
}

/** Tokens → rough report, used by the Test Connection panel. */
export function check(name: string, ok: boolean, detail: string): AICheckResult {
  return { name, ok, detail };
}

/** Type guard used by the manager to decide between complete() and stream(). */
export function responseOf(raw: RawCompletion, ctx: CallContext, streamed: boolean, latencyMs: number): Omit<AIResponse, 'attempts' | 'providerId' | 'model'> {
  return {
    content: raw.text,
    usage: raw.usage ? { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens } : undefined,
    latencyMs,
    streamed,
  };
}

/** Helper: `providerId:model` label used in status lines and chat metadata. */
export function modelLabel(providerId: string, model: string): string {
  return `${providerId} • ${model}`;
}
