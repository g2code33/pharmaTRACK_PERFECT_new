import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { convertPptxToPdf } from '../utils/pptxToPdf';

const converterSource = fs.readFileSync(path.resolve(__dirname, '../utils/pptxToPdf.ts'), 'utf8');
const readerSource = fs.readFileSync(path.resolve(__dirname, '../pages/SlideReader.tsx'), 'utf8');
const viewerSource = fs.readFileSync(path.resolve(__dirname, '../components/PptxViewer.tsx'), 'utf8');
const nativeSource = fs.readFileSync(path.resolve(__dirname, '../../src-tauri/src/main.rs'), 'utf8');

const slideXml = (title: string, body: string) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="7772400" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="2743200"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:rPr sz="2200"/><a:t>${body}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

async function buildPptx() {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml('Autonomic pharmacology', 'Alpha and beta receptors'));
  zip.file('ppt/slides/slide2.xml', slideXml('Clinical pearl', 'Avoid non-selective blockers in asthma'));
  return zip.generateAsync({ type: 'blob' });
}

describe('PPTX to PDF conversion', () => {
  it('generates a real PDF and preserves searchable slide text/page mapping', async () => {
    const fontBytes = fs.readFileSync(path.resolve(__dirname, '../assets/fonts/DejaVuSans.ttf'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(fontBytes) as Response);

    const progress: number[] = [];
    const result = await convertPptxToPdf(await buildPptx(), (p) => progress.push(p));

    expect(new TextDecoder().decode(result.pdfBytes.slice(0, 5))).toBe('%PDF-');
    expect(result.pageCount).toBe(2);
    expect(result.text).toContain('Autonomic pharmacology');
    expect(result.text).toContain('Avoid non-selective blockers in asthma');
    expect(result.pageTexts).toEqual([
      { page: 1, text: expect.stringContaining('Alpha and beta receptors') },
      { page: 2, text: expect.stringContaining('Clinical pearl') },
    ]);
    expect(progress[progress.length - 1]).toBeGreaterThanOrEqual(0.9);
  });

  it('prefers native LibreOffice conversion in the desktop app before browser fallback', () => {
    expect(converterSource).toContain('convertNativeMaterialPptxToPdf');
    expect(converterSource).toContain("convert_material_pptx_to_pdf_native");
    expect(nativeSource).toContain('LibreOffice/soffice');
    expect(nativeSource).toContain('--convert-to');
  });

  it('is an explicit export in the viewer, never a prerequisite for opening', () => {
    // The reader opens the ORIGINAL PPTX (lazy deck render) and contains no
    // conversion call at all; conversion runs only from the viewer's
    // user-initiated "Export as PDF" action.
    expect(readerSource).not.toContain('convertPptxToPdf');
    expect(readerSource).not.toContain('convertNativeMaterialPptxToPdf');
    expect(readerSource).not.toContain('saveFile(');
    expect(viewerSource).toContain('Export as PDF');
    expect(viewerSource).toContain("import('../utils/pptxToPdf')");
  });
});
