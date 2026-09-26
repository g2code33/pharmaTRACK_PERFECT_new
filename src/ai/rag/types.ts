/**
 * PharmaTRACK AI Engine — local RAG types.
 *
 * The pipeline this describes is:
 *
 *   Materials → Extraction → Chunking → Metadata → Local index → Retrieval → Context → Provider
 *
 * The point of `ChunkMeta` is that **every chunk knows where it came from**
 * (semester, course, topic, material, page, slide) from the moment it is cut.
 * Metadata is attached at indexing time and never guessed later, so a response
 * can always be traced back to "Course: Pharmacology / Topic: Autonomic drugs /
 * Source: Lecture 4 / Slide: 23" without re-reading the material.
 */

/** Where a chunk came from. Filled in once, at index time. */
export interface ChunkMeta {
  /** Student's current semester label, when known. */
  semester?: string;
  courseId?: string;
  courseCode?: string;
  courseName?: string;
  topicId: string;
  topicName?: string;
  materialId: string;
  materialTitle: string;
  /** pptx | pdf | docx | image | text | unknown */
  materialKind?: string;
  /** 1-based PDF page. */
  page?: number;
  /** 1-based presentation slide. */
  slide?: number;
}

/** One indexed unit of a material. This is what retrieval scores. */
export interface IndexedChunk extends ChunkMeta {
  /** Stable across re-indexes: `m12#page-4` / `m12#s3` / `m12#c7`. */
  id: string;
  text: string;
  chars: number;
}

/** A material's indexed state, so re-indexing can be incremental. */
export interface MaterialIndexEntry {
  materialId: string;
  /** Changes when the extracted text changes; unchanged materials are skipped. */
  fingerprint: string;
  chunks: IndexedChunk[];
  /** Characters of source text the chunks were cut from. */
  sourceChars: number;
  indexedAt: string;
}

/** Persisted shape. `version` lets us discard an index built by an older build. */
export interface RagIndexShape {
  version: number;
  materials: Record<string, MaterialIndexEntry>;
}

export const RAG_INDEX_VERSION = 2;
export const RAG_INDEX_KEY = 'pharmatrack_ai_rag_index';

/** A chunk that matched a query, with everything needed to cite it. */
export interface RagHit extends IndexedChunk {
  score: number;
}

export interface RagQuery {
  text: string;
  semester?: string;
  courseId?: string;
  topicId?: string;
  /** Usually the material already fully in context — don't retrieve from it. */
  excludeMaterialId?: string;
  limit?: number;
  /** Minimum relevance; below this a hit is noise. */
  minScore?: number;
  /** Cap on chunks from a single material, so one huge file can't dominate. */
  perMaterial?: number;
}

/**
 * A material handed to the indexer. Structural so tests can pass plain objects
 * and so the RAG layer never imports the app's state graph.
 */
export interface IndexableSource {
  id: string;
  topicId: string;
  title: string;
  materialKind?: string;
  /** Extracted text when it is short enough to live in state. */
  contentText?: string;
  courseId?: string;
  courseCode?: string;
  courseName?: string;
  topicName?: string;
  semester?: string;
}

/** Human-readable citation, e.g. "Lecture 4 — slide 23". */
export function chunkCitation(chunk: ChunkMeta): string {
  return [chunk.materialTitle, chunk.slide ? `slide ${chunk.slide}` : chunk.page ? `page ${chunk.page}` : '']
    .filter(Boolean)
    .join(' — ');
}

/**
 * The multi-line source header a model sees above a block of material, so its
 * answer can name its own source. Mirrors the example in the Phase 11 spec.
 */
export function sourceHeader(meta: ChunkMeta): string {
  const lines: string[] = [];
  if (meta.courseName) {
    lines.push(`Course: ${meta.courseCode ? `${meta.courseCode} — ` : ''}${meta.courseName}`);
  }
  if (meta.topicName) lines.push(`Topic: ${meta.topicName}`);
  if (meta.materialTitle) lines.push(`Source: ${meta.materialTitle}`);
  if (meta.slide) lines.push(`Slide: ${meta.slide}`);
  if (meta.page) lines.push(`Page: ${meta.page}`);
  return lines.join('\n');
}
