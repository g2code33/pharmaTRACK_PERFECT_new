/**
 * What kind of file a material actually is.
 *
 * Slide.fileType is still the old union (pdf | jpg | png | text). PowerPoint
 * uploads were stored as text, and the extension was stripped from the title,
 * so the reader cannot trust the name. Kind is inferred, then confirmed from
 * the file bytes, and written back onto the slide. Nothing is deleted.
 */
import type { Slide } from '../types';

export type MaterialKind = 'pdf' | 'pptx' | 'ppt' | 'docx' | 'image' | 'text' | 'unknown';
export type OcrStatus = 'not_needed' | 'done' | 'skipped' | 'failed' | 'unknown';
export type VisualStatus = 'ok' | 'failed' | 'unknown';

const SLIDE_MARKER = /--- Slide \d+ ---/;

export function isPresentationKind(kind: MaterialKind | undefined | null): boolean {
  return kind === 'pptx' || kind === 'ppt';
}

export function looksLikePresentationText(text: string | undefined | null): boolean {
  return SLIDE_MARKER.test(text ?? '');
}

export function kindFromExtension(ext: string | undefined): MaterialKind {
  const e = (ext ?? '').toLowerCase().replace(/^\./, '');
  if (e === 'pdf') return 'pdf';
  if (e === 'pptx' || e === 'pptm') return 'pptx';
  if (e === 'ppt') return 'ppt';
  if (e === 'docx' || e === 'doc') return 'docx';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(e)) return 'image';
  if (e === 'txt' || e === 'md' || e === 'csv') return 'text';
  return 'unknown';
}

export function inferMaterialKind(
  slide: Pick<Slide, 'materialKind' | 'fileType' | 'title' | 'originalName' | 'contentText'>,
): MaterialKind {
  if (slide.materialKind && slide.materialKind !== 'unknown') return slide.materialKind;
  const name = `${slide.originalName ?? ''} ${slide.title ?? ''}`;
  if (/\.pptx$|\.pptm$/i.test(name)) return 'pptx';
  if (/\.ppt$/i.test(name)) return 'ppt';
  if (/\.pdf$/i.test(name) || slide.fileType === 'pdf') return 'pdf';
  if (/\.docx$|\.doc$/i.test(name)) return 'docx';
  if (slide.fileType === 'jpg' || slide.fileType === 'png') return 'image';
  // Upload stores `--- Slide N ---` at the start of extracted text. The
  // localStorage preview keeps that marker even after the 2000-character cap.
  if (looksLikePresentationText(slide.contentText)) return 'pptx';
  if (slide.fileType === 'text') return 'text';
  return 'unknown';
}

export function isPresentationSlide(
  slide: Pick<Slide, 'materialKind' | 'fileType' | 'title' | 'originalName' | 'contentText'> | null | undefined,
): boolean {
  if (!slide) return false;
  return isPresentationKind(inferMaterialKind(slide));
}

/** Open the visual slide reader, not the plain-text fallback. */
export function shouldOpenAsPresentation(
  slide: Pick<Slide, 'materialKind' | 'fileType' | 'title' | 'originalName' | 'contentText'> | null | undefined,
  sniffed?: MaterialKind | null,
): boolean {
  if (sniffed === 'pptx' || sniffed === 'ppt') return true;
  return isPresentationSlide(slide);
}

export function typeLabel(kind: MaterialKind): string {
  switch (kind) {
    case 'pdf': return 'PDF';
    case 'pptx': return 'PowerPoint';
    case 'ppt': return 'PowerPoint (.ppt)';
    case 'docx': return 'Word';
    case 'image': return 'Image';
    case 'text': return 'Text';
    default: return 'Unknown';
  }
}

export function ocrLabel(status: OcrStatus | undefined): string {
  switch (status) {
    case 'done': return 'OCR done';
    case 'skipped': return 'OCR skipped';
    case 'failed': return 'OCR failed';
    case 'not_needed': return 'No OCR needed';
    default: return 'OCR unknown';
  }
}

export function ocrStatusFor(kind: string, usedOcr: boolean, text: string): OcrStatus {
  if (usedOcr) return 'done';
  if (kind === 'image') return 'skipped';
  if (kind === 'pdf') return text.trim() ? 'not_needed' : 'skipped';
  return 'not_needed';
}

export function formatMaterialSize(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/** Fields written onto a Slide when an upload finishes. Never removes a file. */
export function materialMetaFromUpload(m: {
  materialKind?: MaterialKind;
  originalName?: string;
  sizeBytes?: number;
  pageCount?: number;
  ocrStatus?: OcrStatus;
  visualStatus?: VisualStatus;
}): Partial<Slide> {
  return {
    ...(m.materialKind ? { materialKind: m.materialKind } : {}),
    ...(m.originalName ? { originalName: m.originalName } : {}),
    ...(typeof m.sizeBytes === 'number' ? { fileSize: m.sizeBytes } : {}),
    ...(m.pageCount ? { pageCount: m.pageCount } : {}),
    ...(m.ocrStatus ? { ocrStatus: m.ocrStatus } : {}),
    ...(m.visualStatus ? { visualStatus: m.visualStatus } : {}),
    favorite: false,
    tags: [],
  };
}

function includesAscii(bytes: Uint8Array, needle: string, from: number, to: number): boolean {
  const n = needle.length;
  if (n === 0) return true;
  const start = Math.max(0, from);
  const end = Math.min(bytes.length, to);
  if (end - start < n) return false;
  const first = needle.charCodeAt(0);
  for (let i = start; i <= end - n; i++) {
    if (bytes[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < n; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** UTF-16LE ASCII. OLE summary streams store "PowerPoint" this way. */
function includesUtf16Ascii(bytes: Uint8Array, needle: string, from: number, to: number): boolean {
  const n = needle.length;
  const start = Math.max(0, from);
  const end = Math.min(bytes.length, to);
  if (end - start < n * 2) return false;
  const first = needle.charCodeAt(0);
  for (let i = start; i <= end - n * 2; i++) {
    if (bytes[i] !== first || bytes[i + 1] !== 0) continue;
    let ok = true;
    for (let j = 1; j < n; j++) {
      if (bytes[i + j * 2] !== needle.charCodeAt(j) || bytes[i + j * 2 + 1] !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Identifies a file from its bytes. Only the head and the ZIP central
 * directory (the tail) are scanned, so a large lecture is not copied into a
 * string and the whole slide list is not decoded.
 */
export function sniffMaterialKind(bytes: Uint8Array): MaterialKind {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf';
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const head = Math.min(bytes.length, 65536);
    if (includesUtf16Ascii(bytes, 'PowerPoint', 0, head) || includesAscii(bytes, 'PowerPoint', 0, head)) return 'ppt';
    if (includesUtf16Ascii(bytes, 'Word.Document', 0, head) || includesAscii(bytes, 'Word.Document', 0, head)) return 'docx';
    return 'unknown';
  }
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  if (zip) {
    const headEnd = Math.min(bytes.length, 65536);
    const tailStart = Math.max(0, bytes.length - 262144);
    if (
      includesAscii(bytes, 'ppt/presentation.xml', 0, headEnd) ||
      includesAscii(bytes, 'ppt/presentation.xml', tailStart, bytes.length)
    ) return 'pptx';
    if (
      includesAscii(bytes, 'word/document.xml', 0, headEnd) ||
      includesAscii(bytes, 'word/document.xml', tailStart, bytes.length)
    ) return 'docx';
    return 'unknown';
  }
  return 'text';
}
