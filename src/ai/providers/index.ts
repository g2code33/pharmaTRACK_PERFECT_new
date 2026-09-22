/**
 * PharmaTRACK AI Engine — provider registry.
 *
 * `PROVIDER_PRESETS` is what the UI renders in AI Settings; `adapterFor(config)`
 * is how the manager turns a stored provider into something that can talk on the
 * wire. Neither is a switch statement over brand names sprinkled through the
 * app: adding a provider is either a preset (OpenAI-compatible protocols share
 * one adapter) or one new adapter file registered here.
 */
import type { AIProtocol, ProviderConfig, ProviderKind } from '../types';
import type { ProviderAdapter } from './base';
import { createOpenAICompatibleAdapter, OPENAI_COMPATIBLE_DEFAULTS } from './openaiCompatible';
import { GeminiAdapter } from './gemini';
import { AnthropicAdapter } from './anthropic';

export { OpenAICompatibleAdapter, createOpenAICompatibleAdapter, OPENAI_COMPATIBLE_DEFAULTS } from './openaiCompatible';
export { GeminiAdapter } from './gemini';
export { AnthropicAdapter } from './anthropic';
export type { CallContext, ProviderAdapter, RawCompletion } from './base';

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  protocol: AIProtocol;
  /** Empty for custom providers: the user must supply one. */
  baseUrl: string;
  /** Where to get a key (shown as a link in Settings). */
  keyUrl?: string;
  /** True for OpenAI-compatible services the user can point anywhere. */
  configurableBaseUrl?: boolean;
  /** Reject models the protocol cannot express (Anthropic needs max_tokens). */
  needsMaxTokens?: boolean;
  /** Discovery is not available everywhere; then models are typed/pasted. */
  supportsModelList: boolean;
  hint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    kind: 'nvidia',
    label: 'NVIDIA',
    protocol: 'openai-compatible',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.nvidia.baseUrl,
    keyUrl: 'https://build.nvidia.com',
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'NVIDIA NIM / build.nvidia.com. Keys start with nvapi-.',
  },
  {
    kind: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.openai.baseUrl,
    keyUrl: 'https://platform.openai.com/api-keys',
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'Keys start with sk-. Supports organization/project headers.',
  },
  {
    kind: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.gemini?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    supportsModelList: true,
    hint: 'Google AI Studio keys start with AIza. Large context, good for whole-chapter material.',
  },
  {
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    supportsModelList: true,
    needsMaxTokens: true,
    hint: 'Claude keys start with sk-ant-. A max output token count is always sent.',
  },
  {
    kind: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.groq.baseUrl,
    keyUrl: 'https://console.groq.com/keys',
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'Very fast inference. OpenAI-compatible API.',
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.openrouter.baseUrl,
    keyUrl: 'https://openrouter.ai/keys',
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'One key, many vendors. Model ids look like vendor/model.',
  },
  {
    kind: 'mistral',
    label: 'Mistral',
    protocol: 'openai-compatible',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.mistral.baseUrl,
    keyUrl: 'https://console.mistral.ai/api-keys',
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'Mistral La Plateforme. Pixtral models can read images.',
  },
  {
    kind: 'custom',
    label: 'Custom (OpenAI compatible)',
    protocol: 'openai-compatible',
    baseUrl: '',
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'Any service that speaks /chat/completions: a university gateway, Together, Fireworks, vLLM…',
  },
  {
    kind: 'local',
    label: 'Local model (future)',
    protocol: 'openai-compatible',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.local.baseUrl,
    configurableBaseUrl: true,
    supportsModelList: true,
    hint: 'Ollama / llama.cpp / LM Studio expose an OpenAI-compatible endpoint. Offline capable when it runs on this device.',
  },
];

export const presetFor = (kind: ProviderKind): ProviderPreset =>
  PROVIDER_PRESETS.find((p) => p.kind === kind) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];

export const labelForKind = (kind: ProviderKind): string => presetFor(kind).label;

/** True when the protocol is served by the shared OpenAI-compatible adapter. */
const OPENAI_COMPATIBLE_KINDS: ProviderKind[] = ['nvidia', 'openai', 'groq', 'openrouter', 'mistral', 'custom', 'local'];

const adapters = new Map<ProviderKind, ProviderAdapter>();

/**
 * Returns the adapter for a config. Protocol decides the implementation, so a
 * custom provider immediately behaves like every other OpenAI-compatible one.
 */
export function adapterFor(config: Pick<ProviderConfig, 'kind' | 'protocol'>): ProviderAdapter {
  const key = OPENAI_COMPATIBLE_KINDS.includes(config.kind) ? config.kind : config.kind;
  const cached = adapters.get(key);
  if (cached) return cached;

  const adapter: ProviderAdapter =
    config.protocol === 'gemini'
      ? new GeminiAdapter()
      : config.protocol === 'anthropic'
        ? new AnthropicAdapter()
        : createOpenAICompatibleAdapter(config.kind);

  adapters.set(key, adapter);
  return adapter;
}

/** Protocol for a kind, so a hand-made config is still routed correctly. */
export function protocolForKind(kind: ProviderKind): AIProtocol {
  return presetFor(kind).protocol;
}
