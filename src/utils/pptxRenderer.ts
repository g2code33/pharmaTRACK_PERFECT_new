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
  /** Outline level (0-based) from a:pPr/@lvl. */
  level: number;
  align?: PptxAlign;
  /** Multiplier, e.g. 1.5 for 150% line spacing. */
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  /** null = no bullet; string = literal glyph (auto-numbering is resolved). */
  bullet?: string | null;
}

/**
 * Text properties inherited through the PowerPoint style chain
 * (shape lstStyle → slide layout placeholder → master txStyles).
 */
export interface PptxLevelDefault {
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: PptxAlign;
  bullet?: string | null;
  /** Font family for the level (theme fonts already resolved). */
  font?: string;
  /** Left margin for the level, in px (marL). */
  indentPx?: number;
}

export interface PptxText {
  paragraphs: PptxParagraph[];
  /** Vertical anchor from bodyPr. */
  anchor?: 't' | 'ctr' | 'b';
  /** normAutofit fontScale (≤ 1) — PowerPoint shrinks text to fit. */
  fontScale: number;
  /** Font size assumed when a run carries no explicit sz. */
  defaultSizePt: number;
  /** Per-level inherited defaults (index 0 = level 1). */
  levels: PptxLevelDefault[];
}

export interface PptxTableCell {
  text: string;
  sizePt?: number;
  bold?: boolean;
  color?: string;
  fill?: string;
  /** a:tc gridSpan — columns this (anchor) cell covers. */
  gridSpan?: number;
  /** a:tc rowSpan — rows this (anchor) cell covers. */
  rowSpan?: number;
  /** a:tc hMerge/vMerge — covered cell, emitted by PowerPoint after a span. */
  merged?: 'h' | 'v';
  /** Optional cell borders (a:lnL/lnR/lnT/lnB), CSS colours. */
  borders?: { l?: string; r?: string; t?: string; b?: string };
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
  /** a:srcRect cropping of the source image, as 0..1 fractions of each edge. */
  crop?: { l: number; t: number; r: number; b: number };
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
  /** Full-bleed background picture (p:bg > p:bgPr > a:blipFill), if any. */
  backgroundImageUrl?: string;
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

/** Fallback palette (Office 2013+ theme) for files with no readable theme. */
const FALLBACK_SCHEME_COLORS: Record<string, string> = {
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

const FALLBACK_FONTS = { major: 'Calibri', minor: 'Calibri' };

/** Per-deck theme: the file's own colour scheme (as remapped by p:clrMap) + fonts. */
interface ThemeInfo {
  colors: Record<string, string>;
  major: string;
  minor: string;
}

/**
 * The theme of the slide being parsed. Files resolve scheme colours/fonts
 * through their theme, so the parser needs it while walking shapes; parsing
 * is synchronous once a slide's parts are loaded, so a single slot is safe.
 */
let activeTheme: ThemeInfo | null = null;

/** Reads the theme part a slide master points at: clrScheme + fontScheme. */
async function loadTheme(zip: JSZip, masterRels: Map<string, Rel>): Promise<ThemeInfo | null> {
  const themeRel = Array.from(masterRels.values()).find((r) => /theme\d*\.xml$/i.test(r.target));
  const candidates = [
    ...(themeRel ? [resolveZipPath('ppt/slideMasters', themeRel.target)] : []),
    ...Object.keys(zip.files).filter((n) => /^ppt\/theme\/theme\d+\.xml$/i.test(n)).sort(),
  ];
  for (const path of candidates) {
    const file = zip.file(path);
    if (!file) continue;
    const doc = new DOMParser().parseFromString(await file.async('text'), 'text/xml');
    const scheme = doc.getElementsByTagName('a:clrScheme')[0];
    const colors: Record<string, string> = {};
    if (scheme) {
      for (const el of Array.from(scheme.children)) {
        const name = el.tagName.replace(/^a:/, '');
        const srgb = child(el, 'a:srgbClr')?.getAttribute('val');
        const sys = child(el, 'a:sysClr');
        const sysLast = sys?.getAttribute('lastClr');
        const sysName = sys?.getAttribute('val');
        const hex =
          srgb ||
          sysLast ||
          (sysName === 'window' || sysName === 'windowText'
            ? sysName === 'window'
              ? 'FFFFFF'
              : '000000'
            : undefined);
        if (hex) colors[name] = `#${hex.toLowerCase()}`;
      }
    }
    const fontScheme = doc.getElementsByTagName('a:fontScheme')[0];
    const faceOf = (part: Element | null | undefined) =>
      part ? child(part, 'a:latin')?.getAttribute('typeface') || undefined : undefined;
    const major = fontScheme ? faceOf(child(fontScheme, 'a:majorFont')) : undefined;
    const minor = fontScheme ? faceOf(child(fontScheme, 'a:minorFont')) : undefined;
    if (!Object.keys(colors).length && !major && !minor) continue;
    return {
      colors,
      major: major || FALLBACK_FONTS.major,
      minor: minor || FALLBACK_FONTS.minor,
    };
  }
  return null;
}

/** Applies the master's p:clrMap (tx1→dk1, bg1→lt1, …) to the theme palette. */
function applyColorMap(theme: ThemeInfo, masterDoc: Document | null): void {
  const map = masterDoc ? masterDoc.getElementsByTagName('p:clrMap')[0] : null;
  if (!map) return;
  const merged: Record<string, string> = {};
  for (const attr of Array.from(map.attributes)) {
    const value = theme.colors[attr.value] ?? FALLBACK_SCHEME_COLORS[attr.value];
    if (value) merged[attr.name] = value;
  }
  theme.colors = { ...theme.colors, ...merged };
}

/** CSS colour for an a:schemeClr value, via the active file's theme. */
function schemeColor(key: string): string {
  return (
    activeTheme?.colors[key] ??
    FALLBACK_SCHEME_COLORS[key] ??
    activeTheme?.colors.tx1 ??
    '#000000'
  );
}

/** Resolves theme font references (+mj-lt / +mn-lt / +mn-ea …) to a real face. */
function resolveFont(face: string | undefined | null): string | undefined {
  if (!face) return undefined;
  if (face.startsWith('+mj-')) return activeTheme?.major ?? FALLBACK_FONTS.major;
  if (face.startsWith('+mn-')) return activeTheme?.minor ?? FALLBACK_FONTS.minor;
  return face;
}

function solidColor(fillEl: Element | null): string | undefined {
  if (!fillEl) return undefined;
  const srgb = child(fillEl, 'a:srgbClr')?.getAttribute('val');
  if (srgb) return `#${srgb.toLowerCase()}`;
  const sys = child(fillEl, 'a:sysClr');
  if (sys) {
    const last = sys.getAttribute('lastClr');
    if (last) return `#${last.toLowerCase()}`;
    if (sys.getAttribute('val') === 'window') return '#FFFFFF';
    return '#000000';
  }
  const scheme = child(fillEl, 'a:schemeClr');
  if (scheme) return schemeColor(scheme.getAttribute('val') || '');
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

/** a:buChar carries its glyph in char="•" (val= is not used by PowerPoint). */
function bulletChar(el: Element): string {
  return el.getAttribute('char') || el.getAttribute('val') || '•';
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
  const face = resolveFont(child(rPr, 'a:latin')?.getAttribute('typeface'));
  if (face) out.font = face;
}

const ALIGN_MAP: Record<string, PptxAlign> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  rt: 'right',
  just: 'justify',
};

/** Reads the inheritable properties of one a:lvlNpPr (or a:pPr) element. */
function parseLevelDefault(pPr: Element): PptxLevelDefault {
  const d: PptxLevelDefault = {};
  const algn = pPr.getAttribute('algn');
  if (algn && ALIGN_MAP[algn]) d.align = ALIGN_MAP[algn];
  const marL = pPr.getAttribute('marL');
  if (marL) {
    const px = emuToPx(Math.abs(parseInt(marL, 10)));
    if (px > 0) d.indentPx = px;
  }
  if (child(pPr, 'a:buNone')) d.bullet = null;
  else if (child(pPr, 'a:buChar')) d.bullet = bulletChar(child(pPr, 'a:buChar')!);
  else if (child(pPr, 'a:buAutoNum')) d.bullet = '•';

  const defRPr = child(pPr, 'a:defRPr');
  if (defRPr) {
    const sz = defRPr.getAttribute('sz');
    if (sz) {
      const pt = parseInt(sz, 10) / 100;
      if (pt > 0) d.sizePt = pt;
    }
    if (defRPr.getAttribute('b') === '1') d.bold = true;
    if (defRPr.getAttribute('i') === '1') d.italic = true;
    const color = solidColor(child(defRPr, 'a:solidFill'));
    if (color) d.color = color;
    const face = resolveFont(child(defRPr, 'a:latin')?.getAttribute('typeface'));
    if (face) d.font = face;
  }
  return d;
}

/**
 * Collects lvl1..lvl9 defaults from an a:lstStyle (placeholder/shape) or a
 * txStyles style element (master), which hold a:lvlNpPr as direct children.
 */
function parseLevels(container: Element | null): PptxLevelDefault[] {
  const out: PptxLevelDefault[] = [];
  if (!container) return out;
  for (let i = 1; i <= 9; i++) {
    const pPr = child(container, `a:lvl${i}pPr`);
    if (pPr) out[i - 1] = parseLevelDefault(pPr);
  }
  return out;
}

/** Earlier arrays win; later ones only fill gaps. */
function mergeLevels(...chains: (PptxLevelDefault[] | undefined)[]): PptxLevelDefault[] {
  const out: PptxLevelDefault[] = [];
  for (const chain of chains) {
    if (!chain) continue;
    for (let i = 0; i < chain.length; i++) {
      const src = chain[i];
      if (!src) continue;
      const dst = (out[i] ??= {});
      if (dst.sizePt === undefined && src.sizePt !== undefined) dst.sizePt = src.sizePt;
      if (dst.bold === undefined && src.bold !== undefined) dst.bold = src.bold;
      if (dst.italic === undefined && src.italic !== undefined) dst.italic = src.italic;
      if (dst.color === undefined && src.color !== undefined) dst.color = src.color;
      if (dst.align === undefined && src.align !== undefined) dst.align = src.align;
      if (dst.bullet === undefined && src.bullet !== undefined) dst.bullet = src.bullet;
      if (dst.indentPx === undefined && src.indentPx !== undefined) dst.indentPx = src.indentPx;
      if (dst.font === undefined && src.font !== undefined) dst.font = src.font;
    }
  }
  return out;
}

function parseParagraph(p: Element, counter: { n: number }): PptxParagraph {
  const para: PptxParagraph = { runs: [], level: 0 };
  const pPr = child(p, 'a:pPr');
  if (pPr) {
    const lvl = parseInt(pPr.getAttribute('lvl') || '0', 10);
    if (Number.isFinite(lvl) && lvl > 0) para.level = Math.min(lvl, 8);
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
    else if (child(pPr, 'a:buChar')) para.bullet = bulletChar(child(pPr, 'a:buChar')!);
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

function parseText(
  txBody: Element | null,
  defaultSizePt: number,
  inherited: PptxLevelDefault[] = [],
): PptxText | undefined {
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
  // The shape's own lstStyle is most specific, then the layout placeholder,
  // then the master's txStyles.
  const levels = mergeLevels(parseLevels(child(txBody, 'a:lstStyle')), inherited);
  return { paragraphs, anchor, fontScale, defaultSizePt, levels };
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

/** What a slide placeholder inherits from its layout counterpart. */
interface PlaceholderInfo {
  geom?: LayoutGeom;
  anchor?: 't' | 'ctr' | 'b';
  levels: PptxLevelDefault[];
}

interface LayoutInfo {
  /** Keyed by "type#idx" (OOXML placeholder matching), then by "type". */
  placeholders: Map<string, PlaceholderInfo>;
  /** Master <p:txStyles> levels, so real decks keep their 44pt titles etc. */
  masterStyles: { title: PptxLevelDefault[]; body: PptxLevelDefault[]; other: PptxLevelDefault[] };
  background?: string;
  /** Background picture inherited from the layout or the master. */
  backgroundImageUrl?: string;
  /** The master's theme (colours/fonts) — applied while parsing the slide. */
  theme?: ThemeInfo;
}

const TITLE_PH = new Set(['title', 'ctrTitle']);

/** Styles a placeholder type picks up from the master's txStyles. */
function masterLevelsFor(master: LayoutInfo['masterStyles'], phType: string): PptxLevelDefault[] {
  if (TITLE_PH.has(phType)) return master.title;
  if (phType === 'body' || phType === 'subTitle') return master.body;
  return master.other;
}

/** Resolves a background element: p:bgPr fills, or a p:bgRef theme colour. */
function backgroundCss(bg: Element | null): string | undefined {
  if (!bg) return undefined;
  const bgPr = child(bg, 'p:bgPr');
  if (bgPr) {
    const css = fillCss(bgPr);
    if (css) return css;
  }
  // bgRef points at a theme fill; the referenced colour is usually declared
  // inline (bg1/tx1/accentN), which is enough to match the slide's look.
  const bgRef = child(bg, 'p:bgRef');
  if (bgRef) {
    const direct = solidColor(bgRef);
    if (direct) return direct;
  }
  return undefined;
}

/**
 * Background pictures: p:bg > p:bgPr > a:blipFill with an embedded image.
 * Resolves the referenced media to an object URL and hands it to the caller's
 * revoke list.
 */
async function backgroundPicture(
  zip: JSZip,
  bg: Element | null | undefined,
  partDir: string,
  rels: Map<string, Rel>,
  onUrl: (url: string) => void,
): Promise<string | undefined> {
  const blip = bg ? child(child(bg, 'p:bgPr'), 'a:blipFill') : null;
  const rid = blip ? child(blip, 'a:blip')?.getAttribute('r:embed') : null;
  if (!rid) return undefined;
  const rel = rels.get(rid);
  if (!rel) return undefined;
  const media = zip.file(resolveZipPath(partDir, rel.target));
  if (!media) return undefined;
  try {
    const url = URL.createObjectURL(await media.async('blob'));
    onUrl(url);
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Placeholders inherit position, size, anchor and text styles from their slide
 * layout, and text styles again from the master's txStyles. Decks authored in
 * PowerPoint rely on this chain for nearly everything visible.
 */
async function loadLayoutInfo(
  zip: JSZip,
  slideRels: Map<string, Rel>,
  onUrl: (url: string) => void,
): Promise<LayoutInfo | null> {
  const layoutRel = Array.from(slideRels.values()).find((r) => r.type.endsWith('/slideLayout'));
  if (!layoutRel) return null;
  const layoutPath = resolveZipPath('ppt/slides', layoutRel.target);
  const layoutFile = zip.file(layoutPath);
  if (!layoutFile) return null;
  const layoutDoc = new DOMParser().parseFromString(await layoutFile.async('text'), 'text/xml');
  const layoutRels = await loadRelsFor(zip, layoutPath);
  let deckTheme: ThemeInfo | undefined;

  // --- master: txStyles + background ---
  let masterStyles: LayoutInfo['masterStyles'] = { title: [], body: [], other: [] };
  let masterBg: Element | null = null;
  let masterRels = new Map<string, Rel>();
  const masterRel = Array.from(layoutRels.values()).find((r) =>
    r.type.endsWith('/slideMaster'),
  );
  if (masterRel) {
    const masterPath = resolveZipPath('ppt/slideLayouts', masterRel.target);
    const masterFile = zip.file(masterPath);
    if (masterFile) {
      masterRels = await loadRelsFor(zip, masterPath);
      const masterDoc = new DOMParser().parseFromString(await masterFile.async('text'), 'text/xml');
      // Theme first: scheme colours and +mj-lt/+mn-lt font faces are resolved
      // while parsing shapes and backgrounds below.
      const theme = await loadTheme(zip, masterRels);
      if (theme) {
        applyColorMap(theme, masterDoc);
        // Used below for bgRef colours; renderPptx re-applies it right before
        // parsing this slide's shapes so concurrent parses cannot interleave.
        activeTheme = theme;
        deckTheme = theme;
      }
      const txStyles = masterDoc.getElementsByTagName('p:txStyles')[0];
      if (txStyles) {
        masterStyles = {
          title: parseLevels(child(txStyles, 'p:titleStyle')),
          body: parseLevels(child(txStyles, 'p:bodyStyle')),
          other: parseLevels(child(txStyles, 'p:otherStyle')),
        };
      }
      const mCsl = masterDoc.getElementsByTagName('p:cSld')[0];
      masterBg = mCsl ? child(mCsl, 'p:bg') : null;
    }
  }

  // --- layout placeholders ---
  const placeholders = new Map<string, PlaceholderInfo>();
  const spTree = layoutDoc.getElementsByTagName('p:spTree')[0] || layoutDoc.documentElement;
  for (const sp of Array.from(spTree.getElementsByTagName('p:sp'))) {
    const ph = sp.getElementsByTagName('p:ph')[0];
    if (!ph) continue;
    const type = ph.getAttribute('type') || 'body';
    const idx = ph.getAttribute('idx') || '0';
    const box = parseXfrm(child(sp, 'p:spPr'));
    const txBody = child(sp, 'p:txBody');
    const bodyPr = txBody ? child(txBody, 'a:bodyPr') : null;
    const anchor = bodyPr?.getAttribute('anchor') as PlaceholderInfo['anchor'] | undefined;
    const levels = mergeLevels(
      parseLevels(txBody ? child(txBody, 'a:lstStyle') : null),
      masterLevelsFor(masterStyles, type),
    );
    const info: PlaceholderInfo = { levels };
    if (box.w > 0 && box.h > 0) info.geom = { x: box.x, y: box.y, w: box.w, h: box.h };
    if (anchor) info.anchor = anchor;
    placeholders.set(`${type}#${idx}`, info);
    if (!placeholders.has(type)) placeholders.set(type, info);
  }

  const cSld = layoutDoc.getElementsByTagName('p:cSld')[0];
  const layoutBg = cSld ? child(cSld, 'p:bg') : null;
  const background = backgroundCss(layoutBg) ?? backgroundCss(masterBg);
  const backgroundImageUrl =
    (await backgroundPicture(zip, layoutBg, 'ppt/slideLayouts', layoutRels, onUrl)) ??
    (await backgroundPicture(zip, masterBg, 'ppt/slideMasters', masterRels, onUrl));
  return { placeholders, masterStyles, background, backgroundImageUrl, theme: deckTheme };
}

/** OOXML matches a slide placeholder to its layout counterpart by type+idx. */
function placeholderFor(
  layout: LayoutInfo | null,
  phType: string,
  phIdx: string,
): PlaceholderInfo | undefined {
  if (!layout) return undefined;
  return layout.placeholders.get(`${phType}#${phIdx}`) ?? (phType ? layout.placeholders.get(phType) : undefined);
}

/** Sensible defaults when no layout geometry exists (e.g. hand-built files). */
function defaultPhGeom(phType: string | undefined, sw: number, sh: number): LayoutGeom {
  if (phType === 'ctrTitle') return { x: sw * 0.1, y: sh * 0.32, w: sw * 0.8, h: sh * 0.22 };
  if (phType === 'title') return { x: sw * 0.06, y: sh * 0.07, w: sw * 0.88, h: sh * 0.22 };
  if (phType === 'subTitle') return { x: sw * 0.15, y: sh * 0.55, w: sw * 0.7, h: sh * 0.25 };
  if (phType === 'body') return { x: sw * 0.1, y: sh * 0.34, w: sw * 0.8, h: sh * 0.56 };
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
  const span = parseInt(tc.getAttribute('gridSpan') || '0', 10);
  if (span > 1) cell.gridSpan = span;
  const rowSpan = parseInt(tc.getAttribute('rowSpan') || '0', 10);
  if (rowSpan > 1) cell.rowSpan = rowSpan;
  if (tc.getAttribute('hMerge') === '1') cell.merged = 'h';
  else if (tc.getAttribute('vMerge') === '1') cell.merged = 'v';
  if (tcPr) {
    const borders: NonNullable<PptxTableCell['borders']> = {};
    const edge = (tag: string, key: 'l' | 'r' | 't' | 'b') => {
      const ln = child(tcPr, tag);
      if (!ln || child(ln, 'a:noFill')) return;
      const color = solidColor(child(ln, 'a:solidFill'));
      if (color) borders[key] = color;
    };
    edge('a:lnL', 'l');
    edge('a:lnR', 'r');
    edge('a:lnT', 't');
    edge('a:lnB', 'b');
    if (Object.keys(borders).length) cell.borders = borders;
  }
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

/** Placeholder types that act as the slide title (incl. the title-slide one). */
export const isTitlePlaceholder = (phType: string): boolean => phType === 'title' || phType === 'ctrTitle';

function defaultSizePtFor(phType: string, isTitle: boolean): number {
  if (phType === 'ctrTitle') return 44;
  if (isTitle) return 32;
  if (phType === 'subTitle') return 28;
  return 18;
}

function parseSp(sp: Element, ctx: ShapeCtx): PptxShape | null {
  const spPr = child(sp, 'p:spPr');
  const ph = sp.getElementsByTagName('p:ph')[0];
  const phType = ph?.getAttribute('type') || (ph ? 'body' : '');
  const phIdx = ph?.getAttribute('idx') || '0';
  const isTitle = isTitlePlaceholder(phType);
  const placeholder = ph ? placeholderFor(ctx.layout, phType, phIdx) : undefined;

  let box = parseXfrm(spPr);
  if (box.w <= 0 || box.h <= 0) {
    const inherited = placeholder?.geom ?? defaultPhGeom(phType || undefined, ctx.sw, ctx.sh);
    box = { ...inherited, rot: 0 };
  }
  const b = applyT(ctx.t, box);

  const prst = child(spPr, 'a:prstGeom')?.getAttribute('prst');
  const noFill = Boolean(spPr && child(spPr, 'a:noFill'));
  const fill = noFill ? undefined : fillCss(spPr);
  const ln = spPr ? child(spPr, 'a:ln') : null;
  const lineColor = ln ? solidColor(child(ln, 'a:solidFill')) : undefined;
  const lineW = ln?.getAttribute('w') ? emuToPx(parseInt(ln.getAttribute('w')!, 10)) : undefined;

  const inheritedLevels = placeholder?.levels ?? (ctx.layout ? masterLevelsFor(ctx.layout.masterStyles, phType) : []);
  const text = parseText(child(sp, 'p:txBody'), defaultSizePtFor(phType, isTitle), inheritedLevels);
  if (text && !text.anchor && placeholder?.anchor) text.anchor = placeholder.anchor;

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
  const spPr = child(pic, 'p:spPr');
  const box = applyT(ctx.t, parseXfrm(spPr));
  const blipFill = child(pic, 'p:blipFill');
  const blip = blipFill ? child(blipFill, 'a:blip') : null;
  const rid = blip?.getAttribute('r:embed');
  const url = rid ? ctx.imageUrls.get(rid) : undefined;
  if (url) ctx.imageList.push(url);
  const shape: PptxShape = {
    id: ctx.nextId(),
    type: 'image',
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 0),
    h: Math.max(box.h, 0),
    rot: box.rot,
    geom: child(spPr, 'a:prstGeom')?.getAttribute('prst') || 'rect',
    imageUrl: url,
    textScale: 1,
    isTitle: false,
  };
  // a:srcRect keeps a sub-rectangle of the source (values are 1/1000 %).
  const srcRect = blipFill ? child(blipFill, 'a:srcRect') : null;
  if (srcRect) {
    const frac = (name: string) => {
      const v = parseInt(srcRect.getAttribute(name) || '0', 10);
      return Number.isFinite(v) && v > 0 ? Math.min(v / 100000, 0.999) : 0;
    };
    const crop = { l: frac('l'), t: frac('t'), r: frac('r'), b: frac('b') };
    if (crop.l || crop.t || crop.r || crop.b) shape.crop = crop;
  }
  return shape;
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
  activeTheme = null; // never inherit another deck's theme
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

    const layout = await loadLayoutInfo(zip, rels, (u) => urlRevoke.push(u));
    const cSld = doc.getElementsByTagName('p:cSld')[0] || doc.documentElement;
    const spTree = cSld.getElementsByTagName('p:spTree')[0] || cSld;

    // Background: the slide's own, else the layout's, else the master's.
    const slideBg = child(cSld, 'p:bg');
    const background = backgroundCss(slideBg) ?? layout?.background;
    const slideBgImage = await backgroundPicture(
      zip,
      slideBg,
      'ppt/slides',
      rels,
      (u) => urlRevoke.push(u),
    );
    const backgroundImageUrl = slideBgImage ?? layout?.backgroundImageUrl;

    // Apply this slide's theme for the (synchronous) parse below.
    activeTheme = layout?.theme ?? activeTheme;

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
      if (isTitlePlaceholder(phType || (ph ? 'body' : ''))) {
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
      backgroundImageUrl,
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
