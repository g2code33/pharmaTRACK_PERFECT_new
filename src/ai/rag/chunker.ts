/**
 * PharmaTRACK AI Engine — extraction and chunking (RAG stages 2–4).
 *
 * Two jobs, in order:
 *
 *  1. **Extraction** — turn one material's raw text into *located* units. The
 *     extractors (PDF, PPTX, DOCX, OCR) already emit `--- Slide 12 ---` /
 *     `Page 4` markers, so a unit keeps the page or slide it came from instead
 *     of being an anonymous slice of a document.
 *  2. **Chunking** — cut those units down to a size a model can quote. Overlap
 *     keeps a sentence that straddles a boundary retrievable from both sides.
 *
 * Metadata is attached here, once. Nothing downstream has to infer provenance.
 */
import type { ChunkMeta, IndexableSource, IndexedChunk } from './types';

export const DEFAULT_CHUNK_CHARS = 1200;
export const DEFAULT_OVERLAP_CHARS = 200;
/** Guard against a pathological single-word document producing huge chunks. */
const MAX_CHUNK_CHARS = 4000;

/** `--- Slide 12 ---`, `Page 4:`, `slide 3 -`, etc. */
const MARKER_RE =
  /(?:^|\n)\s*(?:---\s*(?:slide|page)\s+(\d+)\s*---|(?:slide|page)\s+(\d+)\s*[:.-])\s*/gi;

export interface ExtractedUnit {
  text: string;
  page?: number;
  slide?: number;
}

/**
 * Splits extracted text into located units along the markers the extractors
 * produce. Returns one unlocated unit when the text has no markers.
 */
export function extractUnits(text: string): ExtractedUnit[] {
  const body = (text || '').trim();
  if (!body) return [];

  MARKER_RE.lastIndex = 0;
  const out: ExtractedUnit[] = [];
  let last: { index: number; page?: number; slide?: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = MARKER_RE.exec(body)) !== null) {
    if (last) {
      const slice = body.slice(last.index, match.index).trim();
      if (slice) out.push({ text: slice, page: last.page, slide: last.slide });
    }
    const isSlide = /slide/i.test(match[0]);
    const number = Number(match[1] ?? match[2]);
    last = {
      index: match.index,
      page: isSlide ? undefined : number,
      slide: isSlide ? number : undefined,
    };
  }
  if (last) {
    const slice = body.slice(last.index).trim();
    if (slice) out.push({ text: slice, page: last.page, slide: last.slide });
  }

  return out.length ? out : [{ text: body }];
}

/** Cuts one located unit into overlapping chunks. */
export function chunkUnit(
  unit: ExtractedUnit,
  chunkChars = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_OVERLAP_CHARS,
): string[] {
  const body = unit.text.trim();
  if (!body) return [];
  const size = Math.min(Math.max(chunkChars, 200), MAX_CHUNK_CHARS);
  const step = Math.max(1, size - Math.max(0, Math.min(overlap, Math.floor(size / 2))));
  if (body.length <= size) return [body];

  const out: string[] = [];
  for (let start = 0; start < body.length; start += step) {
    let slice = body.slice(start, start + size);
    // Prefer to end on a sentence or paragraph so a chunk still reads cleanly.
    if (start + size < body.length) {
      const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      if (cut > size * 0.5) slice = slice.slice(0, cut + 1);
    }
    slice = slice.trim();
    if (slice) out.push(slice);
    if (start + size >= body.length) break;
  }
  return out;
}

/**
 * Cheap, stable, non-cryptographic fingerprint of extracted text. Used only to
 * decide whether a material needs re-indexing — a collision would merely mean a
 * stale chunk list, so a fast hash is the right trade for an offline index.
 */
export function fingerprintText(text: string): string {
  const body = text ?? '';
  let hash = 2166136261;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${body.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/** Builds the metadata every chunk of a material carries. */
export function metaFor(source: IndexableSource): ChunkMeta {
  return {
    semester: source.semester,
    courseId: source.courseId,
    courseCode: source.courseCode,
    courseName: source.courseName,
    topicId: source.topicId,
    topicName: source.topicName,
    materialId: source.id,
    materialTitle: source.title,
    materialKind: source.materialKind,
  };
}

/**
 * Materials → Extraction → Chunking → Metadata. Produces the chunks that go
 * into the index for one material.
 */
export function chunkSource(
  source: IndexableSource,
  text: string,
  opts: { chunkChars?: number; overlapChars?: number } = {},
): IndexedChunk[] {
  const body = (text || '').trim();
  if (!body) return [];

  const base = metaFor(source);
  const units = extractUnits(body);
  const chunks: IndexedChunk[] = [];
  let ordinal = 0;

  for (const unit of units) {
    for (const piece of chunkUnit(unit, opts.chunkChars, opts.overlapChars)) {
      ordinal += 1;
      chunks.push({
        ...base,
        id: chunkId(source.id, unit, ordinal),
        text: piece,
        chars: piece.length,
        page: unit.page,
        slide: unit.slide,
      });
    }
  }
  return chunks;
}

function chunkId(materialId: string, unit: ExtractedUnit, ordinal: number): string {
  const where = unit.slide ? `s${unit.slide}` : unit.page ? `p${unit.page}` : `c${ordinal}`;
  return `${materialId}#${where}-${ordinal}`;
}
