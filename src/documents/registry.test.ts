/**
 * Format-capability registry — the routing table that decides how a document
 * opens. These tests pin the document-engine rules:
 *
 *   - every supported kind opens its ORIGINAL file in an appropriate viewer;
 *   - byte sniffing beats stored metadata beats filenames beats legacy fields;
 *   - unsupported formats produce a clear, actionable route — never a blank;
 *   - nothing about routing requires extraction, OCR, conversion or network.
 */
import { describe, expect, it } from 'vitest';
import {
  kindForMaterial,
  mimeForKind,
  routeMaterial,
  isOpenable,
  isPresentationMaterial,
} from './registry';
import { sniffMaterialKind } from '../utils/materialKind';

type MaterialLike = NonNullable<Parameters<typeof routeMaterial>[0]>;

const material = (over: Partial<MaterialLike> = {}): MaterialLike => ({
  materialKind: undefined,
  fileType: 'text',
  title: 'Lecture',
  originalName: undefined,
  contentText: '',
  ...over,
});

describe('routing by kind', () => {
  it('routes every supported kind to its viewer', () => {
    expect(routeMaterial(material({ materialKind: 'pdf' })).viewer).toBe('pdf');
    expect(routeMaterial(material({ materialKind: 'pptx' })).viewer).toBe('pptx');
    expect(routeMaterial(material({ materialKind: 'docx' })).viewer).toBe('docx');
    expect(routeMaterial(material({ materialKind: 'xlsx' })).viewer).toBe('xlsx');
    expect(routeMaterial(material({ materialKind: 'image' })).viewer).toBe('image');
    expect(routeMaterial(material({ materialKind: 'text' })).viewer).toBe('text');
  });

  it('routes legacy .ppt and unknown kinds to an honest unsupported card, not a blank', () => {
    const ppt = routeMaterial(material({ materialKind: 'ppt' }));
    expect(ppt.viewer).toBe('unsupported');
    expect(ppt.limitations).toMatch(/\.ppt/i);
    expect(isOpenable(ppt)).toBe(false);

    // A material with NO signal at all (no kind, no filename, no legacy
    // field) is honestly unsupported.
    const unknown = routeMaterial({ materialKind: undefined, fileType: undefined, title: 'x', originalName: undefined, contentText: '' });
    expect(unknown.viewer).toBe('unsupported');
    expect(unknown.limitations).toBeTruthy();

    // But a legacy fileType 'text' record with no other signal is a text
    // material — it keeps opening as text, exactly as it always did.
    expect(routeMaterial(material({})).viewer).toBe('text');
  });

  it('every supported route names its engine and records its limitations', () => {
    for (const kind of ['pdf', 'pptx', 'docx', 'xlsx'] as const) {
      const route = routeMaterial(material({ materialKind: kind }));
      expect(route.engine).not.toBe('—');
      expect(route.limitations).toBeTruthy();
    }
    expect(routeMaterial(material({ materialKind: 'image' })).limitations).toBeUndefined();
  });
});

describe('kind resolution precedence', () => {
  it('sniffed bytes win over stored metadata — a renamed file still opens correctly', () => {
    // Stored as PDF (a pre-registry conversion), bytes are actually a PPTX.
    const slide = material({ materialKind: 'pdf', originalName: 'lecture.pdf' });
    expect(kindForMaterial(slide, 'pptx')).toBe('pptx');
    expect(routeMaterial(slide, 'pptx').viewer).toBe('pptx');
  });

  it('falls back to stored materialKind, then the original filename, then legacy fileType', () => {
    expect(kindForMaterial(material({ materialKind: 'docx' }))).toBe('docx');
    expect(kindForMaterial(material({ originalName: 'sheet.xlsx' }))).toBe('xlsx');
    // A 2023-era record: no materialKind, no originalName, only fileType and
    // the presentation marker in the extracted text.
    expect(
      kindForMaterial({ fileType: 'text', title: 'Lecture', contentText: '--- Slide 1 ---\nHi' }),
    ).toBe('pptx');
    expect(kindForMaterial(material({ fileType: 'pdf' }))).toBe('pdf');
  });

  it('recognises every sniffable kind from bytes', () => {
    expect(sniffMaterialKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('pdf');
    expect(sniffMaterialKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image');
    expect(sniffMaterialKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image');
    expect(sniffMaterialKind(new TextEncoder().encode('plain notes'))).toBe('text');
  });
});

describe('mime routing', () => {
  it('gives every kind an accurate content type for blob URLs and downloads', () => {
    expect(mimeForKind('pdf')).toBe('application/pdf');
    expect(mimeForKind('pptx')).toContain('presentationml');
    expect(mimeForKind('docx')).toContain('wordprocessingml');
    expect(mimeForKind('xlsx')).toContain('spreadsheetml');
    expect(mimeForKind('image', 'png')).toBe('image/png');
    expect(mimeForKind(null)).toBe('application/octet-stream');
  });
});

describe('presentation semantics for legacy records', () => {
  it('treats pptx and ppt as presentations regardless of the legacy fileType', () => {
    expect(isPresentationMaterial(material({ materialKind: 'pptx', fileType: 'text' }))).toBe(true);
    expect(isPresentationMaterial(material({ originalName: 'deck.pptm' }))).toBe(true);
    expect(isPresentationMaterial(material({ materialKind: 'pdf' }))).toBe(false);
    expect(isPresentationMaterial(material({ materialKind: 'docx' }))).toBe(false);
  });
});
