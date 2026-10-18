/**
 * Format-capability registry — the single place that decides HOW a document
 * opens, on the platform the app is running on.
 *
 * The rules it enforces (see docs/DOCUMENT_VIEWERS.md):
 *   1. A supported document opens its ORIGINAL file in an appropriate viewer.
 *      Text extraction, OCR, conversion and AI indexing are never
 *      prerequisites — they live in utils/extractText.ts and run only when a
 *      feature explicitly needs them.
 *   2. Routing is driven by the material's real kind (bytes sniffed at open
 *      time beat stored metadata, which beats the filename), with the legacy
 *      `fileType` union as the last resort so records created years ago keep
 *      opening unchanged. No stored data is rewritten to migrate.
 *   3. An unsupported format produces a clear explanation and a download of
 *      the original — never a blank screen.
 *
 * All viewers run in the platform's WebView (Chromium WebView on Android,
 * Tauri's WebView on Windows/Linux, Safari on iPad/iPhone), so a single
 * capability table is honest for every target; the table records what each
 * engine does NOT render so limitations are documented, not discovered.
 */

import {
  inferMaterialKind,
  isPresentationKind,
  kindFromExtension,
  sniffMaterialKind,
  type MaterialKind,
} from '../utils/materialKind';
import type { Slide } from '../types';

export type ViewerId = 'pdf' | 'pptx' | 'docx' | 'xlsx' | 'image' | 'text' | 'unsupported';

export interface ViewerRoute {
  viewer: ViewerId;
  /** Human name of the engine that will render the file. */
  engine: string;
  /** Honest notes about what the engine does not render. */
  limitations?: string;
}

/** Byte sniffers beat stored metadata beat filenames — see routeMaterial. */
export function kindForMaterial(
  slide: Pick<Slide, 'materialKind' | 'fileType' | 'title' | 'originalName' | 'contentText'> | null | undefined,
  sniffed?: MaterialKind | null,
): MaterialKind {
  if (sniffed && sniffed !== 'unknown') return sniffed;
  if (slide?.materialKind && slide.materialKind !== 'unknown') return slide.materialKind;
  const byName = kindFromExtension((slide?.originalName ?? '').split('.').pop());
  if (byName !== 'unknown') return byName;
  return inferMaterialKind(slide ?? undefined as never);
}

/**
 * Which viewer renders a material, and what that viewer honestly supports.
 * `sniffed` (bytes) wins so a renamed file still opens correctly.
 */
export function routeMaterial(
  slide: Pick<Slide, 'materialKind' | 'fileType' | 'title' | 'originalName' | 'contentText'> | null | undefined,
  sniffed?: MaterialKind | null,
): ViewerRoute {
  const kind = kindForMaterial(slide, sniffed);
  // Presentations that were converted to PDF *before* this registry existed
  // are stored as PDFs — they keep opening in the PDF viewer; their bytes say
  // pdf and nothing rewrites them.
  switch (kind) {
    case 'pdf':
      return {
        viewer: 'pdf',
        engine: 'PDF.js (bundled)',
        limitations: 'Scanned pages without a text layer are images; run OCR at upload to make them searchable.',
      };
    case 'pptx':
      return {
        viewer: 'pptx',
        engine: 'Native PPTX renderer (pptxRenderer)',
        limitations: 'Animations, transitions, SmartArt diagrams and charts render as their static shapes/frames; hidden slides are skipped like PowerPoint’s slideshow.',
      };
    case 'ppt':
      return {
        viewer: 'unsupported',
        engine: '—',
        limitations: 'Legacy binary .ppt is not rendered visually. Download the original and open it in PowerPoint or LibreOffice, or ask your lecturer for a .pptx export.',
      };
    case 'docx':
      return {
        viewer: 'docx',
        engine: 'docx-preview (bundled)',
        limitations: 'Tracked-change balloons, macros and embedded OLE objects are not drawn.',
      };
    case 'xlsx':
      return {
        viewer: 'xlsx',
        engine: 'SheetJS Community Edition',
        limitations: 'Charts, cell colours, conditional formatting and frozen panes are not drawn; formulas show their stored results.',
      };
    case 'image':
      return { viewer: 'image', engine: 'Browser image decoder' };
    case 'text':
      return { viewer: 'text', engine: 'Plain text' };
    default:
      return {
        viewer: 'unsupported',
        engine: '—',
        limitations: 'This file type is not supported for viewing. The original file can still be downloaded.',
      };
  }
}

/** True when the material will open in a visual viewer rather than a fallback. */
export function isOpenable(route: ViewerRoute): boolean {
  return route.viewer !== 'unsupported';
}

/**
 * MIME type for the blob URL handed to the viewer. Where the exact type is
 * unknown the sniffed kind decides — viewers identify from bytes anyway, and
 * a wrong MIME would misroute downloads.
 */
export function mimeForKind(kind: MaterialKind | null | undefined, legacyFileType?: string): string {
  switch (kind) {
    case 'pdf': return 'application/pdf';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'ppt': return 'application/vnd.ms-powerpoint';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'image': return legacyFileType === 'png' ? 'image/png' : 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

/**
 * Should this material be treated as a presentation for legacy records whose
 * fileType says text? Kept for the reader's old deep-link semantics.
 */
export function isPresentationMaterial(
  slide: Pick<Slide, 'materialKind' | 'fileType' | 'title' | 'originalName' | 'contentText'> | null | undefined,
  sniffed?: MaterialKind | null,
): boolean {
  return isPresentationKind(kindForMaterial(slide, sniffed));
}

/** Re-export so callers can sniff bytes without importing two modules. */
export { sniffMaterialKind };
export type { MaterialKind };
