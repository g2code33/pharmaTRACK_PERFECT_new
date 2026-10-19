/**
 * Geometry tests for the native .pptx renderer.
 *
 * Builds real .pptx ZIP structures (4:3 master size, explicit shape
 * positions, fonts, fills, tables, groups, images, gradients, speaker
 * notes) and asserts the parsed visual model is correct — these fixtures
 * exercise the same XML PowerPoint writes, so the maths is checked rather
 * than mocked.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { renderPptx, emuToPx } from '../utils/pptxRenderer';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMG_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const NOTES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

/** 4:3 → 960 × 720 px. sldIdLst deliberately lists slide2 BEFORE slide1. */
const presentationXml = `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId1"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

const presentationRels = `<?xml version="1.0"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="${SLIDE_REL}" Target="slides/slide2.xml"/>
</Relationships>`;

/** The "rich" slide: placed shapes, fonts, fill, table, image, group. */
const richSlideXml = `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FDF6E3"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Main Slide</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body 2"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="2743200"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr anchor="ctr"/>
          <a:p>
            <a:pPr algn="ctr"><a:buChar val="•"/></a:pPr>
            <a:r>
              <a:rPr lang="en-US" sz="2400" b="1">
                <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
                <a:latin typeface="Arial"/>
              </a:rPr>
              <a:t>Red bold 24pt</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Box 3"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>
          <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="2D6A4F"/></a:solidFill>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="9" name="Transformed Color"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="609600" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>
          <a:solidFill><a:srgbClr val="336699"><a:lumMod val="50000"/><a:lumOff val="50000"/></a:srgbClr></a:solidFill>
          <a:ln><a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="5" name="Picture"/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="1828800" y="3657600"/><a:ext cx="1828800" cy="1828800"/></a:xfrm></p:spPr>
      </p:pic>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="5486400"/><a:ext cx="9144000" cy="1371600"/></p:xfrm>
        <a:graphic><a:graphicData uri="${A}/table">
          <a:tbl>
            <a:tblGrid><a:gridCol w="4572000"/><a:gridCol w="4572000"/></a:tblGrid>
            <a:tr h="685800">
              <a:tc>
                <a:txBody><a:p><a:r><a:rPr sz="1400" b="1"/><a:t>Drug</a:t></a:r></a:p></a:txBody>
                <a:tcPr><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></a:tcPr>
              </a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>Dose</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            </a:tr>
            <a:tr h="685800">
              <a:tc><a:txBody><a:p><a:r><a:t>Beta blocker</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>50 mg</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            </a:tr>
          </a:tbl>
        </a:graphicData></a:graphic>
      </p:graphicFrame>
      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="7" name="Group"/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr>
          <a:xfrm>
            <a:off x="914400" y="0"/><a:ext cx="2743200" cy="914400"/>
            <a:chOff x="0" y="0"/><a:chExt cx="1371600" cy="457200"/>
          </a:xfrm>
        </p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="8" name="GChild"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="457200"/></a:xfrm></p:spPr>
          <p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>Grouped</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:grpSp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

/** The "gradient" slide: gradient background + auto-numbered bullets. */
const gradientSlideXml = `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld>
    <p:bg><p:bgPr><a:gradFill><a:gsLst>
      <a:gs pos="0"><a:srgbClr val="102030"/></a:gs>
      <a:gs pos="100000"><a:srgbClr val="A0B0C0"/></a:gs>
    </a:gsLst></a:gradFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Gradient Slide</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body 2"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>First</a:t></a:r></a:p>
          <a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>Second</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

const slideRels = `<?xml version="1.0"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/image1.png"/>
  <Relationship Id="rId3" Type="${NOTES_REL}" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`;

/** slide1 is the 2nd slide in sldIdLst order, so its trailing "2" must be stripped. */
const notesXml = `<?xml version="1.0"?>
<p:notes xmlns:p="${P}" xmlns:a="${A}">
  <a:p><a:r><a:t>Mention the contraindication</a:t></a:r></a:p>
  <a:p><a:r><a:t>2</a:t></a:r></a:p>
</p:notes>`;

const coreXml = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Geometry Fixture</dc:title>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-03-01T10:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-05T09:30:00Z</dcterms:modified>
</cp:coreProperties>`;

const buildDeck = async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', presentationXml);
  zip.file('ppt/_rels/presentation.xml.rels', presentationRels);
  zip.file('ppt/slides/slide1.xml', richSlideXml);
  zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
  zip.file('ppt/slides/slide2.xml', gradientSlideXml);
  zip.file('ppt/notesSlides/notesSlide1.xml', notesXml);
  zip.file('ppt/media/image1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  zip.file('docProps/core.xml', coreXml);
  return (await zip.generateAsync({ type: 'blob' })) as Blob;
};

describe('pptx renderer — geometry', () => {
  it('reads slide size from presentation.xml in pixels', async () => {
    const deck = await renderPptx(await buildDeck());
    // 9144000 EMU / 9525 = 960 px
    expect(deck.slideWidth).toBe(960);
    expect(deck.slideHeight).toBe(720);
    deck.dispose();
  });

  it('follows sldIdLst order, not filename order', async () => {
    const deck = await renderPptx(await buildDeck());
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].title).toBe('Gradient Slide');
    expect(deck.slides[1].title).toBe('Main Slide');
    deck.dispose();
  });

  it('parses run-level fonts, colour, alignment and bullets', async () => {
    const deck = await renderPptx(await buildDeck());
    const main = deck.slides[1];
    const body = main.shapes.find((s) => s.text?.paragraphs[0]?.runs[0]?.text === 'Red bold 24pt');
    expect(body).toBeDefined();
    // 914400, 1828800 EMU → 96, 192 px; 7315200 × 2743200 → 768 × 288 px
    expect(body!.x).toBeCloseTo(96, 6);
    expect(body!.y).toBeCloseTo(192, 6);
    expect(body!.w).toBeCloseTo(768, 6);
    expect(body!.h).toBeCloseTo(288, 6);
    const p = body!.text!.paragraphs[0];
    expect(p.align).toBe('center');
    expect(p.bullet).toBe('•');
    expect(body!.text!.anchor).toBe('ctr');
    const run = p.runs[0];
    expect(run.sizePt).toBe(24);
    expect(run.bold).toBe(true);
    expect(run.color).toBe('#ff0000');
    expect(run.font).toBe('Arial');
    deck.dispose();
  });

  it('parses shape fills, borders and preset geometry', async () => {
    const deck = await renderPptx(await buildDeck());
    const box = deck.slides[1].shapes.find((s) => s.geom === 'roundRect');
    expect(box).toBeDefined();
    expect(box!.x).toBe(0);
    expect(box!.y).toBe(0);
    expect(box!.w).toBeCloseTo(48, 6);
    expect(box!.h).toBeCloseTo(48, 6);
    expect(box!.fill).toBe('#2d6a4f');
    expect(box!.borderColor).toBe('#111111');
    expect(box!.borderWidth).toBeCloseTo(2, 6);

    const transformed = deck.slides[1].shapes.find((s) => s.fill === '#99b3cc');
    expect(transformed).toBeDefined();
    expect(transformed!.borderColor).toBe('rgba(255, 0, 0, 0.5)');
    deck.dispose();
  });

  it('positions embedded images from their xfrm', async () => {
    const deck = await renderPptx(await buildDeck());
    const pic = deck.slides[1].shapes.find((s) => s.type === 'image');
    expect(pic).toBeDefined();
    expect(pic!.x).toBeCloseTo(192, 6);
    expect(pic!.y).toBeCloseTo(384, 6);
    expect(pic!.w).toBeCloseTo(192, 6);
    expect(pic!.h).toBeCloseTo(192, 6);
    expect(pic!.imageUrl).toMatch(/^blob:/);
    deck.dispose();
  });

  it('does not decode every slide image until that slide is shown', async () => {
    const deck = await renderPptx(await buildDeck(), { lazyMedia: true });
    const pic = deck.slides[1].shapes.find((s) => s.type === 'image');
    expect(pic).toBeDefined();
    expect(pic!.x).toBeCloseTo(192, 6);
    expect(pic!.imageUrl).toBeUndefined();
    await deck.ensureSlideMedia(2);
    expect(pic!.imageUrl).toMatch(/^blob:/);
    deck.dispose();
  });

  it('parses tables: grid columns, rows, cell text/format/fill', async () => {
    const deck = await renderPptx(await buildDeck());
    const table = deck.slides[1].shapes.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    expect(table!.x).toBe(0);
    expect(table!.y).toBeCloseTo(576, 6);
    expect(table!.w).toBeCloseTo(960, 6);
    expect(table!.h).toBeCloseTo(144, 6);
    const t = table!.table!;
    expect(t.colWidths).toEqual([480, 480]);
    expect(t.rowHeights).toEqual([72, 72]);
    expect(t.cells[0][0]).toMatchObject({ text: 'Drug', sizePt: 14, bold: true, fill: '#ddeeff' });
    expect(t.cells[1][1].text).toBe('50 mg');
    // Table cell text must be part of the searchable slide text.
    expect(deck.slides[1].text).toContain('Beta blocker');
    expect(deck.slides[1].text).toContain('50 mg');
    deck.dispose();
  });

  it('maps group children through chOff/chExt coordinate spaces', async () => {
    const deck = await renderPptx(await buildDeck());
    const grouped = deck.slides[1].shapes.find((s) => s.text?.paragraphs[0]?.runs[0]?.text === 'Grouped');
    expect(grouped).toBeDefined();
    // Group: off(914400,0), ext 2× child space → child box (0,0,1371600,457200)
    // lands at (914400, 0) with double the size.
    expect(grouped!.x).toBeCloseTo(emuToPx(914400), 6);
    expect(grouped!.y).toBeCloseTo(0, 6);
    expect(grouped!.w).toBeCloseTo(emuToPx(2743200), 6);
    expect(grouped!.h).toBeCloseTo(emuToPx(914400), 6);
    // Group scale must reach the text sizing.
    expect(grouped!.textScale).toBeCloseTo(2, 6);
    deck.dispose();
  });

  it('parses solid and gradient slide backgrounds', async () => {
    const deck = await renderPptx(await buildDeck());
    expect(deck.slides[1].background).toBe('#fdf6e3');
    expect(deck.slides[0].background).toContain('linear-gradient');
    expect(deck.slides[0].background).toContain('#102030');
    expect(deck.slides[0].background).toContain('#a0b0c0');
    deck.dispose();
  });

  it('resolves auto-numbered bullets sequentially', async () => {
    const deck = await renderPptx(await buildDeck());
    const body = deck.slides[0].shapes.find((s) => s.text?.paragraphs.some((p) => p.runs[0]?.text === 'First'));
    expect(body).toBeDefined();
    const paras = body!.text!.paragraphs;
    expect(paras[0].bullet).toBe('1.');
    expect(paras[1].bullet).toBe('2.');
    deck.dispose();
  });

  it('keeps notes (stripping the repeated slide number) and metadata', async () => {
    const deck = await renderPptx(await buildDeck());
    expect(deck.slides[1].notes).toBe('Mention the contraindication');
    expect(deck.dates?.created).toBe('2024-03-01T10:00:00Z');
    expect(deck.dates?.modified).toBe('2024-05-05T09:30:00Z');
    expect(deck.fileSize).toBeGreaterThan(0);
    deck.dispose();
  });

  it('defaults to 16:9 (1280×720) when presentation.xml is absent', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
              <p:txBody><a:p><a:r><a:t>T</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:sld>`,
    );
    const deck = await renderPptx((await zip.generateAsync({ type: 'blob' })) as Blob);
    expect(deck.slideWidth).toBe(1280);
    expect(deck.slideHeight).toBe(720);
    // Placeholders without xfrm get sensible default geometry, not 0×0.
    const title = deck.slides[0].shapes.find((s) => s.isTitle);
    expect(title).toBeDefined();
    expect(title!.w).toBeGreaterThan(0);
    expect(title!.h).toBeGreaterThan(0);
    deck.dispose();
  });

  it('rejects files that are not a valid .pptx zip', async () => {
    await expect(renderPptx(new Blob(['this is not a zip file']))).rejects.toBeTruthy();
  });
});

describe('pptx renderer \u2014 bullet glyphs and notes scoping', () => {
  it('translates Wingdings and Symbol bullet glyphs out of the private use area', async () => {
    const { normalizeBulletGlyph } = await import('../utils/pptxRenderer');
    // The real glyphs at those font positions (verified against the fonts'
    // own tables): Wingdings 0xB7 is a clock face, 0x76 the four-diamond
    // cluster, and the classic square bullet lives at 0xA7 ("\u00A7").
    expect(normalizeBulletGlyph('\uF0B7', 'Wingdings')).toBe('\u{1F550}');
    expect(normalizeBulletGlyph('\uF076', 'Wingdings')).toBe('\u2756');
    // PowerPoint's square bullet: buChar "\u00A7" in Wingdings space.
    expect(normalizeBulletGlyph('\u00A7', 'Wingdings')).toBe('\u25AA');
    // The same private-use code point in Symbol space maps through Symbol.
    expect(normalizeBulletGlyph('\uF0B7', 'Symbol')).toBe('\u2022');
    // Unknown private-use characters fall back to a clean bullet, never
    // tofu; mapped positions (Wingdings 'a' is the Cancer zodiac) resolve to
    // their real glyphs.
    expect(normalizeBulletGlyph('\uF0FF', 'Wingdings')).toBe('\u2022');
    expect(normalizeBulletGlyph('\uF061', 'Wingdings')).toBe('\u264B');
    // Normal bullets pass through untouched.
    expect(normalizeBulletGlyph('\u2022', 'Arial')).toBe('\u2022');
    expect(normalizeBulletGlyph('-', 'Arial')).toBe('-');
    expect(normalizeBulletGlyph('o', 'Arial')).toBe('o');
    // Control characters are never shown as bullets.
    expect(normalizeBulletGlyph('\u0000', 'Arial')).toBe('\u2022');
  });

  it('renders Wingdings buChar bullets as clean glyphs in parsed paragraphs', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
         <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
         <p:sldSz cx="9144000" cy="6858000"/>
       </p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
       </Relationships>`,
    );
    // The bullet glyph is the Wingdings F0B7 character, written as an XML
    // numeric character reference exactly like the byte-level original.
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>
         <p:sp>
           <p:nvSpPr><p:cNvPr id="2" name="Body 1"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
           <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="7315200" cy="2743200"/></a:xfrm></p:spPr>
           <p:txBody>
             <a:p>
               <a:pPr>
                 <a:buFont typeface="Wingdings"/>
                 <a:buChar char="&#xF0B7;"/>
               </a:pPr>
               <a:r><a:t>Wingdings bullet line</a:t></a:r>
             </a:p>
           </p:txBody>
         </p:sp>
       </p:spTree></p:cSld></p:sld>`,
    );
    const deck = await renderPptx((await zip.generateAsync({ type: 'blob' })) as Blob);
    const body = deck.slides[0].shapes.find((s) => s.type === 'text');
    const para = body?.text?.paragraphs[0];
    expect(para?.bullet).toBe('\u{1F550}');
    deck.dispose();
  });

  it('scopes notes to the body placeholder when the notes slide mirrors slide text', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
         <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
         <p:sldSz cx="9144000" cy="6858000"/>
       </p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
       </Relationships>`,
    );
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>
         <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
           <p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp>
       </p:spTree></p:cSld></p:sld>`,
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId2" Type="${NOTES_REL}" Target="../notesSlides/notesSlide1.xml"/>
       </Relationships>`,
    );
    // A notes slide the way PowerPoint writes it: the notes live in the body
    // placeholder; some exporters also mirror the slide's own text into a
    // separate shape, which the notes pane must NOT show.
    zip.file(
      'ppt/notesSlides/notesSlide1.xml',
      `<p:notes xmlns:p="${P}" xmlns:a="${A}">
         <p:cSld><p:spTree>
           <p:sp>
             <p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
             <p:txBody>
               <a:p><a:r><a:t>Actual speaker note line one</a:t></a:r></a:p>
               <a:p><a:r><a:t>Actual speaker note line two</a:t></a:r></a:p>
             </p:txBody>
           </p:sp>
           <p:sp>
             <p:nvSpPr><p:cNvPr id="4" name="Mirror of slide text"/><p:nvPr/></p:nvSpPr>
             <p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody>
           </p:sp>
         </p:spTree></p:cSld>
       </p:notes>`,
    );
    const deck = await renderPptx((await zip.generateAsync({ type: 'blob' })) as Blob);
    expect(deck.slides[0].notes).toBe('Actual speaker note line one\nActual speaker note line two');
    deck.dispose();
  });
});

describe('pptx renderer — video shapes', () => {
  const VIDEO_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video';
  const MEDIA_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/media';

  const buildVideoDeck = async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
       </Relationships>`,
    );
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="Video 1"/>
        <p:cNvPicPr/>
        <p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="2743200"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/poster1.png"/>
         <Relationship Id="rId3" Type="${VIDEO_REL}" Target="../media/clip1.mp4"/>
       </Relationships>`,
    );
    zip.file('ppt/media/poster1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    zip.file('ppt/media/clip1.mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    return (await zip.generateAsync({ type: 'blob' })) as Blob;
  };

  it('recognises a:videoFile pictures as playable video shapes, poster included', async () => {
    const deck = await renderPptx(await buildVideoDeck());
    const video = deck.slides[0].shapes.find((s) => s.type === 'video');
    expect(video).toBeDefined();
    expect(video!.videoUrl).toMatch(/^blob:/);
    expect(video!.imageUrl).toMatch(/^blob:/); // poster frame, same as a normal picture
    expect(video!.w).toBeCloseTo(384, 6);
    expect(video!.h).toBeCloseTo(288, 6);
    deck.dispose();
  });

  it('defers video resolution for lazy decks until the slide is shown, same as images', async () => {
    const deck = await renderPptx(await buildVideoDeck(), { lazyMedia: true });
    const video = deck.slides[0].shapes.find((s) => s.type === 'video');
    expect(video).toBeDefined();
    expect(video!.videoUrl).toBeUndefined();
    expect(video!.imageUrl).toBeUndefined();
    await deck.ensureSlideMedia(1);
    expect(video!.videoUrl).toMatch(/^blob:/);
    expect(video!.imageUrl).toMatch(/^blob:/);
    deck.dispose();
  });

  it('also recognises the PowerPoint-2010+ p14:media embed form', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
       </Relationships>`,
    );
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="Video 1"/>
        <p:cNvPicPr/>
        <p:nvPr>
          <p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">
            <p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId3"/>
          </p:ext></p:extLst>
        </p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/poster1.png"/>
         <Relationship Id="rId3" Type="${MEDIA_REL}" Target="../media/clip1.mp4"/>
       </Relationships>`,
    );
    zip.file('ppt/media/poster1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    zip.file('ppt/media/clip1.mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    const deck = await renderPptx((await zip.generateAsync({ type: 'blob' })) as Blob);
    const video = deck.slides[0].shapes.find((s) => s.type === 'video');
    expect(video).toBeDefined();
    expect(video!.videoUrl).toMatch(/^blob:/);
    deck.dispose();
  });

  it('falls back to the poster frame when the clip itself cannot be resolved (linked, not embedded)', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
       </Relationships>`,
    );
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="Video 1"/>
        <p:cNvPicPr/>
        <p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1371600"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
    );
    // rId3 points at a relationship whose target is simply never present in
    // the package — the "linked, not embedded" case this renderer cannot
    // fetch (no network access to an external file by design).
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/poster1.png"/>
         <Relationship Id="rId3" Type="${VIDEO_REL}" TargetMode="External" Target="file:///C:/videos/clip1.mp4"/>
       </Relationships>`,
    );
    zip.file('ppt/media/poster1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const deck = await renderPptx((await zip.generateAsync({ type: 'blob' })) as Blob);
    const video = deck.slides[0].shapes.find((s) => s.type === 'video');
    expect(video).toBeDefined();
    expect(video!.videoUrl).toBeUndefined();
    expect(video!.imageUrl).toMatch(/^blob:/);
    deck.dispose();
  });
});

describe('pptx renderer — picture-filled autoshapes', () => {
  /**
   * Real decks sometimes fill a plain autoshape (a rounded rectangle "card",
   * for example) with a picture via <a:blipFill> instead of using a
   * dedicated <p:pic>. Before this, the renderer only ever treated <p:pic>
   * as an image, so this shape — and the photo inside it — simply vanished.
   */
  const buildFillDeck = async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId1" Type="${SLIDE_REL}" Target="slides/slide1.xml"/>
       </Relationships>`,
    );
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Photo card"/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1371600"/></a:xfrm>
        <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
        <a:blipFill><a:blip r:embed="rId2"/></a:blipFill>
      </p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/photo1.png"/>
       </Relationships>`,
    );
    zip.file('ppt/media/photo1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    return (await zip.generateAsync({ type: 'blob' })) as Blob;
  };

  it('renders a blipFill-on-autoshape picture instead of dropping the shape', async () => {
    const deck = await renderPptx(await buildFillDeck());
    const card = deck.slides[0].shapes.find((s) => s.geom === 'roundRect');
    expect(card).toBeDefined();
    expect(card!.fill).toMatch(/^url\("blob:.*"\) center \/ 100% 100% no-repeat$/);
    deck.dispose();
  });

  it('defers the fill picture for lazy decks until the slide is shown, same as a real picture', async () => {
    const deck = await renderPptx(await buildFillDeck(), { lazyMedia: true });
    const card = deck.slides[0].shapes.find((s) => s.geom === 'roundRect');
    expect(card).toBeDefined();
    expect(card!.fill).toBeUndefined();
    await deck.ensureSlideMedia(1);
    expect(card!.fill).toMatch(/^url\("blob:.*"\) center \/ 100% 100% no-repeat$/);
    deck.dispose();
  });
});
