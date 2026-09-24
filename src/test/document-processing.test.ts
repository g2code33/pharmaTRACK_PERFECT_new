/**
 * Phase 13 — document processing.
 *
 * These use real ZIP containers rather than byte stubs: a DOCX is parsed by
 * mammoth, and a PPTX is parsed from its slide XML. The files are intentionally
 * created in memory so the tests remain offline and do not put study material
 * in the repository.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist';
import JSZip from 'jszip';
import {
  parseWordDocument,
  splitWordIntoSections,
  validateWordDocument,
} from '../utils/wordProcessor';
import { processAnyFile } from '../utils/universalProcessor';

const wordXml = (paragraphs: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}
  </w:body>
</w:document>`;

const bytesForBlob = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const slideXml = (title: string, body: string) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

async function makeDocx(paragraphs: string[]): Promise<File> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  zip.file('word/document.xml', wordXml(paragraphs));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File([bytesForBlob(bytes)], 'autonomic-lecture.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function makePdf(): File {
  const content = 'BT /F1 24 Tf 72 720 Td (Beta blockers) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1)
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([pdf], 'autonomic.pdf', { type: 'application/pdf' });
}

async function makePptx(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    slideXml('Beta blockers', 'Reduce heart rate and blood pressure'),
  );
  zip.file('ppt/slides/slide2.xml', slideXml('Safety', 'Check asthma and bradycardia'));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File([bytesForBlob(bytes)], 'autonomic-lecture.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

describe('DOCX processing', () => {
  it('extracts text and creates readable sections from a real DOCX container', async () => {
    const file = await makeDocx([
      'AUTONOMIC DRUGS',
      'Beta blockers reduce sympathetic tone.',
      'Monitor heart rate and bronchospasm.',
    ]);
    const result = await parseWordDocument(file);

    expect(result.text).toContain('AUTONOMIC DRUGS');
    expect(result.text).toContain('bronchospasm');
    expect(result.html).toContain('<p>');
    expect(result.pages.length).toBeGreaterThan(0);

    const sections = await splitWordIntoSections(file);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.map((section) => section.content).join(' ')).toContain('Beta blockers');
  });

  it('validates a readable DOCX and rejects a corrupt renamed file', async () => {
    const valid = await makeDocx(['A valid Word document with enough content to inspect.']);
    // The validator intentionally requires a 1 KB minimum, so pad the valid
    // package with an ignored entry without changing document content.
    const paddedZip = new JSZip();
    paddedZip.file('word/document.xml', wordXml(['A valid Word document.']));
    paddedZip.file('padding.bin', new Uint8Array(2048));
    const paddedBytes = await paddedZip.generateAsync({ type: 'uint8array' });
    const padded = new File([bytesForBlob(paddedBytes)], valid.name, { type: valid.type });

    expect(await validateWordDocument(padded)).toBe(true);
    const corrupt = new File(['not a zip'], 'broken.docx', { type: valid.type });
    expect(await validateWordDocument(corrupt)).toBe(false);
  });

  it('handles a large Word document without losing later content', async () => {
    const paragraphs = Array.from(
      { length: 600 },
      (_, i) => `Paragraph ${i + 1}: pharmacology revision content.`,
    );
    const result = await parseWordDocument(await makeDocx(paragraphs));

    expect(result.text).toContain('Paragraph 1');
    expect(result.text).toContain('Paragraph 600');
    expect(result.pages.length).toBeGreaterThan(20);
  });
});

describe('universal processor', () => {
  it('extracts text from a real PDF page', async () => {
    // Vitest does not resolve Vite's ?url worker import. Point pdf.js at the
    // same local worker file directly; no CDN or internet is involved.
    pdfjs.GlobalWorkerOptions.workerSrc = resolve(
      'node_modules/pdfjs-dist/build/pdf.worker.min.js',
    );
    const result = await processAnyFile(makePdf());
    expect(result.type).toBe('pdf');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain('Beta blockers');
    expect(result.text).toContain('--- Page 1 ---');
    URL.revokeObjectURL(result.previewUrl);
  });

  it('processes DOCX through the same browser-compatible byte reader used in production', async () => {
    const result = await processAnyFile(await makeDocx(['Mammoth extraction works offline.']));
    expect(result.type).toBe('docx');
    expect(result.text).toContain('Mammoth extraction works offline.');
    expect(result.pages[0].text).toContain('Mammoth extraction');
    URL.revokeObjectURL(result.previewUrl);
  });

  it('extracts PPTX slide text in slide order', async () => {
    const result = await processAnyFile(await makePptx());
    expect(result.type).toBe('pptx');
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.text).toContain('Beta blockers');
    expect(result.text).toContain('Check asthma');
    URL.revokeObjectURL(result.previewUrl);
  });
});
