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
import { kindRequiresKey, type ProviderAdapter } from './base';
import { createOpenAICompatibleAdapter, OPENAI_COMPATIBLE_DEFAULTS } from './openaiCompatible';
import { GeminiAdapter } from './gemini';
import { AnthropicAdapter } from './anthropic';

export { OpenAICompatibleAdapter, createOpenAICompatibleAdapter, OPENAI_COMPATIBLE_DEFAULTS } from './openaiCompatible';
export { GeminiAdapter } from './gemini';
export { AnthropicAdapter } from './anthropic';
export type { CallContext, ProviderAdapter, RawCompletion } from './base';
export { KEYLESS_KINDS, kindRequiresKey } from './base';

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
  /** Shown in the key field. The panel does not branch on the provider name. */
  keyPlaceholder?: string;
  /** Extra settings fields. The panel renders these instead of switching on kind. */
  configFields?: Array<'organization' | 'project' | 'label'>;
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
    keyPlaceholder: 'nvapi-…',
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
    keyPlaceholder: 'sk-…',
    configFields: ['organization', 'project'],
    hint: 'Keys start with sk-. Supports organization/project headers.',
  },
  {
    kind: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.gemini?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    supportsModelList: true,
    keyPlaceholder: 'AIza…',
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
    keyPlaceholder: 'sk-ant-…',
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
    keyPlaceholder: 'API key',
    configFields: ['organization', 'project', 'label'],
    hint: 'Any service that speaks /chat/completions: a university gateway, Together, Fireworks, vLLM…',
  },
  {
    kind: 'local',
    label: 'Local model',
    protocol: 'local',
    baseUrl: OPENAI_COMPATIBLE_DEFAULTS.local.baseUrl,
    configurableBaseUrl: true,
    supportsModelList: true,
    keyPlaceholder: 'Optional — only if your local server asks for one',
    configFields: ['label'],
    hint: 'Ollama, llama.cpp or LM Studio on this device. They speak /chat/completions, usually at http://localhost:11434/v1. A key is optional. Another local runtime can be added as an adapter without changing the UI.',
  },
];

export const presetFor = (kind: ProviderKind): ProviderPreset =>
  PROVIDER_PRESETS.find((p) => p.kind === kind) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];

export const labelForKind = (kind: ProviderKind): string => presetFor(kind).label;

const adapters = new Map<ProviderKind, ProviderAdapter>();

/**
 * True when a kind authenticates. Local servers (Ollama, llama.cpp, LM Studio)
 * do not, and the same list drives the adapters, the settings screen and the
 * routing chain — see KEYLESS_KINDS in providers/base.ts.
 */
export function requiresKey(kind: ProviderKind): boolean {
  return kindRequiresKey(kind);
}

/**
 * Returns the adapter for a config. Protocol decides the implementation.
 * `local` is a provider *slot*, not a second API: Ollama and llama.cpp already
 * speak the OpenAI-compatible protocol, so they reuse that adapter. A future
 * on-device runtime that speaks something else is one new adapter file
 * registered here — the UI and the manager never change.
 */
export function adapterFor(config: Pick<ProviderConfig, 'kind' | 'protocol'>): ProviderAdapter {
  const cached = adapters.get(config.kind);
  if (cached) return cached;

  const adapter: ProviderAdapter =
    config.protocol === 'gemini' || config.kind === 'gemini'
      ? new GeminiAdapter()
      : config.protocol === 'anthropic' || config.kind === 'anthropic'
        ? new AnthropicAdapter()
        : createOpenAICompatibleAdapter(config.kind);

  adapters.set(config.kind, adapter);
  return adapter;
}

/** Protocol for a kind, so a hand-made config is still routed correctly. */
export function protocolForKind(kind: ProviderKind): AIProtocol {
  return presetFor(kind).protocol;
}
