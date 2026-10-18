/**
 * Document engine — end-to-end acceptance tests.
 *
 * The engine contract, pinned from upload to open:
 *
 *   1. Uploading a PPTX stores the ORIGINAL bytes — byte-identical, no
 *      conversion, no reconstruction, no PDF anywhere in the pipeline.
 *   2. The material the uploader produces routes to the right viewer.
 *   3. The bytes that were saved actually OPEN in the viewer engine.
 *   4. Text extraction is best-effort: a deck whose text cannot be read still
 *      uploads, still opens, still downloads.
 *   5. A storage failure surfaces as a queue error BEFORE any material record
 *      exists.
 *   6. The uploader source never imports the converter or the deleted
 *      universal processor.
 *
 * storage.saveFile and fileGuard.inspectFile are mocked (IndexedDB and the
 * byte-level guard have their own suites); everything else — the upload
 * pipeline, the extractor, the renderer, the registry — runs for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import FileUploader, { type UploadedMaterial } from '../components/FileUploader';
import { readBlobArrayBuffer } from '../utils/fileGuard';
import { routeMaterial } from '../documents/registry';
import { openPptxDeck } from '../utils/pptxRenderer';

vi.mock('../utils/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/storage')>();
  return {
    ...actual,
    saveFile: vi.fn(async () => true),
  };
});

vi.mock('../utils/fileGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fileGuard')>();
  return {
    ...actual,
    // The byte-level guard has its own suite; here it accepts everything so
    // the pipeline under test is the uploader's own logic.
    inspectFile: vi.fn(async () => ({ ok: true, detected: 'text', claimed: 'text', issues: [] })),
  };
});

// OCR is opt-in and not under test; stubbing it also keeps the pdf.js worker
// (?url import, unresolved under Vitest) and tesseract out of this suite.
vi.mock('../utils/ocr', () => ({
  pdfHasTextLayer: vi.fn(async () => true),
  ocrPdf: vi.fn(async () => []),
  ocrImage: vi.fn(async () => ''),
}));

// jsdom's File has no arrayBuffer(); the uploader reads the whole file that
// way. Bridge it with a plain FileReader — NOT via readBlobArrayBuffer, which
// prefers blob.arrayBuffer() when it exists and would recurse into this
// polyfill forever.
if (typeof File.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    value(this: File) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error('Could not read file bytes'));
        reader.readAsArrayBuffer(this);
      });
    },
    configurable: true,
  });
}

import { saveFile } from '../utils/storage';

const slideXml = (n: number) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="7772400" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Slide ${n} title</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="2743200"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Body of slide ${n}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

async function buildPptxBytes(slides = 3): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${Array.from({ length: slides }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from({ length: slides }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}
</Relationships>`,
  );
  for (let i = 1; i <= slides; i++) zip.file(`ppt/slides/slide${i}.xml`, slideXml(i));
  return zip.generateAsync({ type: 'uint8array' });
}

const bytesForFile = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function upload(files: File[]): Promise<UploadedMaterial[]> {
  const materials: UploadedMaterial[] = [];
  const { container } = render(
    <FileUploader onComplete={(m) => materials.push(m)} />,
  );
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
  return materials;
}

describe('upload → storage → viewer: the original bytes survive', () => {
  it('stores a PPTX byte-identically, with no conversion anywhere', async () => {
    const original = await buildPptxBytes(3);
    const file = new File([bytesForFile(original)], 'pharmacology-lecture.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });

    const materials = await upload([file]);

    await waitFor(() => {
      expect(materials).toHaveLength(1);
    });
    const material = materials[0];

    // Exactly one save, of the ORIGINAL bytes.
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
    const [savedId, savedBytes] = vi.mocked(saveFile).mock.calls[0];
    expect(savedId).toBe(material.id);
    expect(Buffer.from(savedBytes as Uint8Array).equals(Buffer.from(original))).toBe(true);

    // The material is truthful: a presentation, never a disguised PDF.
    expect(material.kind).toBe('pptx');
    expect(material.materialKind).toBe('pptx');
    expect(material.fileType).not.toBe('pdf');
    expect(material.pageCount).toBe(3);
    expect(material.text).toContain('--- Page 1 ---');
    expect(material.text).toContain('Body of slide 3');
    expect(material.pages!.map((p) => p.page)).toEqual([1, 2, 3]);

    // …and the saved bytes themselves OPEN in the viewer engine.
    const deck = await openPptxDeck(new Blob([bytesForFile(savedBytes as Uint8Array)]));
    expect(deck.slideCount).toBe(3);
    const slide2 = await deck.getSlide(2);
    expect(slide2?.title).toBe('Slide 2 title');
    deck.dispose();

    // The material routes to the presentation viewer.
    expect(routeMaterial({ ...material, contentText: material.text }).viewer).toBe('pptx');

    // The user sees the honest summary.
    expect(await screen.findByText('PowerPoint · 3 slides')).toBeTruthy();
  });

  it('still completes the upload when text extraction fails', async () => {
    // Bytes that wear a .pptx name but are not a deck at all.
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const file = new File([bytesForFile(corrupt)], 'broken-deck.pptx');

    const materials = await upload([file]);

    await waitFor(() => {
      expect(materials).toHaveLength(1);
    });
    const material = materials[0];

    // The original bytes were saved anyway — extraction never gates the file.
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
    const [, savedBytes] = vi.mocked(saveFile).mock.calls[0];
    expect(Buffer.from(savedBytes as Uint8Array).equals(Buffer.from(corrupt))).toBe(true);

    expect(material.materialKind).toBe('pptx');
    expect(material.text).toBe('');
    // Still opens, still downloadable, still routed as a presentation.
    expect(routeMaterial({ ...material, contentText: material.text }).viewer).toBe('pptx');
    expect(await screen.findByText(/no readable text/)).toBeTruthy();
  });

  it('records a legacy .ppt honestly and keeps it downloadable', async () => {
    const bytes = new TextEncoder().encode('legacy binary powerpoint placeholder');
    const file = new File([bytesForFile(bytes)], 'old-lecture.ppt');

    const materials = await upload([file]);

    await waitFor(() => {
      expect(materials).toHaveLength(1);
    });
    const material = materials[0];

    // The upload succeeds, the bytes are the original…
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
    const [, savedBytes] = vi.mocked(saveFile).mock.calls[0];
    expect(Buffer.from(savedBytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);

    // …and the kind is truthful: legacy ppt, unsupported for display,
    // explicit about it, never silently converted.
    expect(material.materialKind).toBe('ppt');
    expect(material.fileType).not.toBe('pdf');
    expect(routeMaterial({ ...material, contentText: material.text }).viewer).toBe('unsupported');
    expect(routeMaterial({ ...material, contentText: material.text }).limitations).toBeTruthy();
    expect(await screen.findByText(/legacy \.ppt cannot be displayed/i)).toBeTruthy();
  });
});

describe('storage failure is reported before any record exists', () => {
  it('shows a queue error and never calls onComplete when saveFile fails', async () => {
    vi.mocked(saveFile).mockResolvedValueOnce(false);

    const original = await buildPptxBytes(1);
    const file = new File([bytesForFile(original)], 'unsaved.pptx');

    const materials = await upload([file]);

    // The failure is surfaced in the queue…
    await waitFor(() => {
      expect(screen.getByText(/Couldn't save this file to storage/i)).toBeTruthy();
    });
    // …and no material record was created for bytes that do not exist.
    expect(materials).toHaveLength(0);
  });
});

describe('the uploader source keeps the engine boundaries', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../components/FileUploader.tsx'),
    'utf8',
  );

  it('never imports the PDF converter or the deleted universal processor', () => {
    expect(source).not.toMatch(/pptxToPdf|universalProcessor|convertPptx|convertNativeMaterial/);
  });

  it('saves through storage.saveFile and extracts through the extraction service', () => {
    expect(source).toMatch(/import \{ saveFile \} from '\.\.\/utils\/storage'/);
    expect(source).toMatch(/from '\.\.\/utils\/extractText'/);
  });
});
