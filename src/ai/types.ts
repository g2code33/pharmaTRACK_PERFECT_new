/**
 * PharmaTRACK AI Engine — core types.
 *
 * The whole point of this layer is that PharmaTRACK never talks to a *vendor*:
 * it talks to the engine, and the engine talks to a provider adapter. Provider
 * identity (NVIDIA), API protocol (openai-compatible), endpoint (base URL) and
 * model are four separate things — conflating them is what turns an app into a
 * single-provider chatbot.
 *
 *   UI → AIManager → ProviderAdapter → provider → model
 */

/* ------------------------------------------------------------------ */
/* Providers, protocols, capabilities                                 */
/* ------------------------------------------------------------------ */

/**
 * How the request is spoken on the wire. A provider *kind* (nvidia, groq,
 * mistral, custom…) usually shares a protocol with others, which is exactly
 * why adding a provider is normally configuration, not code.
 */
export type AIProtocol =
  | 'openai-compatible'
  | 'gemini'
  | 'anthropic'
  /** Reserved: Ollama / llama.cpp / LM Studio expose OpenAI-compatible HTTP. */
  | 'local';

/**
 * Provider presets PharmaTRACK ships with. `custom` covers any
 * OpenAI-compatible service. `local` is the on-device slot (Ollama, llama.cpp,
 * LM Studio) and still speaks that same HTTP protocol.
 */
export type ProviderKind =
  | 'nvidia'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'groq'
  | 'openrouter'
  | 'mistral'
  | 'custom'
  | 'local';

export type ProviderId = string;

/** Capabilities a task can ask for instead of naming a provider. */
export type AICapability =
  | 'text_generation'
  | 'streaming'
  | 'vision'
  | 'long_context'
  | 'structured_output'
  | 'tool_calling'
  | 'document_analysis';

export const AI_CAPABILITIES: AICapability[] = [
  'text_generation',
  'streaming',
  'vision',
  'long_context',
  'structured_output',
  'tool_calling',
  'document_analysis',
];

/** Human labels for the capability chips in Settings / routing UI. */
export const CAPABILITY_LABELS: Record<AICapability, string> = {
  text_generation: 'Text generation',
  streaming: 'Streaming',
  vision: 'Vision (images)',
  long_context: 'Long context',
  structured_output: 'Structured output',
  tool_calling: 'Tool calling',
  document_analysis: 'Document analysis',
};

/**
 * Where a capability claim came from. Only `registry`, `provider` (model
 * discovery) and `user` are *established*; `assumed` is the never-invented
 * baseline and is surfaced as "not established" in the UI.
 */
export type CapabilitySource = 'registry' | 'provider' | 'user' | 'assumed';

export interface ModelInfo {
  id: string;
  label?: string;
  /** Context window in tokens, when published/known. */
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: AICapability[];
  source: CapabilitySource;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

/**
 * One configured provider. Everything here is non-secret EXCEPT `apiKey`,
 * `organization`, `project` and `headers`, which live in a separate credential
 * store (see ai/credentials.ts) so that no serialiser can leak them by accident.
 */
export interface ProviderConfig {
  id: ProviderId;
  kind: ProviderKind;
  /** Display name; editable for custom providers. */
  label: string;
  protocol: AIProtocol;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /**
   * SECRET. Never persisted with the rest of the configuration: it is split
   * into the credential store on save and re-attached on load (see
   * ai/credentials.ts). Anything that serialises AI settings must go through
   * `toPersistedSettings()`.
   */
  apiKey?: string;
  /** Extra headers for gateways that need them (custom providers). SECRET-ish. */
  headers?: Record<string, string>;
  organization?: string;
  project?: string;
  /** Prefer streaming when the provider and model support it. */
  streaming: boolean;
  /**
   * 1-based rank. Lower is tried first for capability routing and fallback.
   * Kept in step with `AISettings.providerPriority`.
   */
  priority?: number;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
  /** User-declared capability override (kept alongside, never replaces, the registry). */
  declaredCapabilities?: AICapability[];
  /** User-declared context window override (tokens). */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Models discovered from the provider or added by hand. */
  models?: ModelInfo[];
  /** Result of the last "Test connection" run. */
  lastTest?: AIConnectionTest;
  /** Set when the config was created by migrating the legacy single key. */
  migratedFrom?: string;
}

/** A named AI configuration: which provider/model, how, and what to fall back to. */
export interface AIProfile {
  id: string;
  name: string;
  providerId: ProviderId;
  /** Overrides the provider's default model for this profile. */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  systemInstructions?: string;
  /** Soft cap for context sent with a request, in tokens. */
  contextLimitTokens?: number;
  /** Capabilities this profile's tasks require (drives routing). */
  capabilities?: AICapability[];
  /** Ordered fallback providers, tried when the primary fails. */
  fallbacks: ProviderId[];
  /** Per-profile opt-out of automatic fallback. */
  useFallback: boolean;
}

export interface AISettings {
  version: number;
  providers: ProviderConfig[];
  profiles: AIProfile[];
  activeProfileId: string;
  /** Global switch for the fallback system. */
  automaticFallback: boolean;
  /** Order used when a request asks for a capability instead of a provider. */
  providerPriority: ProviderId[];
  /** Privacy: only the context the user selected is ever sent. */
  sendSelectedContextOnly: boolean;
  /** Privacy: never include credentials in exports (always true; shown so the promise is visible). */
  excludeKeysFromBackups: boolean;
}

/* ------------------------------------------------------------------ */
/* Requests / responses                                               */
/* ------------------------------------------------------------------ */

export interface AIChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** An image handed to a vision-capable model. */
export interface AIImageInput {
  mimeType: string;
  /** Base64 payload without the data-URL prefix. */
  data: string;
}

export interface AIRequest {
  messages: AIChatTurn[];
  /** Explicit provider (wins over profile/capability routing). */
  providerId?: ProviderId;
  profileId?: string;
  /** Ask for a capability rather than a provider. */
  capability?: AICapability;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  stream?: boolean;
  images?: AIImageInput[];
  /** Redacts this key from any surfaced error text. */
  redactExtra?: string[];
  /** Cancellation, wired to the Stop button. */
  signal?: AbortSignal;
  /** Identifies the run so it can be cancelled by id. */
  runId?: string;
  /** Extra context blocks (already built by the context builder). */
  context?: AIContextBundle;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AIFallbackNotice {
  requestedProvider: ProviderId;
  requestedModel?: string;
  usedProvider: ProviderId;
  usedModel: string;
  /** Category of the failure that triggered the switch. */
  reason: AIErrorCategory;
  /** Human sentence, e.g. "NVIDIA unavailable. Switched to Gemini fallback." */
  message: string;
  attempts: string[];
}

export interface AIAttempt {
  providerId: ProviderId;
  model: string;
  ok: boolean;
  /** Error category when !ok. */
  category?: AIErrorCategory;
  message?: string;
  latencyMs?: number;
  streamed?: boolean;
}

export interface AIResponse {
  content: string;
  providerId: ProviderId;
  model: string;
  requestedProvider?: ProviderId;
  fallback?: AIFallbackNotice;
  usage?: AIUsage;
  latencyMs: number;
  streamed: boolean;
  attempts: AIAttempt[];
  /** Context actually sent (for the transparency line under a reply). */
  usedContext?: AIContextSource[];
}

/* ------------------------------------------------------------------ */
/* Context (PharmaTRACK academic awareness)                            */
/* ------------------------------------------------------------------ */

export type AIContextKind =
  | 'student'
  | 'course'
  | 'topic'
  | 'material'
  | 'page'
  | 'slide'
  | 'selection'
  | 'notes'
  | 'objectives'
  | 'quiz'
  | 'study-plan'
  | 'highlights'
  | 'retrieval'
  | 'history'
  | 'clinical-case'
  | 'question';

export interface AIContextSource {
  kind: AIContextKind;
  label: string;
  courseId?: string;
  topicId?: string;
  materialId?: string;
  page?: number;
  slide?: number;
  /**
   * Human-readable academic provenance, carried through the whole pipeline so
   * an answer can be shown with the course, topic and material it came from
   * rather than only an opaque id.
   */
  courseName?: string;
  topicName?: string;
  materialTitle?: string;
  semester?: string;
  /** Characters contributed by this source (filled in by the builder). */
  chars?: number;
  truncated?: boolean;
}

export interface AIContextBlock {
  label: string;
  text: string;
  source: AIContextSource;
}

export interface AIContextBundle {
  blocks: AIContextBlock[];
  sources: AIContextSource[];
  /** Rough token estimate of everything in `blocks`. */
  estimatedTokens: number;
  truncated: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Streaming / status                                                 */
/* ------------------------------------------------------------------ */

export interface AIStreamDelta {
  text: string;
  /** Set when the provider reports token usage on its final event. */
  usage?: AIUsage;
}

export type AIStreamStatus = 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface AIStatusEvent {
  runId: string;
  status: AIStreamStatus;
  providerId?: ProviderId;
  model?: string;
  message?: string;
}

export type AIStatusListener = (event: AIStatusEvent) => void;

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

export type AIErrorCategory =
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'CONTEXT_TOO_LARGE'
  | 'PROVIDER_ERROR'
  | 'USER_CANCELLED'
  | 'UNKNOWN';

/** What the user sees for an error: a reason plus concrete things to check. */
export interface AIErrorReport {
  category: AIErrorCategory;
  title: string;
  reason: string;
  checks: string[];
  retryable: boolean;
  /** True when switching to another provider is worth attempting. */
  switchable: boolean;
  providerId?: ProviderId;
  status?: number;
}

/* ------------------------------------------------------------------ */
/* Connection testing / model listing                                 */
/* ------------------------------------------------------------------ */

export interface AICheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AIConnectionTest {
  providerId: ProviderId;
  model: string;
  ok: boolean;
  at: string;
  latencyMs?: number;
  /** Per-step results: credentials → endpoint → model → generation. */
  checks: AICheckResult[];
  /** Normalised report when ok === false. */
  error?: AIErrorReport;
  /** Sample of the model's reply (never contains credentials). */
  sample?: string;
}

/* ------------------------------------------------------------------ */
/* Conversations                                                      */
/* ------------------------------------------------------------------ */

export interface AIChatFallbackInfo {
  requestedProvider: ProviderId;
  usedProvider: ProviderId;
  reason: AIErrorCategory;
  message: string;
}

export interface AIChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  providerId?: ProviderId;
  model?: string;
  fallback?: AIChatFallbackInfo;
  error?: { category: AIErrorCategory; message: string };
  usage?: AIUsage;
  sources?: AIContextSource[];
  cancelled?: boolean;
}

export interface AIConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Academic scope, so history survives provider changes and stays findable. */
  courseId?: string;
  topicId?: string;
  materialId?: string;
  page?: number;
  slide?: number;
  providerId?: ProviderId;
  model?: string;
  messages: AIChatMessage[];
}
