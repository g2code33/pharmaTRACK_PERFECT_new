/**
 * Local index of PharmaTRACK AI conversations.
 *
 * The conversation list is titles only. Message bodies are read once, when a
 * conversation is new or has changed, and kept in a compact index. Ordinary
 * search never calls a provider and never reloads every conversation.
 */
import * as idb from 'idb-keyval';
import { listConversations, loadConversation } from '../ai/conversations';
import { scoreQueryField, snippetAround, type SearchResult } from './search';
import { bumpSearchIndex } from './searchNotify';

const INDEX_KEY = 'pharmatrack_conversation_search';

interface ConvStamp {
  id: string;
  updatedAt: string;
}

interface ConvEntry {
  id: string;
  title: string;
  text: string;
  updatedAt: string;
  courseId?: string;
  topicId?: string;
  materialId?: string;
}

interface ConvFile {
  version: 1;
  stamps: ConvStamp[];
  entries: ConvEntry[];
}

let entries: ConvEntry[] = [];
let ready = false;
let inflight: Promise<void> | null = null;

const cap = (text: string): string => {
  if (text.length <= 12000) return text;
  const head = text.slice(0, 8000);
  const words = text.slice(8000).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return `${head}\n${[...new Set(words)].slice(0, 400).join(' ')}`;
};

export async function ensureConversationIndex(force = false): Promise<void> {
  if (ready && !force) return;
  if (inflight && !force) return inflight;
  const run = (async () => {
    const metas = await listConversations();
    let cached: ConvFile | null = null;
    if (!force) {
      try { cached = (await idb.get<ConvFile>(INDEX_KEY)) ?? null; } catch { cached = null; }
    }
    const cachedById = new Map((cached?.entries ?? []).map((e) => [e.id, e]));
    const same = !!cached
      && cached.stamps.length === metas.length
      && metas.every((m) => cached!.stamps.some((s) => s.id === m.id && s.updatedAt === m.updatedAt));
    if (same && cached) {
      entries = cached.entries;
      ready = true;
      bumpSearchIndex();
      return;
    }

    const next: ConvEntry[] = [];
    for (const meta of metas) {
      const prev = cachedById.get(meta.id);
      if (!force && prev && prev.updatedAt === meta.updatedAt) {
        next.push(prev);
        continue;
      }
      const conv = await loadConversation(meta.id);
      if (!conv) continue;
      const text = conv.messages.map((m) => m.content || '').filter(Boolean).join('\n');
      if (!text.trim() && !conv.title) continue;
      next.push({
        id: conv.id,
        title: conv.title || 'AI conversation',
        text: cap(text),
        updatedAt: conv.updatedAt,
        courseId: conv.courseId,
        topicId: conv.topicId,
        materialId: conv.materialId,
      });
    }
    entries = next;
    ready = true;
    try {
      await idb.set(INDEX_KEY, {
        version: 1,
        stamps: next.map((e) => ({ id: e.id, updatedAt: e.updatedAt })),
        entries: next,
      } satisfies ConvFile);
    } catch (err) {
      console.error('Could not save the conversation search index:', err);
    }
    bumpSearchIndex();
  })().finally(() => { inflight = null; });
  inflight = run;
  return run;
}

export function searchConversations(rawQuery: string, limit = 12): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2 || entries.length === 0) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  const hits: SearchResult[] = [];
  for (const conv of entries) {
    const score = Math.max(
      scoreQueryField(conv.title, terms, 40),
      scoreQueryField(conv.text, terms, 32),
    );
    if (score <= 0) continue;
    const params = new URLSearchParams({ conversation: conv.id });
    if (conv.topicId) params.set('topic', conv.topicId);
    if (conv.courseId) params.set('course', conv.courseId);
    if (conv.materialId) params.set('material', conv.materialId);
    hits.push({
      id: `conv-${conv.id}`,
      title: conv.title,
      category: 'Chat',
      link: `/ai?${params.toString()}`,
      snippet: snippetAround(conv.text, terms[0]) || conv.title,
      score,
      scope: 'current',
      semesterKey: 'current',
      courseId: conv.courseId,
      topicId: conv.topicId,
      materialId: conv.materialId,
      materialType: 'chat',
      action: 'Open conversation',
      date: conv.updatedAt,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function __resetConversationIndex(): void {
  entries = [];
  ready = false;
  inflight = null;
}
