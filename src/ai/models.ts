/**
 * PharmaTRACK AI Engine — model metadata and capability resolution.
 *
 * Capabilities are never guessed. This module is the conservative middle step
 * between what the *protocol* guarantees (every chat adapter can stream text),
 * what the *registry* publishes for a known model family, and what the *user*
 * declares for a model we have no data on:
 *
 *   protocol baseline  <  registry entry  <  user declaration
 *
 * A model nobody has heard of ends up with `source: 'assumed'` from the
 * protocol baseline only, and the UI renders that as “not established” instead
 * of pretending to know whether it can see images or call tools.
 */
import type { AICapability, ModelInfo, ProviderConfig, ProviderKind } from './types';

interface RegistryEntry {
  /** Matched against the model id, with and without a `vendor/` prefix. */
  match: RegExp;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: AICapability[];
}

const TEXT: AICapability[] = ['text_generation', 'streaming'];
const MODERN: AICapability[] = [
  'text_generation',
  'streaming',
  'vision',
  'structured_output',
  'tool_calling',
  'document_analysis',
];
const TEXT_TOOLS: AICapability[] = [
  'text_generation',
  'streaming',
  'structured_output',
  'tool_calling',
  'document_analysis',
];

const LONG_CONTEXT_TOKENS = 200_000;

/**
 * Published capability sets for well-known model families. Anything absent is
 * treated as unknown (see `resolveModelInfo`) — adding an entry here is a claim,
 * so entries stay limited to families whose capabilities are documented.
 */
const REGISTRY: RegistryEntry[] = [
  /* --- OpenAI ---------------------------------------------------- */
  { match: /^gpt-4o(-mini)?$/i, label: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: MODERN },
  { match: /^gpt-4\.1(-mini|-nano)?$/i, label: 'GPT-4.1', contextWindow: 1_000_000, maxOutputTokens: 32_768, capabilities: MODERN },
  { match: /^gpt-4-turbo/i, label: 'GPT-4 Turbo', contextWindow: 128_000, capabilities: MODERN },
  { match: /^o[34](-mini)?$/i, label: 'OpenAI reasoning model', contextWindow: 200_000, capabilities: TEXT_TOOLS },
  { match: /^gpt-3\.5-turbo/i, label: 'GPT-3.5 Turbo', contextWindow: 16_385, capabilities: TEXT },

  /* --- Anthropic ------------------------------------------------- */
  { match: /^claude-3-5-sonnet/i, label: 'Claude 3.5 Sonnet', contextWindow: LONG_CONTEXT_TOKENS, maxOutputTokens: 8_192, capabilities: MODERN },
  { match: /^claude-3-7-sonnet/i, label: 'Claude 3.7 Sonnet', contextWindow: LONG_CONTEXT_TOKENS, maxOutputTokens: 64_000, capabilities: MODERN },
  { match: /^claude-(sonnet|opus|haiku)-4/i, label: 'Claude 4', contextWindow: LONG_CONTEXT_TOKENS, maxOutputTokens: 32_000, capabilities: MODERN },
  { match: /^claude-3-(opus|sonnet|haiku)/i, label: 'Claude 3', contextWindow: LONG_CONTEXT_TOKENS, capabilities: MODERN },

  /* --- Google ---------------------------------------------------- */
  { match: /^gemini-2\.5-(pro|flash)/i, label: 'Gemini 2.5', contextWindow: 1_000_000, maxOutputTokens: 65_536, capabilities: MODERN },
  { match: /^gemini-2\.0-flash/i, label: 'Gemini 2.0 Flash', contextWindow: 1_000_000, maxOutputTokens: 8_192, capabilities: MODERN },
  { match: /^gemini-1\.5-(pro|flash)/i, label: 'Gemini 1.5', contextWindow: 1_000_000, capabilities: MODERN },

  /* --- Meta Llama (Groq / NVIDIA / OpenRouter / local) ----------- */
  { match: /^meta-llama\/llama-3\.2-1[01]b-vision/i, label: 'Llama 3.2 Vision', contextWindow: 128_000, capabilities: ['text_generation', 'streaming', 'vision'] },
  { match: /llama-3\.3-70b/i, label: 'Llama 3.3 70B', contextWindow: 128_000, capabilities: TEXT_TOOLS },
  { match: /llama-3\.1-(8b|70b|405b)/i, label: 'Llama 3.1', contextWindow: 128_000, capabilities: TEXT_TOOLS },
  { match: /llama-3\.2-(1b|3b)/i, label: 'Llama 3.2 small', contextWindow: 128_000, capabilities: TEXT },

  /* --- Mistral --------------------------------------------------- */
  { match: /^mistral-large/i, label: 'Mistral Large', contextWindow: 128_000, capabilities: TEXT_TOOLS },
  { match: /^mistral-small/i, label: 'Mistral Small', contextWindow: 128_000, capabilities: TEXT_TOOLS },
  { match: /^pixtral/i, label: 'Pixtral', contextWindow: 128_000, capabilities: ['text_generation', 'streaming', 'vision', 'tool_calling'] },
  { match: /^open-mixtral/i, label: 'Mixtral', contextWindow: 64_000, capabilities: TEXT_TOOLS },

  /* --- NVIDIA NIM ------------------------------------------------ */
  { match: /^nvidia\/(llama-3\.1-)?nemotron/i, label: 'Nemotron', contextWindow: 128_000, capabilities: TEXT_TOOLS },
  { match: /deepseek-r1/i, label: 'DeepSeek R1', contextWindow: 128_000, capabilities: TEXT_TOOLS },
  { match: /^qwen\/qwen2\.5/i, label: 'Qwen 2.5', contextWindow: 128_000, capabilities: TEXT_TOOLS },

  /* --- Other families seen behind gateways ----------------------- */
  { match: /^gemma-?2/i, label: 'Gemma 2', contextWindow: 8_192, capabilities: TEXT },
  { match: /^mixtral-8x7b/i, label: 'Mixtral 8x7B', contextWindow: 32_768, capabilities: TEXT_TOOLS },
];

/** Long enough to be worth the `long_context` capability. */
const LONG_CONTEXT_THRESHOLD = 100_000;

/**
 * Looks a model id up in the registry. Handles OpenRouter-style
 * `vendor/model` ids by retrying without the vendor prefix.
 */
export function lookupModel(modelId: string): ModelInfo | null {
  const id = (modelId || '').trim();
  if (!id) return null;
  const candidates = [id, id.includes('/') ? id.slice(id.indexOf('/') + 1) : ''];
  for (const entry of REGISTRY) {
    for (const candidate of candidates) {
      if (candidate && entry.match.test(candidate)) {
        const capabilities = new Set(entry.capabilities);
        if (entry.contextWindow && entry.contextWindow >= LONG_CONTEXT_THRESHOLD) {
          capabilities.add('long_context');
        }
        return {
          id,
          label: entry.label,
          contextWindow: entry.contextWindow,
          maxOutputTokens: entry.maxOutputTokens,
          capabilities: [...capabilities],
          source: 'registry',
        };
      }
    }
  }
  return null;
}

export interface ResolvedModel extends ModelInfo {
  /** Where each capability came from, so the UI can mark the unestablished ones. */
  capabilitySources: Partial<Record<AICapability, 'registry' | 'provider' | 'user'>>;
  /** True when nothing but the protocol baseline is known about this model. */
  unknown: boolean;
}

/**
 * Resolves everything known about `modelId` under `config`.
 * `baseline` is what the protocol guarantees (see providers/base.ts).
 */
export function resolveModelInfo(
  config: Pick<ProviderConfig, 'kind' | 'model' | 'declaredCapabilities' | 'contextWindow' | 'maxOutputTokens' | 'models'>,
  modelId: string,
  baseline: AICapability[],
): ResolvedModel {
  const id = (modelId || config.model || '').trim();
  const capabilitySources: ResolvedModel['capabilitySources'] = {};
  const capabilities = new Set<AICapability>();

  for (const cap of baseline) {
    capabilities.add(cap);
    capabilitySources[cap] = 'registry';
  }

  const fromList = config.models?.find((m) => m.id === id);
  if (fromList) {
    for (const cap of fromList.capabilities) {
      capabilities.add(cap);
      capabilitySources[cap] = fromList.source === 'user' ? 'user' : 'provider';
    }
    if (fromList.contextWindow) capabilitySources.long_context ??= 'provider';
  }

  const registered = lookupModel(id);
  if (registered) {
    for (const cap of registered.capabilities) {
      capabilities.add(cap);
      capabilitySources[cap] = 'registry';
    }
  }

  for (const cap of config.declaredCapabilities ?? []) {
    capabilities.add(cap);
    capabilitySources[cap] = 'user';
  }

  const contextWindow = config.contextWindow ?? fromList?.contextWindow ?? registered?.contextWindow;
  if (contextWindow && contextWindow >= LONG_CONTEXT_THRESHOLD) {
    capabilities.add('long_context');
    capabilitySources.long_context ??= config.contextWindow ? 'user' : registered ? 'registry' : 'provider';
  }

  const unknown = !registered && !fromList && !(config.declaredCapabilities?.length);

  return {
    id,
    label: fromList?.label ?? registered?.label,
    contextWindow,
    maxOutputTokens: config.maxOutputTokens ?? fromList?.maxOutputTokens ?? registered?.maxOutputTokens,
    capabilities: [...capabilities],
    source: unknown ? 'assumed' : registered ? 'registry' : 'user',
    capabilitySources,
    unknown,
  };
}

/** Capability list a provider is *known* to have (registry/provider/user only). */
export function establishedCapabilities(
  config: ProviderConfig,
  baseline: AICapability[],
): AICapability[] {
  const resolved = resolveModelInfo(config, config.model, baseline);
  return resolved.capabilities.filter((cap) => resolved.capabilitySources[cap] !== undefined);
}

/** True when the provider can be used for a capability right now. */
export function providerSupports(
  config: ProviderConfig,
  capability: AICapability,
  baseline: AICapability[],
): boolean {
  return resolvedCapabilities(config, baseline).has(capability);
}

/** Convenience Set wrapper used by the manager's routing. */
export function resolvedCapabilities(
  config: ProviderConfig,
  baseline: AICapability[],
): Set<AICapability> {
  return new Set(resolveModelInfo(config, config.model, baseline).capabilities);
}

/** Model suggestions shown in the settings dropdown per provider kind. */
export const MODEL_SUGGESTIONS: Record<ProviderKind, string[]> = {
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'meta/llama-3.1-8b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'deepseek-ai/deepseek-r1',
    'qwen/qwen2.5-72b-instruct',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash'],
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
  ],
  openrouter: [
    'openai/gpt-4o-mini',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.3-70b-instruct',
    'mistralai/mistral-large',
  ],
  mistral: ['mistral-large-latest', 'mistral-small-latest', 'pixtral-large-latest', 'open-mixtral-8x22b'],
  custom: [],
  local: ['llama3.1', 'qwen2.5:7b', 'phi3:mini', 'mistral:7b'],
};
