/**
 * PharmaTRACK AI Engine — conversation store.
 *
 * Chat history is academic data, not provider data: it stores the provider and
 * model *per message* as metadata, so switching NVIDIA → Gemini never makes old
 * conversations unreadable (spec §17). It lives in IndexedDB because a
 * conversation with full lecture context is quickly larger than localStorage
 * should hold, and it is deliberately independent of AppState so AI usage never
 * bloats the state blob that gets backed up on every keystroke.
 */
import * as idb from 'idb-keyval';
import { v4 as uuidv4 } from 'uuid';
import type { AIChatFallbackInfo, AIChatMessage, AIConversation, AIContextSource } from './types';

const INDEX_KEY = 'pharmatrack_ai_conversations_index';
const convKey = (id: string) => `pharmatrack_ai_conversation_${id}`;

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  courseId?: string;
  topicId?: string;
  materialId?: string;
  providerId?: string;
  model?: string;
}

/** Newest first. Loaded without reading any conversation body. */
export async function listConversations(): Promise<ConversationMeta[]> {
  try {
    const index = ((await idb.get(INDEX_KEY)) as ConversationMeta[] | undefined) ?? [];
    return [...index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    console.error('AI conversation index could not be read:', err);
    return [];
  }
}

export async function loadConversation(id: string): Promise<AIConversation | null> {
  try {
    return ((await idb.get(convKey(id))) as AIConversation | undefined) ?? null;
  } catch (err) {
    console.error(`AI conversation ${id} could not be read:`, err);
    return null;
  }
}

async function writeIndex(index: ConversationMeta[]): Promise<void> {
  await idb.set(INDEX_KEY, index);
}

function metaOf(conv: AIConversation): ConversationMeta {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    courseId: conv.courseId,
    topicId: conv.topicId,
    materialId: conv.materialId,
    providerId: conv.providerId,
    model: conv.model,
  };
}

export interface NewConversationInput {
  title?: string;
  courseId?: string;
  topicId?: string;
  materialId?: string;
  page?: number;
  slide?: number;
  providerId?: string;
  model?: string;
}

export function newConversation(input: NewConversationInput = {}): AIConversation {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    title: input.title?.trim() || 'New conversation',
    createdAt: now,
    updatedAt: now,
    courseId: input.courseId,
    topicId: input.topicId,
    materialId: input.materialId,
    page: input.page,
    slide: input.slide,
    providerId: input.providerId,
    model: input.model,
    messages: [],
  };
}

export async function saveConversation(conv: AIConversation): Promise<void> {
  try {
    await idb.set(convKey(conv.id), conv);
    const index = ((await idb.get(INDEX_KEY)) as ConversationMeta[] | undefined) ?? [];
    const without = index.filter((m) => m.id !== conv.id);
    await writeIndex([metaOf(conv), ...without]);
  } catch (err) {
    console.error(`AI conversation ${conv.id} could not be saved:`, err);
  }
}

export async function deleteConversation(id: string): Promise<void> {
  try {
    await idb.del(convKey(id));
    const index = ((await idb.get(INDEX_KEY)) as ConversationMeta[] | undefined) ?? [];
    await writeIndex(index.filter((m) => m.id !== id));
  } catch (err) {
    console.error(`AI conversation ${id} could not be deleted:`, err);
  }
}

/** Used by “Clear ALL Data”; keys and academic data are cleared separately. */
export async function clearConversations(): Promise<void> {
  try {
    const index = ((await idb.get(INDEX_KEY)) as ConversationMeta[] | undefined) ?? [];
    for (const meta of index) await idb.del(convKey(meta.id));
    await idb.del(INDEX_KEY);
  } catch (err) {
    console.error('AI conversations could not be cleared:', err);
  }
}

/** Appends a message that was just generated (or failed). */
export function appendMessage(
  conv: AIConversation,
  message: Omit<AIChatMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: string },
): AIConversation {
  const next: AIChatMessage = {
    id: message.id ?? uuidv4(),
    role: message.role,
    content: message.content,
    timestamp: message.timestamp ?? new Date().toISOString(),
    providerId: message.providerId,
    model: message.model,
    fallback: message.fallback,
    error: message.error,
    usage: message.usage,
    sources: message.sources,
    cancelled: message.cancelled,
  };
  const messages = [...conv.messages, next];
  return {
    ...conv,
    messages,
    updatedAt: next.timestamp,
    // First user message titles the conversation, like every chat app does.
    title: conv.title === 'New conversation' && next.role === 'user'
      ? next.content.slice(0, 60)
      : conv.title,
    providerId: message.providerId ?? conv.providerId,
    model: message.model ?? conv.model,
  };
}

/** Rewrites the trailing assistant message (streaming updates in place). */
export function replaceMessage(
  conv: AIConversation,
  messageId: string,
  patch: Partial<AIChatMessage>,
): AIConversation {
  return {
    ...conv,
    messages: conv.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
    updatedAt: new Date().toISOString(),
  };
}

export function fallbackInfo(info: AIFallbackNoticeLike): AIChatFallbackInfo {
  return {
    requestedProvider: info.requestedProvider,
    usedProvider: info.usedProvider,
    reason: info.reason,
    message: info.message,
  };
}

type AIFallbackNoticeLike = {
  requestedProvider: string;
  usedProvider: string;
  reason: AIChatFallbackInfo['reason'];
  message: string;
};

/** Provenance line shown under an answer: “NVIDIA • model” or the fallback note. */
export function provenance(message: AIChatMessage): string | undefined {
  if (!message.providerId) return undefined;
  const model = message.model ? ` • ${message.model}` : '';
  return `${message.providerId.toUpperCase()}${model}`;
}

/** The source list a reply was built from, as one short sentence. */
export function sourcesSummary(sources: AIContextSource[] | undefined): string | undefined {
  if (!sources?.length) return undefined;
  const parts = sources.map((s) => s.label).filter(Boolean);
  return parts.length ? `Context: ${parts.join(' · ')}` : undefined;
}
