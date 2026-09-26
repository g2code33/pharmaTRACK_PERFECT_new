/**
 * PharmaTRACK AI Engine — index sync and retrieval (RAG stages 5–6).
 *
 * Local-first: every operation here is pure IndexedDB plus arithmetic. No
 * network, no embedding model, no provider. A student with no API key still
 * gets a working index; only *generation* needs a provider.
 *
 * Syncing is incremental — a material is re-chunked only when its extracted
 * text actually changed — so opening the library does not re-read every file.
 */
import { chunkSource, fingerprintText } from './chunker';
import { clearRagIndex, emptyIndex, loadRagIndex, saveRagIndex } from './store';
import type { IndexableSource, IndexedChunk, MaterialIndexEntry, RagHit, RagQuery, RagIndexShape } from './types';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'by',
  'with', 'as', 'at', 'that', 'this', 'it', 'from', 'what', 'which', 'how', 'why', 'does', 'do',
  'explain', 'summarise', 'summarize', 'me', 'about', 'give', 'can', 'you', 'please', 'tell',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Materials considered in one sync pass. Bounds worst-case work offline. */
const MAX_SYNC_MATERIALS = 200;
/**
 * Chunks kept per material. Bounds the index, but generously: a 900-slide deck
 * is a real thing in a pharmacy course, and truncating it to a few hundred
 * passages would put most of the semester out of the AI's reach.
 */
const MAX_CHUNKS_PER_MATERIAL = 1_200;

/**
 * Brings the index up to date for `sources`. Text is loaded lazily and only for
 * materials whose fingerprint changed, so an unchanged library costs one read
 * of the index and no re-extraction.
 */
export async function syncIndex(
  sources: IndexableSource[],
  loadText: (materialId: string) => Promise<string | null>,
  existing?: RagIndexShape,
): Promise<RagIndexShape> {
  const index = existing ?? (await loadRagIndex());
  const next: RagIndexShape = { version: index.version, materials: { ...index.materials } };
  const seen = new Set<string>();
  let dirty = false;

  for (const source of sources.slice(0, MAX_SYNC_MATERIALS)) {
    seen.add(source.id);
    const text = source.contentText ?? (await loadText(source.id)) ?? '';
    if (!text.trim()) continue;

    const fingerprint = fingerprintText(text);
    const current = next.materials[source.id];
    // Unchanged text: keep the existing chunks, refresh stale metadata only.
    if (current && current.fingerprint === fingerprint) {
      if (metaDrifted(current, source)) {
        next.materials[source.id] = {
          ...current,
          chunks: current.chunks.map((chunk) => ({ ...chunk, ...labelsFor(source) })),
        };
        dirty = true;
      }
      continue;
    }

    const chunks = chunkSource(source, text).slice(0, MAX_CHUNKS_PER_MATERIAL);
    if (!chunks.length) continue;
    next.materials[source.id] = {
      materialId: source.id,
      fingerprint,
      chunks,
      sourceChars: text.length,
      indexedAt: new Date().toISOString(),
    };
    dirty = true;
  }

  // Materials deleted from the workspace must not stay retrievable.
  for (const materialId of Object.keys(next.materials)) {
    if (!seen.has(materialId)) {
      delete next.materials[materialId];
      dirty = true;
    }
  }

  if (dirty) await saveRagIndex(next);
  return next;
}

function labelsFor(source: IndexableSource) {
  return {
    semester: source.semester,
    courseId: source.courseId,
    courseCode: source.courseCode,
    courseName: source.courseName,
    topicId: source.topicId,
    topicName: source.topicName,
    materialTitle: source.title,
    materialKind: source.materialKind,
  };
}

function metaDrifted(entry: MaterialIndexEntry, source: IndexableSource): boolean {
  const first = entry.chunks[0];
  if (!first) return true;
  return (
    first.materialTitle !== source.title ||
    first.courseId !== source.courseId ||
    first.topicId !== source.topicId ||
    first.topicName !== source.topicName ||
    first.semester !== source.semester
  );
}

/** Every chunk in the index, flattened. */
export function allChunks(index: RagIndexShape): IndexedChunk[] {
  return Object.values(index.materials).flatMap((entry) => entry.chunks);
}

export function statsFor(index: RagIndexShape) {
  const entries = Object.values(index.materials);
  return {
    materials: entries.length,
    chunks: entries.reduce((sum, e) => sum + e.chunks.length, 0),
    chars: entries.reduce((sum, e) => sum + e.sourceChars, 0),
    updatedAt: entries.reduce<string | undefined>(
      (latest, e) => (!latest || e.indexedAt > latest ? e.indexedAt : latest),
      undefined,
    ),
  };
}

/**
 * BM25-flavoured lexical scoring over indexed chunks. Deliberately
 * dependency-free and explainable: a hit comes back only when it shares real
 * terms with the question, and it keeps its full academic metadata.
 */
export function rankChunks(query: string, chunks: IndexedChunk[], limit = 6): RagHit[] {
  const terms = tokenize(query);
  if (!terms.length || !chunks.length) return [];
  const unique = [...new Set(terms)];

  const docs = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    return { chunk, tokens, lower: chunk.text.toLowerCase() };
  });
  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length || 1;

  const df = new Map<string, number>();
  for (const term of unique) {
    let count = 0;
    for (const doc of docs) if (doc.tokens.includes(term)) count += 1;
    df.set(term, count);
  }

  const scored: RagHit[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of unique) {
      const tf = doc.tokens.filter((t) => t === term).length;
      if (!tf) continue;
      const freq = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - freq + 0.5) / (freq + 0.5));
      const k1 = 1.4;
      const b = 0.75;
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.tokens.length) / avgLen)));
    }
    // Whole-question phrase bonus: "beta blockers" should beat two stray words.
    const phrase = unique.slice(0, 4).join(' ');
    if (phrase.length > 8 && doc.lower.includes(phrase)) score *= 1.4;
    if (score > 0) scored.push({ ...doc.chunk, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function scopeChunks(index: RagIndexShape, query: RagQuery): IndexedChunk[] {
  return allChunks(index).filter((chunk) => {
    if (query.excludeMaterialId && chunk.materialId === query.excludeMaterialId) return false;
    if (query.topicId && chunk.topicId !== query.topicId) return false;
    if (query.courseId && chunk.courseId && chunk.courseId !== query.courseId) return false;
    if (query.semester && chunk.semester && chunk.semester !== query.semester) return false;
    return true;
  });
}

/**
 * Searches a loaded index. Scoped to the topic first, widening once to the
 * course when the topic has nothing — the student asked about their question,
 * not about where the answer happens to be filed.
 */
/** A hit must clear this, however good the rest of the results are. */
const MIN_ABS_SCORE = 0.05;
/**
 * A hit must also be within this fraction of the best hit.
 *
 * BM25's IDF collapses when the corpus is small — a topic with two materials
 * scores every hit below a fixed threshold, and retrieval would return nothing
 * exactly where the library is thinnest. Scoring against the best hit instead
 * keeps the threshold meaningful at any corpus size, while the absolute floor
 * still discards passages that share no term with the question at all.
 */
const RELATIVE_CUTOFF = 0.25;

/** Keeps the hits worth sending: above an absolute floor and near the best one. */
export function significantHits<T extends { score: number }>(hits: T[], override?: number): T[] {
  if (!hits.length) return hits;
  const best = hits[0].score;
  const threshold = override ?? Math.max(MIN_ABS_SCORE, best * RELATIVE_CUTOFF);
  return hits.filter((h) => h.score >= threshold);
}

export function searchIndex(index: RagIndexShape, query: RagQuery): RagHit[] {
  if (!query.text.trim()) return [];
  const limit = query.limit ?? 6;
  const perMaterial = query.perMaterial ?? 3;

  let hits = capPerMaterial(rankChunks(query.text, scopeChunks(index, query), limit * 3), perMaterial);

  if (!hits.length && query.topicId) {
    const widened: RagQuery = { ...query, topicId: undefined };
    hits = capPerMaterial(rankChunks(query.text, scopeChunks(index, widened), limit * 3), perMaterial);
  }

  return significantHits(hits, query.minScore).slice(0, limit);
}

/** One material must not crowd out the others, however large it is. */
function capPerMaterial(hits: RagHit[], perMaterial: number): RagHit[] {
  const counts = new Map<string, number>();
  const out: RagHit[] = [];
  for (const hit of hits) {
    const seen = counts.get(hit.materialId) ?? 0;
    if (seen >= perMaterial) continue;
    counts.set(hit.materialId, seen + 1);
    out.push(hit);
  }
  return out;
}

/** Rebuilds the index from scratch. Used by the settings screen and tests. */
export async function rebuildIndex(
  sources: IndexableSource[],
  loadText: (materialId: string) => Promise<string | null>,
): Promise<RagIndexShape> {
  await clearRagIndex();
  return syncIndex(sources, loadText, emptyIndex());
}

export { clearRagIndex, loadRagIndex };
