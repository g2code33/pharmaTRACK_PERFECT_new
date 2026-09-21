import JSZip from 'jszip';

/**
 * Native .pptx renderer — parses the OPC zip directly in the browser.
 *
 * PowerPoint is already an open XML format (DrawingML inside a zip), so no
 * conversion service is needed and the file never leaves the device. This
 * module produces a *visual* model of each slide: slide dimensions, shape
 * geometry (position/size/rotation), fills, per-run font sizing/weight/
 * colour, paragraph alignment, tables, placed images and backgrounds — which
 * is enough to rebuild the slide as positioned DOM and show it as the user
 * would see it in PowerPoint.
 *
 * The legacy flat-text fields (title/body/notes/images/text/fullText) are
 * kept unchanged for compatibility with existing consumers (FileUploader,
 * search indexing).
 *
 * Units: PowerPoint stores geometry in EMU (914400 per inch). We convert to
 * CSS pixels (96 per inch → divide by 9525). Font sizes arrive in 1/100 pt.
 */

const EMU_PER_PX = 9525;
const DEFAULT_SLIDE_CX = 12192000; // 16:9
const DEFAULT_SLIDE_CY = 6858000;

export const emuToPx = (emu: number): number => emu / EMU_PER_PX;
export const ptToPx = (pt: number): number => (pt * 4) / 3;

/* ------------------------------------------------------------------ */
/* Model                                                              */
/* ------------------------------------------------------------------ */

export interface PptxRun {
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  font?: string;
}

export type PptxAlign = 'left' | 'center' | 'right' | 'justify';

export interface PptxParagraph {
  runs: PptxRun[];
  align?: PptxAlign;
  /** Multiplier, e.g. 1.5 for 150% line spacing. */
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  /** null = no bullet; string = literal glyph (auto-numbering is resolved). */
  bullet?: string | null;
}

export interface PptxText {
  paragraphs: PptxParagraph[];
  /** Vertical anchor from bodyPr. */
  anchor?: 't' | 'ctr' | 'b';
  /** normAutofit fontScale (≤ 1) — PowerPoint shrinks text to fit. */
  fontScale: number;
  /** Font size assumed when a run carries no explicit sz. */
  defaultSizePt: number;
}

export interface PptxTableCell {
  text: string;
  sizePt?: number;
  bold?: boolean;
  color?: string;
  fill?: string;
}

export interface PptxTable {
  colWidths: number[]; // px
  rowHeights: number[]; // px
  cells: PptxTableCell[][];
}

export type PptxShapeType = 'text' | 'image' | 'table' | 'chart' | 'line';

export interface PptxShape {
  id: number;
  type: PptxShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number; // degrees
  /** prstGeom name (rect, roundRect, ellipse, …). */
  geom?: string;
  /** CSS colour or gradient. */
  fill?: string;
  borderColor?: string;
  borderWidth?: number; // px
  text?: PptxText;
  imageUrl?: string;
  table?: PptxTable;
  /** Font scale inherited from an enclosing group. */
  textScale: number;
  /** True for placeholders (used for default font sizing). */
  isTitle: boolean;
}

export interface PptxSlide {
  slideNumber: number;
  title: string;
  body: string[];
  /** Object URLs in document order (back-compat; also referenced by shapes). */
  images: string[];
  notes: string;
  text: string;
  /** CSS colour or gradient for the slide background. */
  background?: string;
  shapes: PptxShape[];
}

export interface PptxDocument {
  slides: PptxSlide[];
  /** CSS pixels. */
  slideWidth: number;
  slideHeight: number;
  fullText: string;
  fileSize: number; // bytes
  dates?: { created?: string; modified?: string };
  dispose: () => void;
}

/* ------------------------------------------------------------------ */
/* Small XML helpers (namespaced names arrive with their prefix)      */
/* ------------------------------------------------------------------ */

const child = (el: Element | null, tag: string): Element | null => {
  if (!el) return null;
  const t = tag.toLowerCase();
  for (const c of Array.from(el.children)) {
    if (c.tagName.toLowerCase() === t) return c;
  }
  return null;
};

const children = (el: Element, tag: string): Element[] => {
  const t = tag.toLowerCase();
  return Array.from(el.children).filter((c) => c.tagName.toLowerCase() === t);
};

const SCHEME_COLORS: Record<string, string> = {
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#44546A',
  lt2: '#E7E6E6',
  tx1: '#000000',
  bg1: '#FFFFFF',
  tx2: '#44546A',
  bg2: '#E7E6E6',
  accent1: '#4472C4',
  accent2: '#ED7D31',
  accent3: '#A5A5A5',
  accent4: '#FFC000',
  accent5: '#5B9BD5',
  accent6: '#70AD47',
  hlink: '#0563C1',
  folHlink: '#954F72',
};

function solidColor(fillEl: Element | null): string | undefined {
  if (!fillEl) return undefined;
  const srgb = child(fillEl, 'a:srgbClr');
  const s = srgb?.getAttribute('val');
  if (s) return `#${s.toLowerCase()}`;
  const scheme = child(fillEl, 'a:schemeClr');
  if (scheme) {
    const key = scheme.getAttribute('val') || '';
    return SCHEME_COLORS[key] ?? '#000000';
  }
  return undefined;
}

/** CSS background for an a:solidFill / a:gradFill element (or its parent holder). */
function fillCss(holder: Element | null): string | undefined {
  if (!holder) return undefined;
  const solid = child(holder, 'a:solidFill');
  const flat = solidColor(solid);
  if (flat) return flat;
  const grad = child(holder, 'a:gradFill');
  if (grad) {
    // Each stop carries its colour directly (a:gs > a:srgbClr|a:schemeClr).
    const stops = Array.from(grad.getElementsByTagName('a:gs'))
      .map((gs) => solidColor(gs))
      .filter((c): c is string => Boolean(c));
    if (stops.length >= 2) return `linear-gradient(135deg, ${stops[0]}, ${stops[stops.length - 1]})`;
    if (stops.length === 1) return stops[0];
  }
  return undefined;
}

function parseSpacingPt(pPr: Element, tag: string): number | undefined {
  const el = child(pPr, tag);
  if (!el) return undefined;
  const pts = child(el, 'a:spcPts');
  const v = pts?.getAttribute('val');
  if (v) return parseInt(v, 10) / 100;
  return undefined;
}

function autoNumGlyph(type: string, n: number): string {
  switch (type) {
    case 'arabicPeriod':
      return `${n}.`;
    case 'alphaPeriod':
    case 'lowerLetter':
      return `${String.fromCharCode(96 + Math.min(n, 26))}.`;
    case 'upperLetter':
      return `${String.fromCharCode(64 + Math.min(n, 26))}.`;
    default:
      return '•';
  }
}

function parseRunProps(rPr: Element | null, out: PptxRun): void {
  if (!rPr) return;
  const sz = rPr.getAttribute('sz');
  if (sz) {
    const pt = parseInt(sz, 10) / 100;
    if (pt > 0) out.sizePt = pt;
  }
  const b = rPr.getAttribute('b');
  if (b === '1') out.bold = true;
  else if (b === '0') out.bold = false;
  if (rPr.getAttribute('i') === '1') out.italic = true;
  const u = rPr.getAttribute('u');
  if (u && u !== 'none') out.underline = true;
  out.color = solidColor(child(rPr, 'a:solidFill'));
  const latin = child(rPr, 'a:latin');
  const face = latin?.getAttribute('typeface');
  if (face) out.font = face;
}

function parseParagraph(p: Element, counter: { n: number }): PptxParagraph {
  const para: PptxParagraph = { runs: [] };
  const pPr = child(p, 'a:pPr');
  if (pPr) {
    const algn = pPr.getAttribute('algn');
    if (algn === 'ctr') para.align = 'center';
    else if (algn === 'r' || algn === 'rtl') para.align = 'right';
    else if (algn === 'just') para.align = 'justify';
    else if (algn === 'l') para.align = 'left';

    const lnSpc = child(pPr, 'a:lnSpc');
    const pct = lnSpc ? child(lnSpc, 'a:spcPct') : null;
    const pctVal = pct?.getAttribute('val');
    if (pctVal) {
      const ls = parseInt(pctVal, 10) / 100000;
      if (ls > 0) para.lineSpacing = ls;
    }
    const before = parseSpacingPt(pPr, 'a:spcBef');
    if (before !== undefined) para.spaceBeforePt = before;
    const after = parseSpacingPt(pPr, 'a:spcAft');
    if (after !== undefined) para.spaceAfterPt = after;

    if (child(pPr, 'a:buNone')) para.bullet = null;
    else if (child(pPr, 'a:buChar')) para.bullet = child(pPr, 'a:buChar')!.getAttribute('val') || '•';
    else if (child(pPr, 'a:buAutoNum')) {
      counter.n += 1;
      para.bullet = autoNumGlyph(child(pPr, 'a:buAutoNum')!.getAttribute('type') || 'arabicPeriod', counter.n);
    }
  }

  for (const c of Array.from(p.children)) {
    const tag = c.tagName.toLowerCase();
    if (tag === 'a:r' || tag === 'a:fld') {
      const t = child(c, 'a:t')?.textContent ?? '';
      if (t) {
        const run: PptxRun = { text: t };
        parseRunProps(child(c, 'a:rPr'), run);
        para.runs.push(run);
      }
    } else if (tag === 'a:br') {
      para.runs.push({ text: '\n' });
    }
  }
  return para;
}

function parseText(txBody: Element | null, defaultSizePt: number): PptxText | undefined {
  if (!txBody) return undefined;
  const bodyPr = child(txBody, 'a:bodyPr');
  const anchor = bodyPr?.getAttribute('anchor') as PptxText['anchor'] | undefined;
  let fontScale = 1;
  const norm = bodyPr ? child(bodyPr, 'a:normAutofit') : null;
  const fs = norm?.getAttribute('fontScale');
  if (fs) {
    const v = parseInt(fs, 10);
    if (v > 0) fontScale = Math.min(1, v / 100000);
  }
  const counter = { n: 0 };
  const paragraphs = children(txBody, 'a:p').map((p) => parseParagraph(p, counter));
  if (!paragraphs.length) return undefined;
  return { paragraphs, anchor, fontScale, defaultSizePt };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

function parseXfrm(container: Element | null): Box {
  const xfrm = child(container, 'a:xfrm') ?? child(container, 'p:xfrm');
  const off = xfrm ? child(xfrm, 'a:off') : null;
  const ext = xfrm ? child(xfrm, 'a:ext') : null;
  const num = (el: Element | null, attr: string) => {
    const v = el?.getAttribute(attr);
    return v ? emuToPx(parseInt(v, 10)) : 0;
  };
  const rotRaw = xfrm?.getAttribute('rot');
  return {
    x: num(off, 'x'),
    y: num(off, 'y'),
    w: num(ext, 'cx'),
    h: num(ext, 'cy'),
    rot: rotRaw ? Math.round((parseInt(rotRaw, 10) / 60000) * 10) / 10 : 0,
  };
}

/** 2-D affine transform accumulating group nesting. */
interface T {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}

const IDENTITY: T = { sx: 1, sy: 1, dx: 0, dy: 0 };

function applyT(t: T, b: Box): Box {
  return {
    x: t.dx + b.x * t.sx,
    y: t.dy + b.y * t.sy,
    w: b.w * t.sx,
    h: b.h * t.sy,
    rot: b.rot,
  };
}

/**
 * Compose the group's child→parent mapping into the running transform.
 * A child at child-space coordinate l lands at
 *   parent = gOff + (l − chOff) × (gExt / chExt),
 * and the running transform t then maps parent → final: t.dx + p·t.sx.
 */
function composeGroup(t: T, gOff: Box, gExt: Box, chOff: Box, chExt: Box): T {
  const gsx = chExt.w > 0 ? gExt.w / chExt.w : 1;
  const gsy = chExt.h > 0 ? gExt.h / chExt.h : 1;
  return {
    sx: t.sx * gsx,
    sy: t.sy * gsy,
    dx: t.dx + t.sx * (gOff.x - chOff.x * gsx),
    dy: t.dy + t.sy * (gOff.y - chOff.y * gsy),
  };
}

function resolveZipPath(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\//, '');
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ */
/* Package-level helpers                                              */
/* ------------------------------------------------------------------ */

interface Rel {
  type: string;
  target: string;
}

async function loadRelsFor(zip: JSZip, partPath: string): Promise<Map<string, Rel>> {
  const idx = partPath.lastIndexOf('/');
  const dir = partPath.slice(0, idx);
  const name = partPath.slice(idx + 1);
  const relsFile = zip.file(`${dir}/_rels/${name}.rels`);
  const out = new Map<string, Rel>();
  if (!relsFile) return out;
  const xml = await relsFile.async('text');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    if (id) {
      out.set(id, {
        type: rel.getAttribute('Type') || '',
        target: rel.getAttribute('Target') || '',
      });
    }
  }
  return out;
}

async function parsePresentationSize(zip: JSZip): Promise<{ w: number; h: number }> {
  const file = zip.file('ppt/presentation.xml');
  if (file) {
    const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
    const sldSz = doc.getElementsByTagName('p:sldSz')[0];
    const cx = parseInt(sldSz?.getAttribute('cx') || '', 10);
    const cy = parseInt(sldSz?.getAttribute('cy') || '', 10);
    if (cx > 0 && cy > 0) return { w: emuToPx(cx), h: emuToPx(cy) };
  }
  return { w: emuToPx(DEFAULT_SLIDE_CX), h: emuToPx(DEFAULT_SLIDE_CY) };
}

async function parseDates(zip: JSZip): Promise<{ created?: string; modified?: string } | undefined> {
  const file = zip.file('docProps/core.xml');
  if (!file) return undefined;
  const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
  const created = doc.getElementsByTagName('dcterms:created')[0]?.textContent?.trim() || undefined;
  const modified = doc.getElementsByTagName('dcterms:modified')[0]?.textContent?.trim() || undefined;
  return created || modified ? { created, modified } : undefined;
}

/**
 * Slide order follows p:sldIdLst in presentation.xml (decks can reorder
 * slides without renaming files); falls back to numeric filename order.
 */
async function orderedSlidePaths(zip: JSZip): Promise<string[]> {
  const file = zip.file('ppt/presentation.xml');
  if (file) {
    const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
    const sldIdLst = child(doc.documentElement, 'p:sldIdLst');
    if (sldIdLst) {
      const presRels = await loadRelsFor(zip, 'ppt/presentation.xml');
      const ordered: string[] = [];
      for (const sldId of children(sldIdLst, 'p:sldId')) {
        const rid = sldId.getAttribute('r:id');
        const rel = rid ? presRels.get(rid) : undefined;
        if (rel) {
          const path = resolveZipPath('ppt', rel.target);
          if (zip.file(path)) ordered.push(path);
        }
      }
      if (ordered.length) return ordered;
    }
  }
  const all = Object.keys(zip.files).filter((n) => n.startsWith('ppt/slides/slide') && n.endsWith('.xml'));
  all.sort((a, b) => {
    const an = parseInt(a.match(/(\d+)\.xml$/)?.[1] || '0', 10);
    const bn = parseInt(b.match(/(\d+)\.xml$/)?.[1] || '0', 10);
    return an - bn;
  });
  return all;
}

/* ------------------------------------------------------------------ */
/* Slide-level parsing                                                */
/* ------------------------------------------------------------------ */

interface LayoutGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutInfo {
  /** Placeholder geometry keyed by "type#id" then by "type". */
  phGeom: Map<string, LayoutGeom>;
  backgroundEl: Element | null;
}

/**
 * Placeholders inherit position/size (and often background) from their slide
 * layout; if the slide doesn't define them, look them up in the layout and,
 * for the background, fall through to the master.
 */
async function loadLayoutInfo(zip: JSZip, slideRels: Map<string, Rel>): Promise<LayoutInfo | null> {
  const layoutRel = Array.from(slideRels.values()).find((r) => r.type.endsWith('/slideLayout'));
  if (!layoutRel) return null;
  const layoutPath = resolveZipPath('ppt/slides', layoutRel.target);
  const layoutFile = zip.file(layoutPath);
  if (!layoutFile) return null;
  const layoutDoc = new DOMParser().parseFromString(await layoutFile.async('text'), 'text/xml');
  const spTree = layoutDoc.getElementsByTagName('p:spTree')[0] || layoutDoc.documentElement;
  const phGeom = new Map<string, LayoutGeom>();
  for (const sp of Array.from(spTree.getElementsByTagName('p:sp'))) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph) continue;
    const type = ph.getAttribute('type') || '';
    const id = ph.getAttribute('id') || '';
    const box = parseXfrm(sp);
    if (box.w <= 0 || box.h <= 0) continue;
    const geom = { x: box.x, y: box.y, w: box.w, h: box.h };
    if (id) phGeom.set(`${type}#${id}`, geom);
    if (type && !phGeom.has(type)) phGeom.set(type, geom);
  }
  // Background: the layout's own, else the master's.
  let backgroundEl: Element | null = null;
  const cSld = layoutDoc.getElementsByTagName('p:cSld')[0];
  const bg = cSld ? child(cSld, 'p:bg') : null;
  if (bg) backgroundEl = bg;
  else {
    const masterRel = Array.from((await loadRelsFor(zip, layoutPath)).values()).find((r) =>
      r.type.endsWith('/slideMaster'),
    );
    if (masterRel) {
      const masterPath = resolveZipPath('ppt/slideLayouts', masterRel.target);
      const masterFile = zip.file(masterPath);
      if (masterFile) {
        const masterDoc = new DOMParser().parseFromString(await masterFile.async('text'), 'text/xml');
        const mCsl = masterDoc.getElementsByTagName('p:cSld')[0];
        const mBg = mCsl ? child(mCsl, 'p:bg') : null;
        if (mBg) backgroundEl = mBg;
      }
    }
  }
  return { phGeom, backgroundEl };
}

function phGeomFor(layout: LayoutInfo | null, phType: string, phId: string): LayoutGeom | undefined {
  if (!layout) return undefined;
  return layout.phGeom.get(`${phType}#${phId}`) ?? (phType ? layout.phGeom.get(phType) : undefined);
}

/** Sensible defaults when no layout geometry exists (e.g. hand-built files). */
function defaultPhGeom(phType: string | undefined, sw: number, sh: number): LayoutGeom {
  if (phType === 'title' || phType === 'ctr') return { x: sw * 0.06, y: sh * 0.07, w: sw * 0.88, h: sh * 0.22 };
  if (phType === 'body' || phType === 'subTitle') return { x: sw * 0.1, y: sh * 0.34, w: sw * 0.8, h: sh * 0.56 };
  if (phType === 'pic' || phType === 'media' || phType === 'chart' || phType === 'tbl' || phType === 'dt')
    return { x: sw * 0.1, y: sh * 0.3, w: sw * 0.8, h: sh * 0.6 };
  return { x: sw * 0.08, y: sh * 0.12, w: sw * 0.84, h: sh * 0.5 };
}

function parseTableCell(tc: Element): PptxTableCell {
  const cell: PptxTableCell = { text: '' };
  const txBody = child(tc, 'a:txBody');
  const paras = txBody ? children(txBody, 'a:p') : [];
  const lines: string[] = [];
  for (const p of paras) {
    const para = parseParagraph(p, { n: 0 });
    const line = para.runs.map((r) => r.text).join('');
    if (line.trim()) lines.push(line);
  }
  cell.text = lines.join('\n');
  const firstRun = paras.length ? parseParagraph(paras[0], { n: 0 }).runs.find((r) => r.text.trim()) : undefined;
  if (firstRun) {
    cell.sizePt = firstRun.sizePt;
    cell.bold = firstRun.bold;
    cell.color = firstRun.color;
  }
  const tcPr = child(tc, 'a:tcPr');
  cell.fill = solidColor(tcPr ? child(tcPr, 'a:solidFill') : null);
  return cell;
}

function parseTable(gf: Element, t: T): PptxShape {
  const box = applyT(t, parseXfrm(gf));
  const graphicData = gf.getElementsByTagName('a:graphicData')[0];
  const tbl = graphicData ? child(graphicData, 'a:tbl') : null;
  const shape: PptxShape = { id: 0, type: 'table', x: box.x, y: box.y, w: box.w, h: box.h, rot: box.rot, textScale: 1, isTitle: false };
  if (!tbl) return shape;
  const colWidths = Array.from(child(tbl, 'a:tblGrid')?.children || [])
    .filter((c) => c.tagName.toLowerCase() === 'a:gridcol')
    .map((c) => emuToPx(parseInt(c.getAttribute('w') || '0', 10)));
  const rows = children(tbl, 'a:tr');
  const rowHeights = rows.map((tr) => emuToPx(parseInt(tr.getAttribute('h') || '0', 10)));
  const cells = rows.map((tr) => children(tr, 'a:tc').map(parseTableCell));
  shape.table = { colWidths, rowHeights, cells };
  return shape;
}

interface ShapeCtx {
  t: T;
  imageUrls: Map<string, string>;
  layout: LayoutInfo | null;
  sw: number;
  sh: number;
  nextId: () => number;
  tableTexts: string[];
  imageList: string[];
  push: (s: PptxShape) => void;
}

function parseSp(sp: Element, ctx: ShapeCtx): PptxShape | null {
  const spPr = child(sp, 'p:spPr');
  const ph = sp.getElementsByTagName('p:ph')[0];
  const phType = ph?.getAttribute('type') || '';
  const phId = ph?.getAttribute('id') || '';
  const isTitle = phType === 'title' || phType === 'ctr';

  let box = parseXfrm(spPr);
  if (box.w <= 0 || box.h <= 0) {
    const inherited = phGeomFor(ctx.layout, phType, phId) ?? defaultPhGeom(phType || undefined, ctx.sw, ctx.sh);
    box = { ...inherited, rot: 0 };
  }
  const b = applyT(ctx.t, box);

  const prst = child(spPr, 'a:prstGeom')?.getAttribute('prst');
  const noFill = Boolean(spPr && child(spPr, 'a:noFill'));
  const fill = noFill ? undefined : fillCss(spPr);
  const ln = spPr ? child(spPr, 'a:ln') : null;
  const lineColor = ln ? solidColor(child(ln, 'a:solidFill')) : undefined;
  const lineW = ln?.getAttribute('w') ? emuToPx(parseInt(ln.getAttribute('w')!, 10)) : undefined;

  const defaultSizePt = isTitle ? 32 : 18;
  const text = parseText(child(sp, 'p:txBody'), defaultSizePt);

  const shape: PptxShape = {
    id: ctx.nextId(),
    type: 'text',
    x: b.x,
    y: b.y,
    w: Math.max(b.w, 0),
    h: Math.max(b.h, 0),
    rot: b.rot,
    geom: prst || (text ? 'rect' : undefined),
    fill,
    textScale: (ctx.t.sx + ctx.t.sy) / 2,
    isTitle,
  };
  if (lineColor && lineW && lineW > 0) {
    shape.borderColor = lineColor;
    shape.borderWidth = Math.max(1, lineW);
  }
  if (text) shape.text = text;
  if (!shape.text && !shape.fill) return null; // empty, invisible placeholder
  return shape;
}

function parsePic(pic: Element, ctx: ShapeCtx): PptxShape {
  const box = applyT(ctx.t, parseXfrm(child(pic, 'p:spPr')));
  const blipFill = child(pic, 'p:blipFill');
  const blip = blipFill ? child(blipFill, 'a:blip') : null;
  const rid = blip?.getAttribute('r:embed');
  const url = rid ? ctx.imageUrls.get(rid) : undefined;
  if (url) ctx.imageList.push(url);
  return {
    id: ctx.nextId(),
    type: 'image',
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 0),
    h: Math.max(box.h, 0),
    rot: box.rot,
    geom: 'rect',
    imageUrl: url,
    textScale: 1,
    isTitle: false,
  };
}

function parseCxnSp(cxn: Element, ctx: ShapeCtx): PptxShape {
  const box = applyT(ctx.t, parseXfrm(child(cxn, 'p:spPr')));
  const spPr = child(cxn, 'p:spPr');
  const ln = spPr ? child(spPr, 'a:ln') : null;
  const color = ln ? solidColor(child(ln, 'a:solidFill')) : undefined;
  const w = ln?.getAttribute('w') ? emuToPx(parseInt(ln.getAttribute('w')!, 10)) : 2;
  return {
    id: ctx.nextId(),
    type: 'line',
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 1),
    h: Math.max(box.h, Math.max(1, w)),
    rot: box.rot,
    fill: color,
    textScale: 1,
    isTitle: false,
  };
}

function parseGraphicFrame(gf: Element, ctx: ShapeCtx): PptxShape | null {
  const graphicData = gf.getElementsByTagName('a:graphicData')[0];
  const uri = graphicData?.getAttribute('uri') || '';
  if (uri.includes('/table') || (graphicData && child(graphicData, 'a:tbl'))) {
    const shape = parseTable(gf, ctx.t);
    shape.id = ctx.nextId();
    if (shape.table) {
      const rows = shape.table.cells.map((row) => row.map((c) => c.text.replace(/\n/g, ' ')).filter(Boolean));
      ctx.tableTexts.push(...rows.flatMap((row) => row));
    }
    return shape;
  }
  if (uri.includes('/chart')) {
    const box = applyT(ctx.t, parseXfrm(gf));
    return {
      id: ctx.nextId(),
      type: 'chart',
      x: box.x,
      y: box.y,
      w: Math.max(box.w, 0),
      h: Math.max(box.h, 0),
      rot: box.rot,
      textScale: 1,
      isTitle: false,
    };
  }
  return null; // SmartArt & other graphic frames: skipped (kept out of text too)
}

function parseGroup(grp: Element, ctx: ShapeCtx): void {
  const xfrm = child(child(grp, 'p:grpSpPr'), 'a:xfrm');
  if (!xfrm) return;
  const num = (el: Element | null, attr: string) => {
    const v = el?.getAttribute(attr);
    return v ? emuToPx(parseInt(v, 10)) : 0;
  };
  const off = child(xfrm, 'a:off');
  const ext = child(xfrm, 'a:ext');
  const chOff = child(xfrm, 'a:chOff');
  const chExt = child(xfrm, 'a:chExt');
  const t = composeGroup(
    ctx.t,
    { x: num(off, 'x'), y: num(off, 'y'), w: 0, h: 0, rot: 0 },
    { x: 0, y: 0, w: num(ext, 'cx'), h: num(ext, 'cy'), rot: 0 },
    { x: num(chOff, 'x'), y: num(chOff, 'y'), w: 0, h: 0, rot: 0 },
    { x: 0, y: 0, w: num(chExt, 'cx'), h: num(chExt, 'cy'), rot: 0 },
  );
  const groupCtx: ShapeCtx = { ...ctx, t };
  for (const c of Array.from(grp.children)) {
    const tag = c.tagName.toLowerCase();
    if (tag === 'p:sp') {
      const s = parseSp(c, groupCtx);
      if (s) groupCtx.push(s);
    } else if (tag === 'p:pic') {
      groupCtx.push(parsePic(c, groupCtx));
    } else if (tag === 'p:cxnsp') {
      groupCtx.push(parseCxnSp(c, groupCtx));
    } else if (tag === 'p:graphicframe') {
      const s = parseGraphicFrame(c, groupCtx);
      if (s) groupCtx.push(s);
    } else if (tag === 'p:grpsp') {
      parseGroup(c, groupCtx);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

export async function renderPptx(blob: Blob): Promise<PptxDocument> {
  const zip = await JSZip.loadAsync(blob);
  const slideFiles = await orderedSlidePaths(zip);
  const { w: slideWidth, h: slideHeight } = await parsePresentationSize(zip);
  const dates = await parseDates(zip);

  const slides: PptxSlide[] = [];
  const urlRevoke: string[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slidePath = slideFiles[i];
    const content = await zip.file(slidePath)?.async('text');
    if (!content) continue;
    const doc = new DOMParser().parseFromString(content, 'text/xml');
    const rels = await loadRelsFor(zip, slidePath);

    // Embedded images: resolve once per slide (object URLs stay alive until dispose).
    const imageUrls = new Map<string, string>();
    for (const [rid, rel] of rels) {
      if (!rel.type.endsWith('/image')) continue;
      const path = resolveZipPath('ppt/slides', rel.target);
      const media = zip.file(path);
      if (!media) continue;
      try {
        const url = URL.createObjectURL(await media.async('blob'));
        imageUrls.set(rid, url);
        urlRevoke.push(url);
      } catch {
        /* unreadable media — skip */
      }
    }

    const layout = await loadLayoutInfo(zip, rels);
    const cSld = doc.getElementsByTagName('p:cSld')[0] || doc.documentElement;
    const spTree = cSld.getElementsByTagName('p:spTree')[0] || cSld;

    // Background: slide itself → layout → master.
    let background: string | undefined;
    const bgEl = child(cSld, 'p:bg');
    const bgPr = bgEl ? child(bgEl, 'p:bgPr') : null;
    if (bgPr) background = fillCss(bgPr);
    if (!background && layout?.backgroundEl) {
      const lBgPr = child(layout.backgroundEl, 'p:bgPr');
      background = fillCss(lBgPr);
    }

    let nextId = 0;
    const shapes: PptxShape[] = [];
    const tableTexts: string[] = [];
    const imageList: string[] = [];
    const ctx: ShapeCtx = {
      t: IDENTITY,
      imageUrls,
      layout,
      sw: slideWidth,
      sh: slideHeight,
      nextId: () => ++nextId,
      tableTexts,
      imageList,
      push: (s: PptxShape) => shapes.push(s),
    };

    for (const c of Array.from(spTree.children)) {
      const tag = c.tagName.toLowerCase();
      if (tag === 'p:sp') {
        const s = parseSp(c, ctx);
        if (s) ctx.push(s);
      } else if (tag === 'p:pic') {
        ctx.push(parsePic(c, ctx));
      } else if (tag === 'p:cxnsp') {
        ctx.push(parseCxnSp(c, ctx));
      } else if (tag === 'p:graphicframe') {
        const s = parseGraphicFrame(c, ctx);
        if (s) ctx.push(s);
      } else if (tag === 'p:grpsp') {
        parseGroup(c, ctx);
      }
    }

    /* --- Legacy flat-text fields (unchanged semantics) --- */
    let title = '';
    const body: string[] = [];
    for (const c of Array.from(spTree.getElementsByTagName('p:sp'))) {
      const ph = c.getElementsByTagName('p:ph')[0];
      const phType = ph?.getAttribute('type') || '';
      const txBody = c.getElementsByTagName('p:txBody')[0];
      if (!txBody) continue;
      // Join the runs of each paragraph with no separator (PowerPoint splits
      // a single word across runs — naive per-run joining corrupts search text).
      const paraTexts = Array.from(txBody.getElementsByTagName('a:p'))
        .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join(''))
        .filter((t) => t.trim());
      if (phType === 'title' || phType === 'ctr') {
        if (!title) title = paraTexts.join(' ');
      } else {
        body.push(...paraTexts);
      }
    }

    // Speaker notes via the slide's own relationship (robust to reordering);
    // fall back to the conventional notesSlide{n} naming for minimal files.
    let notes = '';
    const notesRel = Array.from(rels.values()).find((r) => r.type.endsWith('/notesSlide'));
    const notesPath = notesRel
      ? resolveZipPath('ppt/slides', notesRel.target)
      : `ppt/notesSlides/notesSlide${i + 1}.xml`;
    const notesFile = zip.file(notesPath);
    if (notesFile) {
      const notesDoc = new DOMParser().parseFromString(await notesFile.async('text'), 'text/xml');
      const noteParas = Array.from(notesDoc.getElementsByTagName('a:p')).map((p) =>
        Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent || '').join(''),
      );
      const lines = noteParas.map((t) => t.trim()).filter(Boolean);
      // PowerPoint repeats the slide number on the last note line.
      const last = lines[lines.length - 1];
      if (last && /^\d{1,3}$/.test(last) && parseInt(last, 10) === i + 1) lines.pop();
      notes = lines.join('\n');
    }

    // Combined text: title + body (document order) + table cells, then notes —
    // the same searchable content the old renderer produced, plus tables.
    const parts: string[] = [];
    if (title) parts.push(title);
    body.forEach((p) => parts.push(p));
    tableTexts.forEach((p) => parts.push(p));
    if (notes) parts.push(`Notes: ${notes}`);

    slides.push({
      slideNumber: i + 1,
      title,
      body,
      images: imageList.slice(),
      notes,
      text: parts.join('\n'),
      background,
      shapes,
    });
  }

  const fullText = slides.length
    ? slides.map((s) => `--- Slide ${s.slideNumber} ---\n${s.text}`).join('\n\n')
    : '';

  const dispose = () => {
    urlRevoke.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* already revoked */
      }
    });
  };

  return { slides, slideWidth, slideHeight, fullText, fileSize: blob.size, dates, dispose };
}
