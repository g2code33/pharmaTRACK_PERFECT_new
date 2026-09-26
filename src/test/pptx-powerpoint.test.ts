/**
 * Real-PowerPoint parsing tests.
 *
 * The fixtures reproduce what PowerPoint (and python-pptx's default Office
 * template) actually writes: `ctrTitle` placeholders, master `p:txStyles`,
 * layout placeholder geometry/lstStyle, a themed `a:clrScheme`/`a:fontScheme`
 * with `p:clrMap`, `a:sysClr`/`p:bgRef` backgrounds, `a:srcRect` pictures and
 * merged table cells (gridSpan/rowSpan + hMerge/vMerge).
 *
 * Without these the renderer looks fine on minimal decks but renders real
 * files at guessed sizes, colours and fonts — so they are regression tests for
 * genuine PowerPoint output, not for our own XML.
 */
import { describe, it, expect } from 'vitest';

import { renderPptx, emuToPx } from '../utils/pptxRenderer';
import { buildPowerPointDeck } from './pptx-powerpoint-fixture';

const px = (emu: number) => Math.round(emuToPx(emu));
const shapeAt = async (index: number) => {
  const deck = await renderPptx(await buildPowerPointDeck());
  return { deck, shape: deck.slides[0].shapes[index] };
};

describe('real PowerPoint structure', () => {
  it('follows sldSz and recognises ctrTitle as the slide title', async () => {
    const deck = await renderPptx(await buildPowerPointDeck());
    expect(Math.round(deck.slideWidth)).toBe(1280);
    expect(Math.round(deck.slideHeight)).toBe(720);

    const title = deck.slides[0].shapes.find((s) => s.isTitle)!;
    expect(title.text?.paragraphs[0].runs[0].text).toBe('Cardiovascular Pharmacology');
    // 44pt comes from the master's p:titleStyle, not from a guess.
    expect(title.text?.defaultSizePt).toBe(44);
    expect(title.text?.levels[0]).toMatchObject({
      sizePt: 44,
      align: 'center',
      bullet: null,
      color: '#000000', // schemeClr tx1 → clrMap → sysClr windowText
      font: 'Georgia', // +mj-lt → theme majorFont
    });
    expect(title.text?.anchor).toBe('ctr'); // inherited from the layout placeholder
    expect(deck.slides[0].title).toBe('Cardiovascular Pharmacology');
    expect(deck.slides[0].body).toContain('Lecture 1');
    deck.dispose();
  });

  it('takes placeholder geometry from the slide layout (no xfrm on the slide)', async () => {
    const { deck, shape: title } = await shapeAt(0);
    expect(px(685800)).toBe(72);
    expect(Math.round(title.x)).toBe(72);
    expect(Math.round(title.y)).toBe(px(2130425));
    expect(Math.round(title.w)).toBe(816);
    expect(Math.round(title.h)).toBe(px(1470025));

    const sub = deck.slides[0].shapes[1];
    expect(Math.round(sub.x)).toBe(144);
    expect(Math.round(sub.y)).toBe(408);
    expect(Math.round(sub.w)).toBe(672);
    expect(Math.round(sub.h)).toBe(184);
    // The layout's own lstStyle (24pt) beats the master's bodyStyle (32pt).
    expect(sub.text?.levels[0]).toMatchObject({ sizePt: 24, font: 'Verdana' });
    deck.dispose();
  });

  it('inherits body bullets, sizes and margins down to deeper levels', async () => {
    const { deck } = await shapeAt(3);
    const body = deck.slides[0].shapes.find((s) => s.text?.paragraphs.length === 2)!;
    expect(body.text?.levels[0]).toMatchObject({
      sizePt: 32, // bodyStyle lvl1
      bullet: '•',
      indentPx: 36, // marL 342900 EMU
      font: 'Verdana', // +mn-lt → theme minorFont
    });
    expect(body.text?.levels[1]).toMatchObject({
      sizePt: 28, // bodyStyle lvl2
      bullet: '–', // en dash, as PowerPoint writes it
      indentPx: Math.round(emuToPx(742950)),
    });
    expect(body.text?.paragraphs[1].level).toBe(1);
    deck.dispose();
  });

  it('resolves theme colours, clrMap, sysClr, bgRef and picture backgrounds', async () => {
    const { deck } = await shapeAt(2);
    const bar = deck.slides[0].shapes.find((s) => s.fill)!;
    expect(bar.fill).toBe('#00a651'); // theme accent1, not the built-in default
    expect(bar.borderColor).toBe('#333333'); // a:sysClr lastClr
    expect(bar.borderWidth).toBe(2); // a:ln w=19050 EMU
    // p:bgRef → schemeClr bg1 → clrMap bg1=lt1 → sysClr window
    expect(deck.slides[0].background).toBe('#ffffff');
    expect(deck.slides[0].backgroundImageUrl).toBeUndefined();
    deck.dispose();
  });

  it('resolves a full-bleed background picture inherited from the master', async () => {
    const deck = await renderPptx(await buildPowerPointDeck({ masterBackground: 'picture' }));
    expect(deck.slides[0].backgroundImageUrl).toBeTruthy();
    deck.dispose();
  });

  it('reads a:srcRect crops and preset picture geometry', async () => {
    const { deck } = await shapeAt(4);
    const pic = deck.slides[0].shapes.find((s) => s.type === 'image')!;
    expect(pic.imageUrl).toBeTruthy();
    expect(pic.geom).toBe('ellipse');
    expect(pic.crop).toEqual({ l: 0.25, t: 0.1, r: 0.1, b: 0.2 });
    expect(Math.round(pic.x)).toBe(96);
    expect(Math.round(pic.y)).toBe(144);
    expect(Math.round(pic.w)).toBe(384);
    expect(Math.round(pic.h)).toBe(288);
    deck.dispose();
  });

  it('keeps merged table cells aligned (gridSpan/rowSpan + continuation cells)', async () => {
    const { deck } = await shapeAt(5);
    const table = deck.slides[0].shapes.find((s) => s.type === 'table')!.table!;
    expect(table.colWidths.map(Math.round)).toEqual([192, 192, 192, 192]);
    expect(table.rowHeights.map(Math.round)).toEqual([48, 48, 48]);
    const [r0, r1, r2] = table.cells;
    expect(r0[2]).toMatchObject({ text: 'Class', gridSpan: 2, sizePt: 18, bold: true });
    expect(r0[3].merged).toBe('h');
    expect(r1[0]).toMatchObject({ text: 'Atenolol', rowSpan: 2, sizePt: 14 });
    expect(r2[0].merged).toBe('v');
    expect(r0[0].fill).toBe('#ddebf7');
    // Merged text still lands in the extracted text (search/study features).
    expect(deck.slides[0].text).toContain('Atenolol');
    expect(deck.slides[0].text).toContain('Cardioselective');
    deck.dispose();
  });

  it('exposes every part in the deck-wide extracted text', async () => {
    const deck = await renderPptx(await buildPowerPointDeck());
    expect(deck.fullText).toContain('--- Slide 1 ---');
    expect(deck.fullText).toContain('Cardiovascular Pharmacology');
    expect(deck.fullText).toContain('Blocks beta-1 receptors');
    expect(deck.fullText).toContain('50 mg');
    deck.dispose();
  });
});
