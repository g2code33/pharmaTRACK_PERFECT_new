/**
 * Tests for the native .pptx renderer.
 *
 * PowerPoint files previously showed a dead-end "download it instead" screen.
 * These build real .pptx ZIPs in memory and parse them, so the XML handling is
 * exercised rather than mocked.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { renderPptx } from '../utils/pptxRenderer';

const slideXml = (title: string, bodies: string[], withImage = false) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    ${bodies.map((b) => `
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${b}</a:t></a:r></a:p></p:txBody>
    </p:sp>`).join('')}
    ${withImage ? '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>' : ''}
  </p:spTree></p:cSld>
</p:sld>`;

/** A paragraph split across several runs, as PowerPoint actually stores it. */
const splitRunsXml = `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>Beta </a:t></a:r><a:r><a:t>blockers</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const buildPptx = async (files: Record<string, string | Uint8Array>) => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'blob' });
};

describe('pptx renderer', () => {
  it('extracts titles and body text in slide order', async () => {
    const blob = await buildPptx({
      'ppt/slides/slide1.xml': slideXml('Introduction', ['First point', 'Second point']),
      'ppt/slides/slide2.xml': slideXml('Mechanisms', ['Blocks receptors']),
    });

    const deck = await renderPptx(blob);
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].title).toBe('Introduction');
    expect(deck.slides[0].body).toEqual(['First point', 'Second point']);
    expect(deck.slides[1].title).toBe('Mechanisms');
    deck.dispose();
  });

  it('sorts slide10 after slide2, not between slide1 and slide2', async () => {
    // Lexical sorting is the classic bug here and silently reorders decks.
    const files: Record<string, string> = {};
    for (const n of [1, 2, 10, 11]) files[`ppt/slides/slide${n}.xml`] = slideXml(`Slide ${n}`, []);

    const deck = await renderPptx(await buildPptx(files));
    expect(deck.slides.map((s) => s.title)).toEqual(['Slide 1', 'Slide 2', 'Slide 10', 'Slide 11']);
    deck.dispose();
  });

  it('joins runs within a paragraph so words are not split', async () => {
    const deck = await renderPptx(await buildPptx({ 'ppt/slides/slide1.xml': splitRunsXml }));
    // Naive per-run joining would give "Beta blockers" with a stray gap or
    // "Betablockers"; both break search.
    expect(deck.slides[0].title).toBe('Beta blockers');
    deck.dispose();
  });

  it('reads speaker notes and strips the repeated slide number', async () => {
    const notesXml = `<?xml version="1.0"?>
      <p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
               xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:p><a:r><a:t>Mention the contraindication in asthma</a:t></a:r></a:p>
        <a:p><a:r><a:t>1</a:t></a:r></a:p>
      </p:notes>`;

    const deck = await renderPptx(await buildPptx({
      'ppt/slides/slide1.xml': slideXml('Safety', []),
      'ppt/notesSlides/notesSlide1.xml': notesXml,
    }));

    expect(deck.slides[0].notes).toBe('Mention the contraindication in asthma');
    deck.dispose();
  });

  it('resolves embedded images through the relationship file', async () => {
    const rels = `<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
      </Relationships>`;

    const deck = await renderPptx(await buildPptx({
      'ppt/slides/slide1.xml': slideXml('Diagram', [], true),
      'ppt/slides/_rels/slide1.xml.rels': rels,
      'ppt/media/image1.png': new Uint8Array([137, 80, 78, 71]),
    }));

    expect(deck.slides[0].images).toHaveLength(1);
    expect(deck.slides[0].images[0]).toMatch(/^blob:/);
    deck.dispose();
  });

  it('produces combined text for search and AI context', async () => {
    const deck = await renderPptx(await buildPptx({
      'ppt/slides/slide1.xml': slideXml('Pharmacokinetics', ['Absorption and distribution']),
    }));

    expect(deck.fullText).toContain('Pharmacokinetics');
    expect(deck.fullText).toContain('Absorption and distribution');
    deck.dispose();
  });

  it('handles a deck with no slides without throwing', async () => {
    const deck = await renderPptx(await buildPptx({ 'ppt/presentation.xml': '<p:presentation/>' }));
    expect(deck.slides).toEqual([]);
    deck.dispose();
  });
});
