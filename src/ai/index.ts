/**
 * PharmaTRACK AI Engine — public API.
 *
 * Features should import from here (`../ai`) and never from an adapter. If a
 * component ever needs to know which provider it is talking to, something has
 * leaked and belongs back in this layer.
 *
 *   PharmaTRACK UI → AIManager → ProviderAdapter → provider → model
 */
export * from './types';
export { aiManager, AIManager, onAIStatus } from './manager';
export { AIEngineError, reportFor, redactSecrets, normalizeError, categoryForStatus } from './errors';
export {
  PROVIDER_PRESETS,
  presetFor,
  labelForKind,
  protocolForKind,
  adapterFor,
} from './providers';
export { resolveModelInfo, lookupModel, MODEL_SUGGESTIONS } from './models';
export { PROFILE_IDS, PRESET_PROFILES, defaultProfile, profileById } from './profiles';
export {
  AI_SETTINGS_KEY,
  AI_SETTINGS_VERSION,
  clearAISettings,
  createProviderConfig,
  defaultSettings,
  findLegacyKey,
  loadAISettings,
  mergeModels,
  migrateLegacySettings,
  modelOptions,
  normalizeSettings,
  providerForLegacyKey,
  saveAISettings,
} from './settings';
export {
  clearAllCredentials,
  deleteCredentials,
  loadAllCredentials,
  loadCredentials,
  looksLikeApiKey,
  maskKey,
  saveCredentials,
  scrubSecretsDeep,
  stripCredentials,
} from './credentials';
export {
  appendMessage,
  clearConversations,
  deleteConversation,
  listConversations,
  loadConversation,
  newConversation,
  provenance,
  replaceMessage,
  saveConversation,
  sourcesSummary,
} from './conversations';
export type { ConversationMeta, NewConversationInput } from './conversations';
export { buildContext, applyBudget, DEFAULT_CONTEXT_BUDGET } from './context/builder';
export { estimateTokens, truncateToTokens, formatTokens } from './context/tokens';
export type { AppStateLike, ContextSelection, RetrievalHit } from './context/types';
export { chunkMaterial, lexicalIndex, rankChunks, retrieve, tokenize } from './retrieval';
export type { RetrievalIndex, RetrievalQuery, RetrievalSource, RetrievedChunk } from './retrieval';
export { AI_TASKS, buildTaskRequest, taskById, taskPrompt, tasksInGroup } from './tasks';
export type { AITaskDefinition, AITaskId } from './tasks';
