/**
 * PharmaTRACK AI Engine — centralised error handling.
 *
 * Every provider failure (HTTP status, aborted fetch, malformed JSON, provider
 * error payload) is normalised into an `AIEngineError` with a category, and
 * every category maps to something a pharmacy student can act on:
 *
 *   NVIDIA connection failed
 *   Reason: Authentication failed
 *   Check: • API key   • selected model   • endpoint
 *
 * Two rules are absolute here:
 *   1. an API key never appears in an error message, ever — `redactSecrets`
 *      scrubs any configured credential out of provider text before it is
 *      stored, shown or logged;
 *   2. a failure is never swallowed. The engine reports which provider failed
 *      and which one answered instead.
 */
import type { AIErrorCategory, AIErrorReport, ProviderId } from './types';
import { HTTPError } from './providers/base';

const CATEGORY_TITLES: Record<AIErrorCategory, string> = {
  AUTHENTICATION: 'Authentication failed',
  RATE_LIMIT: 'Rate limit reached',
  NETWORK: 'Network unavailable',
  TIMEOUT: 'Request timed out',
  MODEL_UNAVAILABLE: 'Model unavailable',
  INVALID_REQUEST: 'Request rejected',
  CONTEXT_TOO_LARGE: 'Context too large',
  PROVIDER_ERROR: 'Provider error',
  USER_CANCELLED: 'Generation stopped',
  UNKNOWN: 'Unexpected error',
};

/** Categories where retrying the same provider can plausibly succeed. */
const RETRYABLE: AIErrorCategory[] = ['RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'PROVIDER_ERROR'];

/** Categories where another configured provider should be tried. */
const SWITCHABLE: AIErrorCategory[] = [
  'AUTHENTICATION',
  'RATE_LIMIT',
  'NETWORK',
  'TIMEOUT',
  'MODEL_UNAVAILABLE',
  'PROVIDER_ERROR',
  'CONTEXT_TOO_LARGE',
];

export interface AIEngineErrorInit {
  category: AIErrorCategory;
  message: string;
  providerId?: ProviderId;
  status?: number;
  retryAfterMs?: number;
  /** Provider-supplied detail (already redacted). */
  detail?: string;
  cause?: unknown;
}

/** Every AI failure in the app is one of these. */
export class AIEngineError extends Error {
  readonly category: AIErrorCategory;
  readonly providerId?: ProviderId;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly detail?: string;
  readonly cause?: unknown;

  constructor(init: AIEngineErrorInit) {
    super(init.message);
    this.name = 'AIEngineError';
    this.category = init.category;
    this.providerId = init.providerId;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
    this.cause = init.cause;
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.category);
  }

  get switchable(): boolean {
    return SWITCHABLE.includes(this.category);
  }

  toReport(): AIErrorReport {
    return reportFor(this);
  }
}

/** Builds the user-facing report (title + reason + checks) for a failure. */
export function reportFor(err: AIEngineError): AIErrorReport {
  const provider = err.providerId ? err.providerId.toUpperCase() : 'The AI provider';
  const checks: string[] = [];
  let reason = err.message;
  // The engine raises some failures itself (no provider configured, nothing in
  // the chain can serve the request). Those messages already say exactly what
  // to do, so they must not be replaced by a generic per-category sentence.
  const engineMessage = err.status === undefined ? err.message : '';

  switch (err.category) {
    case 'AUTHENTICATION':
      reason = 'Authentication failed — the provider rejected the API key.';
      checks.push('API key (re-paste it in AI Settings)', 'selected model', 'endpoint / base URL');
      break;
    case 'RATE_LIMIT':
      reason = err.retryAfterMs
        ? `Rate limit reached — try again in about ${Math.ceil(err.retryAfterMs / 1000)}s.`
        : 'Rate limit reached — too many requests for this key.';
      checks.push('wait a moment and retry', 'a different model or key', 'your plan quota');
      break;
    case 'NETWORK':
      reason = 'The provider could not be reached. Check this device’s connection.';
      checks.push('internet connection', 'endpoint / base URL', 'offline mode (live AI needs the network)');
      break;
    case 'TIMEOUT':
      reason = 'The provider did not answer in time.';
      checks.push('connection speed', 'a smaller request or shorter context', 'a faster/smaller model');
      break;
    case 'MODEL_UNAVAILABLE':
      reason = engineMessage || 'The selected model is not available to this key.';
      checks.push('model id (fetch the model list)', 'the model is enabled for your account', 'provider access level');
      break;
    case 'INVALID_REQUEST':
      reason = engineMessage || 'The provider rejected the request format.';
      if (engineMessage) checks.push('a configured provider (Settings → AI)');
      else checks.push('selected model', 'endpoint / base URL', 'provider compatibility mode');
      break;
    case 'CONTEXT_TOO_LARGE':
      reason = 'The material sent for this question is larger than the model accepts.';
      checks.push('shorter material selection (a page or slide)', 'a longer-context model', 'the context limit in AI Settings');
      break;
    case 'USER_CANCELLED':
      reason = 'Generation was stopped.';
      break;
    case 'PROVIDER_ERROR':
      reason = err.message || 'The provider reported an internal error.';
      checks.push('retry in a moment', 'a fallback provider', 'provider status page');
      break;
    default:
      checks.push('retry', 'the model id', 'the endpoint / base URL');
  }

  return {
    category: err.category,
    title: `${provider} — ${CATEGORY_TITLES[err.category]}`,
    reason,
    checks,
    retryable: err.retryable,
    switchable: err.switchable,
    providerId: err.providerId,
    status: err.status,
  };
}

/**
 * Removes credentials from arbitrary text. Provider error bodies love to echo
 * back headers and query strings, so every string that could contain a key is
 * passed through here before it is shown, stored or logged.
 */
export function redactSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join('[redacted]');
  }
  // Belt and braces for shapes we never issued but a proxy may have echoed.
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[redacted]');
  out = out.replace(/\b(AIza[A-Za-z0-9_-]{8,})/g, '[redacted]');
  out = out.replace(/([?&](?:key|api[_-]?key|apikey|access_token)=)[^&\s"']+/gi, '$1[redacted]');
  // Bearer first: the header rule below only consumes one whitespace-delimited
  // word, so running it first would leave the token itself in place.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]');
  out = out.replace(/((?:x-api-key|x-goog-api-key|authorization)["'\s:=]+)[^\s"',}]+/gi, '$1[redacted]');
  return out;
}

/** Reads a `Retry-After` value (seconds or HTTP date) as milliseconds. */
export function retryAfterMsFrom(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** Reads `Retry-After` (seconds or HTTP date) from a response, as ms. */
export function retryAfterFrom(res: Response | undefined): number | undefined {
  if (!res || typeof res.headers?.get !== 'function') return undefined;
  return retryAfterMsFrom(res.headers.get('retry-after'));
}

/** Maps an HTTP status to a category. Exported for direct testing. */
export function categoryForStatus(status: number): AIErrorCategory {
  if (status === 401 || status === 403) return 'AUTHENTICATION';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 413) return 'CONTEXT_TOO_LARGE';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (status >= 500) return 'PROVIDER_ERROR';
  return 'UNKNOWN';
}

/**
 * Best-effort category from a provider's JSON error body, since some services
 * answer 400 for a missing model and 404 for a bad route.
 */
function categoryFromBody(status: number, body: string): AIErrorCategory {
  const text = body.toLowerCase();
  if (/model[_ ]?not[_ ]?found|unknown model|no such model|model.*does not exist|invalid model/.test(text)) {
    return 'MODEL_UNAVAILABLE';
  }
  if (/api key not valid|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication/.test(text)) {
    return 'AUTHENTICATION';
  }
  if (/quota|rate limit|too many requests|resource[_ ]exhausted/.test(text)) return 'RATE_LIMIT';
  if (/token|context length|too long|maximum context|payload too large/.test(text)) {
    if (status === 413 || /context|token/.test(text)) return 'CONTEXT_TOO_LARGE';
  }
  return categoryForStatus(status);
}

export interface NormalizeContext {
  providerId?: ProviderId;
  /** Credentials to scrub out of any message that came from the provider. */
  secrets?: (string | undefined)[];
  /** True when the request was stopped on purpose. */
  cancelled?: boolean;
  /** True when the abort came from our own timeout timer. */
  timedOut?: boolean;
}

/** Pulls the human-readable message out of a provider error body. */
function messageFromBody(parsed: unknown, fallback: string): string {
  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
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
 * Turns anything thrown while talking to a provider into an `AIEngineError`.
 * This is the only place that decides a category, so behaviour is identical
 * across OpenAI, Gemini, Anthropic, Groq, OpenRouter, Mistral, NVIDIA and any
 * custom endpoint.
 */
export async function normalizeError(
  err: unknown,
  ctx: NormalizeContext = {},
): Promise<AIEngineError> {
  if (err instanceof AIEngineError) return err;

  const secrets = ctx.secrets;

  if (ctx.cancelled) {
    return new AIEngineError({
      category: 'USER_CANCELLED',
      message: 'Generation stopped by the user.',
      providerId: ctx.providerId,
      cause: err,
    });
  }

  if (ctx.timedOut) {
    return new AIEngineError({
      category: 'TIMEOUT',
      message: 'The provider did not answer before the request timeout.',
      providerId: ctx.providerId,
      cause: err,
    });
  }

  const name = (err as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new AIEngineError({
      category: name === 'TimeoutError' ? 'TIMEOUT' : 'USER_CANCELLED',
      message: name === 'TimeoutError' ? 'The request timed out.' : 'Generation was stopped.',
      providerId: ctx.providerId,
      cause: err,
    });
  }

  // A Response that was not ok: read the body for the real reason.
  if (typeof Response !== 'undefined' && err instanceof Response) return errorFromResponse(err, ctx);

  // An HTTPError raised by `request()` after it already read the body. This is
  // the common path for real providers (401/404/429/5xx), and getting it wrong
  // here is exactly what would silently disable the fallback system.
  if (err instanceof HTTPError) {
    const status = err.status;
    const category: AIErrorCategory =
      status >= 200 && status < 300 ? 'PROVIDER_ERROR' : categoryFromBody(status, err.body);
    let parsed: unknown = err.body;
    try {
      parsed = JSON.parse(err.body);
    } catch {
      /* keep raw text */
    }
    const fallbackMessage = status >= 200 && status < 300 ? 'The provider returned no usable content.' : `HTTP ${status}`;
    return new AIEngineError({
      category,
      message: redactSecrets(
        status >= 200 && status < 300 && err.message ? err.message : messageFromBody(parsed, fallbackMessage),
        secrets,
      ),
      providerId: ctx.providerId,
      status,
      retryAfterMs: category === 'RATE_LIMIT' ? retryAfterMsFrom(err.retryAfter) : undefined,
      detail: redactSecrets(err.body.slice(0, 500), secrets),
      cause: err,
    });
  }

  if (err instanceof TypeError) {
    // fetch() rejects with TypeError for DNS/offline/CORS problems.
    return new AIEngineError({
      category: 'NETWORK',
      message: redactSecrets(err.message || 'The provider could not be reached.', secrets),
      providerId: ctx.providerId,
      cause: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new AIEngineError({
    category: 'UNKNOWN',
    message: redactSecrets(message || 'Unexpected AI error.', secrets),
    providerId: ctx.providerId,
    cause: err,
  });
}

/** Normalises a non-2xx HTTP response (reading its body for the reason). */
export async function errorFromResponse(
  res: Response,
  ctx: NormalizeContext = {},
): Promise<AIEngineError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* keep the raw text */
  }
  const category = categoryFromBody(res.status, body);
  const clean = redactSecrets(messageFromBody(parsed, `HTTP ${res.status}`), ctx.secrets);
  return new AIEngineError({
    category,
    message: clean,
    providerId: ctx.providerId,
    status: res.status,
    retryAfterMs: category === 'RATE_LIMIT' ? retryAfterFrom(res) : undefined,
    detail: redactSecrets(body.slice(0, 500), ctx.secrets),
  });
}

/** Never let a console line carry a credential (used by the engine's logs). */
export function safeLog(message: string, secrets: (string | undefined)[] = []): string {
  return redactSecrets(message, secrets);
}
