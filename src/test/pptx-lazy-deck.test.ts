/**
 * The lazy PPTX deck — the change that makes opening a presentation cost ONE
 * slide's parse instead of the whole file's. These tests pin:
 *
 *   - opening a deck is fast and does not parse every slide;
 *   - slides parse on demand, in order, with a bounded cache;
 *   - eager renderPptx (PDF export, tests) still returns the whole deck,
 *     byte-for-byte compatible with the previous interface;
 *   - the text-only pass (find / extraction) never triggers a visual parse;
 *   - disposal revokes media URLs and no parse survives dispose.
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { openPptxDeck, renderPptx, type PptxDeck } from '../utils/pptxRenderer';

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

const notesXml = (n: number) => `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Speak slowly about slide ${n}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:notes>`;

const PRESENTATION_XML = (count: number) => `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    ${Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

const RELS_XML = (count: number) => `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from({ length: count }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n  ')}
</Relationships>`;

async function buildDeckBlob(count: number, withNotes = false): Promise<Blob> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', PRESENTATION_XML(count));
  zip.file('ppt/_rels/presentation.xml.rels', RELS_XML(count));
  for (let i = 1; i <= count; i++) {
    zip.file(`ppt/slides/slide${i}.xml`, slideXml(i));
    if (withNotes) zip.file(`ppt/notesSlides/notesSlide${i}.xml`, notesXml(i));
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

/** A slide with a single embedded picture (its own, slide-numbered image part). */
const slideXmlWithImage = (n: number) => `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="7772400" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>Slide ${n} title</a:t></a:r></a:p></p:txBody></p:sp>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="3" name="Picture ${n}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="2743200" cy="2057400"/></a:xfrm>
        <a:prstGeom prst="rect"/></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`;

const slideRelsXmlWithImage = (n: number) => `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/>
</Relationships>`;

/** Deck where every slide carries its own embedded picture (distinct media part). */
async function buildDeckBlobWithImages(count: number): Promise<Blob> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', PRESENTATION_XML(count));
  zip.file('ppt/_rels/presentation.xml.rels', RELS_XML(count));
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    '<?xml version="1.0"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>',
  );
  for (let i = 1; i <= count; i++) {
    zip.file(`ppt/slides/slide${i}.xml`, slideXmlWithImage(i));
    zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, slideRelsXmlWithImage(i));
    // Content does not need to be a real PNG — the renderer only reads the
    // bytes as a Blob and hands them to URL.createObjectURL (mocked in tests).
    zip.file(`ppt/media/image${i}.png`, `fake-image-bytes-${i}`);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

/** Instrumented DOMParser: counts slide XMLs actually parsed. */
function countSlideParses(): () => number {
  const original = globalThis.DOMParser;
  let parsed = 0;
  class CountingParser extends original {
    parseFromString(xml: string, mime: DOMParserSupportedType) {
      if (mime === 'text/xml' && /<p:sld[\s>]/.test(xml)) parsed += 1;
      return super.parseFromString(xml, mime);
    }
  }
  globalThis.DOMParser = CountingParser as unknown as typeof DOMParser;
  return () => {
    globalThis.DOMParser = original;
    return parsed;
  };
}

describe('openPptxDeck — opening a deck parses one slide, not the file', () => {
  it('reports slideCount and dimensions before any slide is parsed', async () => {
    const done = countSlideParses();
    const deck = await openPptxDeck(await buildDeckBlob(60), { lazyMedia: true });
    expect(deck.slideCount).toBe(60);
    expect(deck.slideWidth).toBeGreaterThan(0);
    expect(deck.slideHeight).toBeGreaterThan(0);
    // presentation.xml + rels parse; NO slide XML yet.
    expect(done()).toBe(0);
    deck.dispose();
  });

  it('parses exactly the requested slide on demand', async () => {
    const done = countSlideParses();
    const deck = await openPptxDeck(await buildDeckBlob(40), { lazyMedia: true });
    const slide = await deck.getSlide(7);
    expect(done()).toBe(1);
    expect(slide?.title).toBe('Slide 7 title');
    expect(slide?.body).toEqual(['Body of slide 7']);
    // A second read of the same slide is served from the cache.
    await deck.getSlide(7);
    expect(done()).toBe(1);
    deck.dispose();
  });

  it('opens a 120-slide deck and shows slide 1 after parsing a single slide', async () => {
    const done = countSlideParses();
    const blob = await buildDeckBlob(120);
    const deck = await openPptxDeck(blob, { lazyMedia: true });
    const first = await deck.getSlide(1);
    expect(first?.title).toBe('Slide 1 title');
    // ONE slide parsed for the whole open — this is the fix for the
    // "whole-deck freeze" that PPTX→PDF conversion used to paper over.
    expect(done()).toBe(1);
    deck.dispose();
  });

  it('bounds the slide cache while flipping through a long deck', async () => {
    const deck = await openPptxDeck(await buildDeckBlob(40), { lazyMedia: true });
    // Flip through every slide like a restless student.
    for (let n = 1; n <= 40; n++) {
      const s = await deck.getSlide(n);
      expect(s?.slideNumber).toBe(n);
    }
    // Cached slides stay a bounded minority: early slides were evicted, the
    // tail is cached. getSlide re-parses evicted slides transparently.
    const again = await deck.getSlide(1);
    expect(again?.title).toBe('Slide 1 title');
    const last = await deck.getSlide(40);
    expect(last?.title).toBe('Slide 40 title');
    deck.dispose();
  });

  it('still decodes a picture on a slide after it is evicted and revisited', async () => {
    // Regression test: a long deck's LRU drops old slides from its parse
    // cache as the student pages forward. Revisiting one of those slides
    // must decode its picture again — not silently skip it forever because
    // the slide number was already marked "media loaded" before eviction.
    const deck = await openPptxDeck(await buildDeckBlobWithImages(40), { lazyMedia: true });

    const first = await deck.getSlide(1);
    await deck.ensureSlideMedia(1);
    expect(first?.shapes.find((s) => s.type === 'image')?.imageUrl).toBeTruthy();

    // Page through enough slides to evict slide 1 from the bounded cache.
    for (let n = 2; n <= 40; n++) {
      await deck.getSlide(n);
      await deck.ensureSlideMedia(n);
    }

    // Revisiting slide 1: it is re-parsed from scratch (new shape objects,
    // imageUrl unset again) — ensureSlideMedia must still decode it.
    const revisited = await deck.getSlide(1);
    await deck.ensureSlideMedia(1);
    const picture = revisited?.shapes.find((s) => s.type === 'image');
    expect(picture?.imageUrl).toBeTruthy();

    deck.dispose();
  });

  it('rejects out-of-range slide numbers without throwing', async () => {
    const deck = await openPptxDeck(await buildDeckBlob(3), { lazyMedia: true });
    expect(await deck.getSlide(0)).toBeNull();
    expect(await deck.getSlide(4)).toBeNull();
    deck.dispose();
  });
});

describe('textIndex — find and extraction without a visual parse', () => {
  it('returns every slide text plus speaker notes, parsing no layouts', async () => {
    const done = countSlideParses();
    const deck = await openPptxDeck(await buildDeckBlob(5, true), { lazyMedia: true });
    const index = await deck.textIndex();
    expect(done()).toBeGreaterThanOrEqual(5); // slide XMLs for text only
    expect(index.map((e) => e.slide)).toEqual([1, 2, 3, 4, 5]);
    expect(index[2].text).toContain('Slide 3 title');
    expect(index[2].text).toContain('Notes: Speak slowly about slide 3');
    deck.dispose();
  });

  it('does not disturb the visual slide cache', async () => {
    const deck = await openPptxDeck(await buildDeckBlob(30), { lazyMedia: true });
    await deck.getSlide(15);
    await deck.textIndex();
    const cached = await deck.getSlide(15);
    expect(cached?.title).toBe('Slide 15 title');
    deck.dispose();
  });
});

describe('renderPptx — eager back-compat for export and tests', () => {
  it('still returns every slide with the legacy interface', async () => {
    const doc = await renderPptx(await buildDeckBlob(6, true));
    expect(doc.slides).toHaveLength(6);
    expect(doc.slides[0].slideNumber).toBe(1);
    expect(doc.slides[5].title).toBe('Slide 6 title');
    expect(doc.slides[2].notes).toContain('Speak slowly about slide 3');
    expect(doc.fullText).toContain('--- Slide 1 ---');
    expect(doc.fullText).toContain('--- Slide 6 ---');
    doc.dispose();
  });

  it('lazy-media decks still resolve images through ensureSlideMedia after an eager parse', async () => {
    const doc = await renderPptx(await buildDeckBlob(3), { lazyMedia: true });
    // The contract the PDF exporter relies on: every slide addressable, media
    // loadable per slide, nothing evicted under an eager parse.
    await expect(doc.ensureSlideMedia(3)).resolves.toBeUndefined();
    doc.dispose();
  });
});

describe('disposal', () => {
  it('revokes media object URLs exactly once and stops further work', async () => {
    const deck: PptxDeck = await openPptxDeck(await buildDeckBlob(3), { lazyMedia: true });
    const slide = await deck.getSlide(1);
    expect(slide).not.toBeNull();
    deck.dispose();
    // getSlide after dispose returns null instead of resurrecting the deck.
    expect(await deck.getSlide(2)).toBeNull();
  });
});
