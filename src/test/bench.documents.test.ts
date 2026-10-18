/**
 * Document engine benchmarks — NOT part of CI assertions.
 *
 * Run them explicitly with:
 *
 *   RUN_BENCH=1 npx vitest run src/test/bench.documents.test.ts
 *
 * Timings are logged to the console and recorded in
 * docs/DOCUMENT_VIEWERS.md; the assertions here are sanity checks only (the
 * work really happened), never performance thresholds — those are flaky on
 * shared runners and belong in the documented measurements instead.
 *
 * What is measured and why it matters:
 *
 *   - eager renderPptx vs lazy openPptxDeck+getSlide(1): the old engine
 *     parsed the whole deck before showing anything; the new one parses one
 *     slide. This is the number that killed the "whole-deck freeze".
 *   - lazy open at 30/120/240 slides: opening cost must stay flat as decks
 *     grow, not scale with slide count.
 *   - textIndex on 120 slides: the find/upload-extraction pass (chunked,
 *     yields every 4 slides so the UI thread breathes).
 *   - extractPdfText over a 200-page pdf-lib document: the PDF upload path.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPptxDeck, renderPptx } from '../utils/pptxRenderer';
import { extractPdfText, extractPptxSlideTexts } from '../utils/extractText';

const bench = process.env.RUN_BENCH ? describe : describe.skip;
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

const slideXml = (n: number) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="7772400" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Slide ${n} title</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="2743200"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:p><a:r><a:t>Body line one for slide ${n} with pharmacology vocabulary.</a:t></a:r></a:p>
        <a:p><a:r><a:t>Body line two for slide ${n}: beta blockers, ACE inhibitors, diuretics.</a:t></a:r></a:p>
      </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

async function buildDeck(count: number): Promise<Blob> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from({ length: count }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}
</Relationships>`,
  );
  for (let i = 1; i <= count; i++) zip.file(`ppt/slides/slide${i}.xml`, slideXml(i));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

async function buildBigPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([595, 842]);
    for (let line = 0; line < 28; line++) {
      page.drawText(`Page ${p} line ${line + 1}: autonomic pharmacology paragraph with searchable vocabulary.`, {
        x: 50,
        y: 780 - line * 26,
        size: 10,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }
  return doc.save().then((u8) => new Uint8Array(u8));
}

bench('PPTX: lazy open vs eager render', () => {
  it('measures both paths over a 120-slide deck and logs the table', async () => {
    const blob = await buildDeck(120);

    const tEager0 = performance.now();
    const eager = await renderPptx(blob);
    const eagerMs = ms(tEager0);
    expect(eager.slides).toHaveLength(120);

    const tLazy0 = performance.now();
    const deck = await openPptxDeck(blob, { lazyMedia: true });
    const first = await deck.getSlide(1);
    const lazyOpenMs = ms(tLazy0);
    expect(deck.slideCount).toBe(120);
    expect(first?.title).toBe('Slide 1 title');

    const tFlip0 = performance.now();
    for (let n = 1; n <= 120; n++) {
      const s = await deck.getSlide(n);
      if (!s) throw new Error(`slide ${n} missing`);
    }
    const flipMs = ms(tFlip0);

    const tIndex0 = performance.now();
    const index = await deck.textIndex();
    const indexMs = ms(tIndex0);
    expect(index).toHaveLength(120);
    expect(index[119].text).toContain('Slide 120 title');

    deck.dispose();
    eager.dispose();

    console.table([
      { path: 'eager renderPptx (whole deck)', ms: eagerMs },
      { path: 'lazy open → first slide on screen', ms: lazyOpenMs },
      { path: 'lazy flip through all 120 slides', ms: flipMs },
      { path: 'textIndex (find / extraction pass)', ms: indexMs },
    ]);
  });

  it('keeps the open-to-first-slide cost flat as decks grow (30 / 120 / 240)', async () => {
    const rows: { deck: string; 'open+slide1 (ms)': number; 'eager render (ms)': number }[] = [];
    for (const n of [30, 120, 240]) {
      const blob = await buildDeck(n);

      const t0 = performance.now();
      const deck = await openPptxDeck(blob, { lazyMedia: true });
      await deck.getSlide(1);
      const openMs = ms(t0);
      expect(deck.slideCount).toBe(n);
      deck.dispose();

      const t1 = performance.now();
      const eager = await renderPptx(blob);
      const eagerMs = ms(t1);
      expect(eager.slides).toHaveLength(n);
      eager.dispose();

      rows.push({ deck: `${n} slides`, 'open+slide1 (ms)': openMs, 'eager render (ms)': eagerMs });
    }
    console.table(rows);
  });

  it('measures the upload-path extraction (extractPptxSlideTexts, 120 slides)', async () => {
    const blob = await buildDeck(120);
    const file = new File([blob], 'deck.pptx');
    const t0 = performance.now();
    const r = await extractPptxSlideTexts(file);
    const extractMs = ms(t0);
    expect(r.failed).toBe(false);
    expect(r.pages).toHaveLength(120);
    console.table([{ path: 'extractPptxSlideTexts (upload pipeline)', ms: extractMs }]);
  });
});

bench('PDF: upload-path extraction', () => {
  it('measures extractPdfText over a 200-page pdf-lib document', async () => {
    pdfjs.GlobalWorkerOptions.workerSrc = resolve(
      'node_modules/pdfjs-dist/build/pdf.worker.min.js',
    );
    const tGen0 = performance.now();
    const bytes = await buildBigPdf(200);
    const genMs = ms(tGen0);

    const t0 = performance.now();
    const r = await extractPdfText(bytes);
    const extractMs = ms(t0);
    expect(r.failed).toBe(false);
    expect(r.pages).toHaveLength(200);
    expect(r.pages[199].text).toContain('Page 200');
    console.table([
      { path: 'pdf-lib generate 200 pages (fixture cost)', ms: genMs },
      { path: 'extractPdfText 200 pages (upload pipeline)', ms: extractMs },
    ]);
  });
});
