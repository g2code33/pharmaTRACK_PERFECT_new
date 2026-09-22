/**
 * PharmaTRACK AI Engine — local-first retrieval (RAG layer 1).
 *
 * Full chunk/embedding RAG needs an embedding model, which needs either the
 * network (against the offline-first rule) or a bundled model (hundreds of MB).
 * So this is layer 1: **school-aware lexical retrieval over local material**,
 * which is genuinely useful today and gives a future embedding index a stable
 * place to plug in:
 *
 *   materials → already extracted text → scored chunks → relevant context → model
 *
 * Retrieval understands semester/course/topic/material/page because the app's
 * own records say so — a query is scoped to the current course first and only
 * widens when nothing matched, and every hit keeps its page/slide so a citation
 * can jump straight back into the reader.
 */
import type { StateSlideLike, RetrievalHit } from './context/types';

export interface RetrievalSource extends StateSlideLike {
  courseId?: string;
  topicId: string;
  /** Full or truncated extracted text; the caller decides how to load it. */
}

export interface RetrievalQuery {
  text: string;
  /** Restrict to one course (default: the current one). */
  courseId?: string;
  /** Restrict to one topic. */
  topicId?: string;
  /** Material to exclude — usually the one already fully in context. */
  excludeMaterialId?: string;
  limit?: number;
  /** Minimum share of the query terms that must match. */
  minScore?: number;
}

/** A retrievable chunk of a material, ready to score. */
export interface RetrievedChunk {
  materialId: string;
  label: string;
  page?: number;
  slide?: number;
  text: string;
}

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

/**
 * Splits a material's text into overlapping chunks along slide/paragraph
 * boundaries. Chunks are the unit of retrieval so a hit can cite "slide 23"
 * rather than dumping a whole lecture into the prompt.
 */
export function chunkMaterial(
  material: RetrievalSource,
  text: string,
  opts: { chunkChars?: number; overlapChars?: number } = {},
): RetrievedChunk[] {
  const chunkChars = opts.chunkChars ?? 1200;
  const overlap = opts.overlapChars ?? 200;
  const label = material.title || `Material ${material.id}`;
  const body = (text || '').trim();
  if (!body) return [];

  // Materials whose text we can split by slide/page marker keep their numbering.
  const parts = splitByMarkers(body);
  if (parts.length > 1) {
    return parts.map((part) => ({
      materialId: material.id,
      label,
      page: part.page,
      slide: part.slide,
      text: part.text.length > chunkChars ? part.text.slice(0, chunkChars) : part.text,
    }));
  }

  const chunks: RetrievedChunk[] = [];
  for (let start = 0; start < body.length; start += chunkChars - overlap) {
    const slice = body.slice(start, start + chunkChars).trim();
    if (slice) chunks.push({ materialId: material.id, label, text: slice });
    if (start + chunkChars >= body.length) break;
  }
  return chunks;
}

/** Recognises the `--- Slide 12 ---` / `Page 4` markers the extractors produce. */
function splitByMarkers(text: string): Array<{ text: string; page?: number; slide?: number }> {
  const re = /(?:^|\n)\s*(?:---\s*(?:slide|page)\s+(\d+)\s*---|(?:slide|page)\s+(\d+)\s*[:.-])\s*/gi;
  const out: Array<{ text: string; page?: number; slide?: number }> = [];
  let last: { index: number; page?: number; slide?: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (last) {
      const chunk = text.slice(last.index, match.index).trim();
      if (chunk) out.push({ text: chunk, page: last.page, slide: last.slide });
    }
    const isSlide = /slide/i.test(match[0]);
    const number = Number(match[1] ?? match[2]);
    last = { index: match.index, page: isSlide ? undefined : number, slide: isSlide ? number : undefined };
  }
  if (last) {
    const chunk = text.slice(last.index).trim();
    if (chunk) out.push({ text: chunk, page: last.page, slide: last.slide });
  }
  return out;
}

/**
 * Scores chunks against the query with a small BM25-flavoured lexical model
 * plus a phrase bonus. Deliberately simple, dependency-free, and explainable:
 * a hit is returned only when it shares real terms with the question.
 */
export function rankChunks(query: string, chunks: RetrievedChunk[], limit = 5): RetrievalHit[] {
  const terms = tokenize(query);
  if (!terms.length || !chunks.length) return [];
  const unique = [...new Set(terms)];

  const docs = chunks.map((chunk) => {
    const lower = chunk.text.toLowerCase();
    return { chunk, lower, tokens: tokenize(chunk.text) };
  });
  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length || 1;

  const df = new Map<string, number>();
  for (const term of unique) {
    let count = 0;
    for (const doc of docs) if (doc.tokens.includes(term)) count += 1;
    df.set(term, count);
  }

  const scored: RetrievalHit[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of unique) {
      const tf = doc.tokens.filter((t) => t === term).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      const k1 = 1.4;
      const b = 0.75;
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.tokens.length) / avgLen)));
    }
    // Whole-question phrase bonus: "beta blockers" should beat two stray words.
    const phrase = unique.slice(0, 4).join(' ');
    if (phrase.length > 8 && doc.lower.includes(phrase)) score *= 1.4;
    if (score > 0) {
      scored.push({
        label: doc.chunk.label,
        text: doc.chunk.text,
        materialId: doc.chunk.materialId,
        page: doc.chunk.page,
        slide: doc.chunk.slide,
        score,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * End-to-end local retrieval: given the app's materials (and a text loader),
 * returns the chunks most relevant to the question. Material text comes from the
 * caller because full text may live in IndexedDB (see storage.loadSlideText).
 */
export async function retrieve(
  query: RetrievalQuery,
  materials: RetrievalSource[],
  loadText: (materialId: string) => Promise<string | null>,
): Promise<RetrievalHit[]> {
  if (!query.text.trim()) return [];
  const scoped = materials.filter((m) => {
    if (query.topicId && m.topicId !== query.topicId) return false;
    if (query.courseId && m.courseId && m.courseId !== query.courseId) return false;
    if (query.excludeMaterialId && m.id === query.excludeMaterialId) return false;
    return true;
  });

  const inScope = await Promise.all(
    scoped.slice(0, 40).map(async (material) => {
      const text = material.contentText ?? (await loadText(material.id)) ?? '';
      return chunkMaterial(material, text);
    }),
  );
  let hits = rankChunks(query.text, inScope.flat(), query.limit ?? 5);

  // Nothing matched inside the topic: widen once to the whole course, then stop.
  if (!hits.length && query.topicId) {
    const courseWide = materials.filter(
      (m) => (!query.courseId || m.courseId === query.courseId) && m.id !== query.excludeMaterialId,
    );
    const chunks = await Promise.all(
      courseWide.slice(0, 40).map(async (material) => {
        const text = material.contentText ?? (await loadText(material.id)) ?? '';
        return chunkMaterial(material, text);
      }),
    );
    hits = rankChunks(query.text, chunks.flat(), query.limit ?? 5);
  }

  const minScore = query.minScore ?? 0.6;
  return hits.filter((h) => h.score >= minScore);
}

/**
 * Future embedding index hook. Layer 1 is lexical; a local embedding model can
 * implement this interface without touching the manager, the context builder or
 * the UI — which is the point of isolating retrieval here.
 */
export interface RetrievalIndex {
  readonly kind: 'lexical' | 'embedding';
  search(query: RetrievalQuery): Promise<RetrievalHit[]>;
}

export const lexicalIndex = (
  materials: RetrievalSource[],
  loadText: (materialId: string) => Promise<string | null>,
): RetrievalIndex => ({
  kind: 'lexical',
  search: (query) => retrieve(query, materials, loadText),
});
