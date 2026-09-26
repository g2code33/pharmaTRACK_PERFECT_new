/**
 * PharmaTRACK AI Engine — the RAG pipeline, end to end.
 *
 *   Materials → Extraction → Chunking → Metadata → Local index → Retrieval → Context
 *
 * This is the only module the UI needs: it resolves academic metadata from app
 * state, keeps the index in sync, retrieves the passages that answer *this*
 * question, and hands back hits already carrying their source. The caller then
 * drops them into `ContextSelection.retrieval` and the model sees a bundle where
 * every passage is labelled with its course, topic, material and page/slide.
 *
 * Nothing here sends anything anywhere. Retrieval is local; the provider only
 * ever receives the handful of chunks that survived scoring.
 */
import type { AppStateLike, ContextSelection, RetrievalHit } from '../context/types';
import { loadRagIndex, searchIndex, syncIndex } from './index';
import { chunkSource } from './chunker';
import { sourceHeader } from './types';
import type { IndexableSource, IndexedChunk, RagHit, RagIndexShape } from './types';

export interface PipelineOptions {
  /** Text loader for materials whose full text lives in IndexedDB. */
  loadText?: (materialId: string) => Promise<string | null>;
  /** Reuse a pre-loaded index (tests, settings screen). */
  index?: RagIndexShape;
  /** Skip the sync pass and search `index` as-is. */
  skipSync?: boolean;
}

/**
 * Turns the app's material records into indexable sources with their academic
 * metadata resolved: semester, course (code + name), topic, material.
 */
export function indexableSources(state: AppStateLike): IndexableSource[] {
  const semester = state.student?.semester;
  const courseById = new Map(state.courses.map((c) => [c.id, c]));
  const topicById = new Map(state.topics.map((t) => [t.id, t]));

  return state.slides.map((slide) => {
    const topic = topicById.get(slide.topicId);
    const course = topic ? courseById.get(topic.courseId) : undefined;
    return {
      id: slide.id,
      topicId: slide.topicId,
      title: slide.title,
      materialKind: slide.materialKind,
      contentText: slide.contentText,
      courseId: course?.id ?? topic?.courseId,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicName: topic?.topicName,
      semester,
    };
  });
}

/** Converts an indexed hit into the shape the context builder consumes. */
export function toRetrievalHit(hit: RagHit): RetrievalHit {
  return {
    label: hit.materialTitle || hit.materialId,
    text: hit.text,
    materialId: hit.materialId,
    page: hit.page,
    slide: hit.slide,
    score: hit.score,
    semester: hit.semester,
    courseId: hit.courseId,
    courseCode: hit.courseCode,
    courseName: hit.courseName,
    topicId: hit.topicId,
    topicName: hit.topicName,
    materialTitle: hit.materialTitle,
  };
}

/**
 * A bounded digest of a topic's materials.
 *
 * Summarising a topic legitimately needs breadth, but "breadth" must not mean
 * concatenating all 120 slides of a lecture and hoping the provider copes.
 * This assembles the digest **chunk by chunk against a token budget**: small
 * topics go across whole, large ones contribute the chunks that best match the
 * question (or, with no question, an even spread across the topic's materials),
 * each still labelled with course, topic, material and page/slide.
 */
export async function buildTopicDigest(
  state: AppStateLike,
  options: {
    topicId: string;
    courseId?: string;
    /** Optional focus; when present, matching chunks win. */
    query?: string;
    budgetTokens?: number;
    loadText?: (materialId: string) => Promise<string | null>;
  },
): Promise<{ text: string; hits: RetrievalHit[]; truncated: boolean; materialsUsed: number }> {
  const loadText = options.loadText ?? (async () => null);
  const budget = options.budgetTokens ?? 6_000;
  const sources = indexableSources(state).filter(
    (s) => s.topicId === options.topicId && (!options.courseId || s.courseId === options.courseId),
  );
  if (!sources.length) return { text: '', hits: [], truncated: false, materialsUsed: 0 };

  const perMaterial: Array<{ source: IndexableSource; chunks: IndexedChunk[] }> = [];
  for (const source of sources) {
    const text = source.contentText ?? (await loadText(source.id)) ?? '';
    if (!text.trim()) continue;
    const chunks = chunkSource(source, text);
    if (chunks.length) perMaterial.push({ source, chunks });
  }
  if (!perMaterial.length) return { text: '', hits: [], truncated: false, materialsUsed: 0 };

  // With a question, the most relevant chunks win. Without one, take a round
  // robin across materials so every file in the topic is represented.
  const ordered = options.query?.trim()
    ? rankAll(perMaterial.flatMap((m) => m.chunks), options.query)
    : roundRobin(perMaterial.map((m) => m.chunks));

  const kept: IndexedChunk[] = [];
  let chars = 0;
  const budgetChars = Math.max(500, Math.floor(budget * 3.6));
  let truncated = false;

  for (const chunk of ordered) {
    if (chars + chunk.chars > budgetChars) {
      truncated = true;
      continue;
    }
    kept.push(chunk);
    chars += chunk.chars;
  }

  const text = kept
    .map((chunk) => {
      const header = sourceHeader(chunk);
      return header ? `${header}\n${chunk.text}` : chunk.text;
    })
    .join('\n\n');

  return {
    text,
    hits: kept.map((chunk) => toRetrievalHit({ ...chunk, score: 0 })),
    truncated,
    materialsUsed: perMaterial.length,
  };
}

function rankAll(chunks: IndexedChunk[], query: string): IndexedChunk[] {
  const ranked = searchIndex({ version: 1, materials: { digest: { materialId: 'digest', fingerprint: '', chunks, sourceChars: 0, indexedAt: '' } } }, {
    text: query,
    limit: chunks.length,
    minScore: 0,
    perMaterial: Number.MAX_SAFE_INTEGER,
  });
  // Anything the ranking dropped keeps its original order at the end, so a
  // digest never silently loses a slide that simply scored zero.
  const rankedIds = new Set(ranked.map((h) => h.id));
  return [...ranked, ...chunks.filter((c) => !rankedIds.has(c.id))];
}

/** Interleaves chunks across materials so one long file can't dominate. */
function roundRobin(groups: IndexedChunk[][]): IndexedChunk[] {
  const out: IndexedChunk[] = [];
  const max = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < max; i += 1) {
    for (const group of groups) if (group[i]) out.push(group[i]);
  }
  return out;
}

/**
 * Retrieval for one question. `selection.materialId` is excluded by default:
 * the material in focus is already being sent in full, so retrieving from it
 * would just duplicate the prompt.
 */
export async function retrieveForSelection(
  state: AppStateLike,
  selection: ContextSelection,
  question: string,
  options: PipelineOptions = {},
): Promise<{ hits: RetrievalHit[]; index: RagIndexShape }> {
  const query = (question || selection.question || '').trim();
  if (!query) return { hits: [], index: options.index ?? (await loadRagIndex()) };

  const loadText = options.loadText ?? (async () => null);
  const index = options.skipSync && options.index
    ? options.index
    : await syncIndex(indexableSources(state), loadText, options.index);

  const hits = searchIndex(index, {
    text: query,
    semester: state.student?.semester,
    courseId: selection.courseId,
    topicId: selection.topicId,
    excludeMaterialId: selection.materialId,
    limit: 6,
  });

  return { hits: hits.map(toRetrievalHit), index };
}
