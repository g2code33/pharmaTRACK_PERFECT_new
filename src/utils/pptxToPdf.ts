import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import regularFontUrl from '../assets/fonts/DejaVuSans.ttf?url';
import boldFontUrl from '../assets/fonts/DejaVuSans-Bold.ttf?url';
import { renderPptx, ptToPx, type PptxDocument, type PptxLevelDefault, type PptxParagraph, type PptxShape, type PptxSlide } from './pptxRenderer';

export interface PptxPdfConversionResult {
  pdfBytes: Uint8Array;
  text: string;
  pageTexts: { page: number; text: string }[];
  pageCount: number;
}

interface ConversionFonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  unicode: boolean;
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function readAssetBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load font asset: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFonts(pdf: PDFDocument): Promise<ConversionFonts> {
  try {
    pdf.registerFontkit(fontkit);
    const [regularBytes, boldBytes] = await Promise.all([
      readAssetBytes(regularFontUrl),
      readAssetBytes(boldFontUrl),
    ]);
    const regular = await pdf.embedFont(regularBytes, { subset: true });
    const bold = await pdf.embedFont(boldBytes, { subset: true });
    return {
      regular,
      bold,
      // The bundled DejaVu regular/bold fonts cover Greek letters, arrows,
      // superscripts, bullets, and most lecturer symbols. Use them for italic
      // runs too so Unicode survives even when an italic face is unavailable.
      italic: regular,
      boldItalic: bold,
      unicode: true,
    };
  } catch (err) {
    console.warn('Unicode PDF fonts could not be loaded; falling back to standard PDF fonts.', err);
    return {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
      unicode: false,
    };
  }
}

function firstHex(value?: string): string | undefined {
  if (!value) return undefined;
  return value.match(/#[0-9a-f]{6}/i)?.[0];
}

function toRgb(value?: string, fallback = rgb(1, 1, 1)) {
  const hex = firstHex(value);
  if (!hex) return fallback;
  const int = Number.parseInt(hex.slice(1), 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

function toPdfY(pageHeight: number, y: number, h = 0): number {
  return pageHeight - y - h;
}

function replaceControlCharacters(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 32 || code === 127 ? ' ' : value[i];
  }
  return out;
}

function safeText(value: string, unicode: boolean): string {
  const cleaned = replaceControlCharacters(value);
  if (unicode) return cleaned;
  // pdf-lib StandardFonts encode WinAnsi. Replace unsupported characters rather
  // than letting one fancy glyph abort the whole upload. The extracted/search
  // text still keeps the original Unicode.
  return cleaned
    .replace(/[•·]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\u0020-\u00ff]/g, '?');
}

function fontFor(run: { bold?: boolean; italic?: boolean }, fonts: ConversionFonts): PDFFont {
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

type DrawTextOptions = NonNullable<Parameters<PDFPage['drawText']>[1]>;

function drawTextSafe(page: PDFPage, text: string, options: DrawTextOptions, unicode: boolean): void {
  try {
    page.drawText(text, options);
  } catch (err) {
    if (!unicode) throw err;
    page.drawText(safeText(text, false), options);
  }
}

function wrapText(text: string, maxWidth: number, font: PDFFont, size: number, unicode: boolean): string[] {
  const cleaned = safeText(text, unicode).replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function embedImage(pdf: PDFDocument, url: string) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isPng) return pdf.embedPng(bytes);
  if (isJpeg) return pdf.embedJpg(bytes);
  return null;
}


const PPTX_PDF_FONT_STACK = 'Calibri, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MAX_RASTER_PIXELS = 4_000_000;

function hasBrowserRasterSupport(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  if (typeof Image === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return false;
  const canvas = document.createElement('canvas');
  if (typeof canvas.toDataURL !== 'function') return false;
  try {
    return Boolean(canvas.getContext?.('2d'));
  } catch {
    return false;
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function px(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

function styleAttr(styles: Array<[string, string | number | undefined | null | false]>): string {
  const style = styles
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && entry[1] !== false && entry[1] !== '')
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return style ? ` style="${xmlEscape(style)}"` : '';
}

function borderRadiusFor(shape: PptxShape): string | undefined {
  if (shape.geom === 'ellipse') return '50%';
  if (shape.geom === 'roundRect') return '10px';
  return undefined;
}

function mediaUrl(url: string | undefined, media: Map<string, string>): string | undefined {
  if (!url) return undefined;
  return media.get(url) || url;
}

function collectSlideMedia(slide: PptxSlide): string[] {
  const urls = new Set<string>();
  if (slide.backgroundImageUrl) urls.add(slide.backgroundImageUrl);
  slide.shapes.forEach((shape) => {
    if (shape.imageUrl) urls.add(shape.imageUrl);
  });
  return Array.from(urls);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image data'));
    reader.readAsDataURL(blob);
  });
}

async function slideMediaAsDataUrls(slide: PptxSlide): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(collectSlideMedia(slide).map(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      out.set(url, await blobToDataUrl(await res.blob()));
    } catch {
      // Leave the original object URL in place. The rasteriser may still be
      // able to use same-origin blob URLs, and if not this slide falls back to
      // the vector converter instead of blocking the upload.
    }
  }));
  return out;
}

function paragraphHtml(
  p: PptxParagraph,
  shape: PptxShape,
  level: PptxLevelDefault | undefined,
): string {
  const text = shape.text;
  const fontScale = (text?.fontScale || 1) * shape.textScale;
  const defaultSizePt = text?.defaultSizePt || 18;
  const runSize = p.runs.find((r) => r.sizePt)?.sizePt;
  const baseSizePt = (runSize ?? level?.sizePt ?? defaultSizePt) * fontScale;
  const bullet = p.bullet === undefined ? (level?.bullet ?? null) : p.bullet;
  const baseStyle = styleAttr([
    ['text-align', p.align ?? level?.align ?? 'left'],
    ['font-size', px(ptToPx(baseSizePt))],
    ['line-height', p.lineSpacing ?? 1.15],
    ['margin-top', p.spaceBeforePt ? px(ptToPx(p.spaceBeforePt)) : '0'],
    ['margin-bottom', p.spaceAfterPt ? px(ptToPx(p.spaceAfterPt)) : '0'],
    ['margin-left', level?.indentPx ? px(level.indentPx) : undefined],
    ['display', bullet ? 'flex' : undefined],
    ['align-items', bullet ? 'flex-start' : undefined],
  ]);
  if (!p.runs.length) return `<div aria-hidden="true"${baseStyle}></div>`;
  const runs = p.runs.map((r) => {
    const bold = r.bold ?? level?.bold;
    const italic = r.italic ?? level?.italic;
    return `<span${styleAttr([
      ['font-size', r.sizePt ? px(ptToPx(r.sizePt * fontScale)) : undefined],
      ['font-weight', bold ? 700 : undefined],
      ['font-style', italic ? 'italic' : undefined],
      ['text-decoration', r.underline ? 'underline' : undefined],
      ['color', r.color ?? level?.color],
      ['font-family', r.font ?? level?.font],
    ])}>${xmlEscape(r.text)}</span>`;
  }).join('');
  const bulletHtml = bullet
    ? `<span aria-hidden="true"${styleAttr([
        ['flex-shrink', 0],
        ['width', '1.4em'],
        ['text-align', 'left'],
        ['white-space', 'pre'],
      ])}>${xmlEscape(`${bullet}\u00A0`)}</span>`
    : '';
  return `<div${baseStyle}>${bulletHtml}<span${styleAttr([
    ['min-width', 0],
    ['white-space', 'pre-wrap'],
    ['overflow-wrap', 'break-word'],
  ])}>${runs}</span></div>`;
}

function tableHtml(shape: PptxShape): string {
  const table = shape.table;
  if (!table || !table.cells.length) return '';
  const cols = table.colWidths.length
    ? `<colgroup>${table.colWidths.map((w) => `<col${styleAttr([
        ['width', shape.w > 0 ? `${((w / shape.w) * 100).toFixed(2)}%` : undefined],
      ])}>`).join('')}</colgroup>`
    : '';
  const rows = table.cells.map((row, ri) => `<tr${styleAttr([
    ['height', table.rowHeights[ri] ? px(table.rowHeights[ri]) : undefined],
  ])}>${row.map((c) => {
    if (c.merged) return '';
    const borders = c.borders;
    const defaultBorder = '1px solid rgba(0, 0, 0, 0.28)';
    return `<td${c.gridSpan ? ` colspan="${c.gridSpan}"` : ''}${c.rowSpan ? ` rowspan="${c.rowSpan}"` : ''}${styleAttr([
      ['background', c.fill],
      ['border-left', borders ? (borders.l ? `1px solid ${borders.l}` : 'none') : defaultBorder],
      ['border-right', borders ? (borders.r ? `1px solid ${borders.r}` : 'none') : defaultBorder],
      ['border-top', borders ? (borders.t ? `1px solid ${borders.t}` : 'none') : defaultBorder],
      ['border-bottom', borders ? (borders.b ? `1px solid ${borders.b}` : 'none') : defaultBorder],
      ['padding', '2px 5px'],
      ['font-size', px(ptToPx((c.sizePt ?? 14) * shape.textScale))],
      ['font-weight', c.bold ? 700 : 400],
      ['color', c.color],
      ['vertical-align', 'middle'],
      ['overflow', 'hidden'],
      ['box-sizing', 'border-box'],
    ])}>${xmlEscape(c.text)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div aria-hidden="true"${shapeBaseStyle(shape, true)}><table${styleAttr([
    ['table-layout', 'fixed'],
    ['width', '100%'],
    ['height', '100%'],
    ['border-collapse', 'collapse'],
    ['font-family', PPTX_PDF_FONT_STACK],
  ])}>${cols}<tbody>${rows}</tbody></table></div>`;
}

function shapeBaseStyle(shape: PptxShape, overflowHidden = false): string {
  return styleAttr([
    ['position', 'absolute'],
    ['left', px(shape.x)],
    ['top', px(shape.y)],
    ['width', px(shape.w)],
    ['height', px(shape.h)],
    ['transform', shape.rot ? `rotate(${shape.rot}deg)` : undefined],
    ['transform-origin', shape.rot ? 'center center' : undefined],
    ['overflow', overflowHidden ? 'hidden' : undefined],
    ['box-sizing', 'border-box'],
  ]);
}

function shapeHtml(shape: PptxShape, media: Map<string, string>): string {
  const radius = borderRadiusFor(shape);
  if (shape.type === 'image') {
    const src = mediaUrl(shape.imageUrl, media);
    if (!src || shape.w <= 0 || shape.h <= 0) return '';
    if (!shape.crop) {
      return `<img alt="" draggable="false" src="${xmlEscape(src)}"${styleAttr([
        ['position', 'absolute'],
        ['left', px(shape.x)],
        ['top', px(shape.y)],
        ['width', px(shape.w)],
        ['height', px(shape.h)],
        ['transform', shape.rot ? `rotate(${shape.rot}deg)` : undefined],
        ['transform-origin', shape.rot ? 'center center' : undefined],
        ['object-fit', 'fill'],
        ['border-radius', radius],
        ['user-select', 'none'],
      ])}>`;
    }
    const crop = shape.crop;
    const kw = Math.max(1 - crop.l - crop.r, 0.01);
    const kh = Math.max(1 - crop.t - crop.b, 0.01);
    return `<div aria-hidden="true"${styleAttr([
      ['position', 'absolute'],
      ['left', px(shape.x)],
      ['top', px(shape.y)],
      ['width', px(shape.w)],
      ['height', px(shape.h)],
      ['transform', shape.rot ? `rotate(${shape.rot}deg)` : undefined],
      ['transform-origin', shape.rot ? 'center center' : undefined],
      ['overflow', 'hidden'],
      ['border-radius', radius],
    ])}><img alt="" draggable="false" src="${xmlEscape(src)}"${styleAttr([
      ['position', 'absolute'],
      ['left', px(-(crop.l * shape.w) / kw)],
      ['top', px(-(crop.t * shape.h) / kh)],
      ['width', px(shape.w / kw)],
      ['height', px(shape.h / kh)],
      ['object-fit', 'fill'],
      ['max-width', 'none'],
      ['user-select', 'none'],
    ])}></div>`;
  }

  if (shape.type === 'line') {
    return `<div aria-hidden="true"${styleAttr([
      ['position', 'absolute'],
      ['left', px(shape.x)],
      ['top', px(shape.y)],
      ['width', px(Math.max(shape.w, 1))],
      ['height', px(Math.max(shape.h, shape.borderWidth || 2))],
      ['transform', shape.rot ? `rotate(${shape.rot}deg)` : undefined],
      ['transform-origin', shape.rot ? 'center center' : undefined],
      ['background', shape.fill || shape.borderColor || '#000000'],
      ['border-radius', '2px'],
    ])}></div>`;
  }

  if (shape.type === 'table') return tableHtml(shape);

  if (shape.type === 'chart') {
    return `<div aria-hidden="true"${styleAttr([
      ['position', 'absolute'],
      ['left', px(shape.x)],
      ['top', px(shape.y)],
      ['width', px(shape.w)],
      ['height', px(shape.h)],
      ['display', 'flex'],
      ['align-items', 'center'],
      ['justify-content', 'center'],
      ['border', '1px dashed #d1d5db'],
      ['background', 'rgba(249, 250, 251, 0.8)'],
      ['color', '#9ca3af'],
      ['font-size', '10px'],
      ['font-weight', 600],
      ['letter-spacing', '0.06em'],
      ['text-transform', 'uppercase'],
      ['box-sizing', 'border-box'],
    ])}>Chart</div>`;
  }

  const t = shape.text;
  const border = shape.borderColor ? `${Math.max(1, shape.borderWidth || 1)}px solid ${shape.borderColor}` : undefined;
  const body = t ? `<div${styleAttr([
    ['width', '100%'],
    ['height', '100%'],
    ['display', 'flex'],
    ['flex-direction', 'column'],
    ['justify-content', t.anchor === 'ctr' ? 'center' : t.anchor === 'b' ? 'flex-end' : 'flex-start'],
    ['padding', '5px 9px'],
    ['box-sizing', 'border-box'],
  ])}>${t.paragraphs.map((p) => paragraphHtml(p, shape, t.levels[p.level])).join('')}</div>` : '';
  return `<div data-shape="${shape.isTitle ? 'title' : 'text'}"${styleAttr([
    ['position', 'absolute'],
    ['left', px(shape.x)],
    ['top', px(shape.y)],
    ['width', px(shape.w)],
    ['height', px(shape.h)],
    ['transform', shape.rot ? `rotate(${shape.rot}deg)` : undefined],
    ['transform-origin', shape.rot ? 'center center' : undefined],
    ['background', shape.fill],
    ['border', border],
    ['border-radius', radius],
    ['overflow', shape.fill ? 'hidden' : undefined],
    ['box-sizing', 'border-box'],
  ])}>${body}</div>`;
}

function slideXhtml(deck: PptxDocument, slide: PptxSlide, media: Map<string, string>): string {
  const backgroundUrl = mediaUrl(slide.backgroundImageUrl, media);
  return `<div xmlns="http://www.w3.org/1999/xhtml"${styleAttr([
    ['position', 'relative'],
    ['overflow', 'hidden'],
    ['width', px(deck.slideWidth)],
    ['height', px(deck.slideHeight)],
    ['background', slide.background ?? '#ffffff'],
    ['background-image', backgroundUrl ? `url("${backgroundUrl}")` : undefined],
    ['background-size', backgroundUrl ? 'cover' : undefined],
    ['background-position', backgroundUrl ? 'center' : undefined],
    ['font-family', PPTX_PDF_FONT_STACK],
    ['box-sizing', 'border-box'],
  ])}>${slide.shapes.map((shape) => shapeHtml(shape, media)).join('')}</div>`;
}

function loadRasterImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => reject(new Error('Timed out while rendering slide image')), 15000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Could not render slide image'));
    };
    image.src = url;
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        try {
          if (!blob) throw new Error('Canvas did not produce PNG data');
          resolve(new Uint8Array(await blob.arrayBuffer()));
        } catch (err) {
          reject(err);
        }
      }, 'image/png');
    });
  }
  const dataUrl = canvas.toDataURL('image/png');
  return fetch(dataUrl).then(async (res) => new Uint8Array(await res.arrayBuffer()));
}

async function rasterizeSlideToPng(deck: PptxDocument, slide: PptxSlide): Promise<Uint8Array> {
  const media = await slideMediaAsDataUrls(slide);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${deck.slideWidth}" height="${deck.slideHeight}" viewBox="0 0 ${deck.slideWidth} ${deck.slideHeight}"><foreignObject x="0" y="0" width="100%" height="100%">${slideXhtml(deck, slide, media)}</foreignObject></svg>`;
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadRasterImage(svgUrl);
    const naturalPixels = Math.max(1, deck.slideWidth * deck.slideHeight);
    const scale = Math.max(1, Math.min(2, Math.sqrt(MAX_RASTER_PIXELS / naturalPixels)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(deck.slideWidth * scale));
    canvas.height = Math.max(1, Math.round(deck.slideHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is not available');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, deck.slideWidth, deck.slideHeight);
    return canvasToPngBytes(canvas);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

async function drawSlideRaster(pdf: PDFDocument, deck: PptxDocument, slide: PptxSlide): Promise<PDFPage> {
  const pngBytes = await rasterizeSlideToPng(deck, slide);
  const png = await pdf.embedPng(pngBytes);
  const page = pdf.addPage([deck.slideWidth, deck.slideHeight]);
  page.drawImage(png, { x: 0, y: 0, width: deck.slideWidth, height: deck.slideHeight });
  return page;
}

function drawParagraph(
  page: PDFPage,
  p: PptxParagraph,
  shape: PptxShape,
  fonts: ConversionFonts,
  cursor: { x: number; y: number },
  maxY: number,
  opacity = 1,
): number {
  const defaultSize = ptToPx((p.runs.find((r) => r.sizePt)?.sizePt || shape.text?.defaultSizePt || 18) * (shape.text?.fontScale || 1) * shape.textScale);
  const bullet = p.bullet ? `${p.bullet} ` : '';
  const full = `${bullet}${p.runs.map((r) => r.text).join('')}`;
  const firstRun = p.runs[0] || {};
  const font = fontFor(firstRun, fonts);
  const size = Math.max(5, defaultSize * 0.78);
  const lines = wrapText(full, Math.max(12, shape.w - 18), font, size, fonts.unicode);
  const lineHeight = size * (p.lineSpacing || 1.18);
  let y = cursor.y;
  const align = p.align || 'left';
  for (const line of lines) {
    if (y - lineHeight < maxY) break;
    const textWidth = font.widthOfTextAtSize(line, size);
    const x = align === 'center'
      ? cursor.x + Math.max(0, (shape.w - 18 - textWidth) / 2)
      : align === 'right'
        ? cursor.x + Math.max(0, shape.w - 18 - textWidth)
        : cursor.x;
    drawTextSafe(page, line, {
      x,
      y,
      size,
      font,
      color: toRgb(firstRun.color, rgb(0, 0, 0)),
      opacity,
    }, fonts.unicode);
    y -= lineHeight;
  }
  return y - (p.spaceAfterPt ? ptToPx(p.spaceAfterPt) * 0.5 : 0);
}

function drawSearchableTextLayer(page: PDFPage, slide: PptxSlide, fonts: ConversionFonts, pageHeight: number): void {
  const hiddenOpacity = 0;
  for (const shape of slide.shapes) {
    if (shape.text?.paragraphs.length) {
      let cursorY = toPdfY(pageHeight, shape.y) - 12;
      const minY = toPdfY(pageHeight, shape.y + shape.h) + 5;
      for (const p of shape.text.paragraphs) {
        cursorY = drawParagraph(page, p, shape, fonts, { x: shape.x + 9, y: cursorY }, minY, hiddenOpacity);
        if (cursorY <= minY) break;
      }
    } else if (shape.type === 'table' && shape.table) {
      const rows = shape.table.cells;
      const rowHeights = shape.table.rowHeights.length ? shape.table.rowHeights : rows.map(() => shape.h / Math.max(1, rows.length));
      const colWidths = shape.table.colWidths.length ? shape.table.colWidths : rows[0]?.map(() => shape.w / Math.max(1, rows[0].length)) || [];
      let cy = shape.y;
      rows.forEach((row, ri) => {
        let cx = shape.x;
        const rh = rowHeights[ri] || 24;
        row.forEach((cell, ci) => {
          const cw = colWidths[ci] || 80;
          if (cell.merged) {
            cx += cw;
            return;
          }
          const py = toPdfY(pageHeight, cy, rh);
          const font = cell.bold ? fonts.bold : fonts.regular;
          const size = Math.max(5, ptToPx(cell.sizePt || 11) * 0.72);
          const lines = wrapText(cell.text || '', Math.max(8, cw - 6), font, size, fonts.unicode).slice(0, Math.max(1, Math.floor((rh - 4) / (size * 1.15))));
          lines.forEach((line, lineIndex) => drawTextSafe(page, line, {
            x: cx + 3,
            y: py + rh - 4 - size - lineIndex * size * 1.15,
            size,
            font,
            color: rgb(0, 0, 0),
            opacity: hiddenOpacity,
          }, fonts.unicode));
          cx += cw;
        });
        cy += rh;
      });
    }
  }
}

async function drawShape(pdf: PDFDocument, page: PDFPage, shape: PptxShape, fonts: ConversionFonts, pageHeight: number) {
  const y = toPdfY(pageHeight, shape.y, shape.h);
  if (shape.type === 'image') {
    if (!shape.imageUrl || shape.w <= 0 || shape.h <= 0) return;
    const img = await embedImage(pdf, shape.imageUrl).catch(() => null);
    if (!img) return;
    page.drawImage(img, {
      x: shape.x,
      y,
      width: shape.w,
      height: shape.h,
      rotate: shape.rot ? degrees(shape.rot) : undefined,
    });
    return;
  }

  if (shape.type === 'line') {
    page.drawLine({
      start: { x: shape.x, y: toPdfY(pageHeight, shape.y) },
      end: { x: shape.x + Math.max(shape.w, 1), y: toPdfY(pageHeight, shape.y + Math.max(shape.h, 1)) },
      thickness: Math.max(1, shape.borderWidth || 2),
      color: toRgb(shape.fill || shape.borderColor, rgb(0, 0, 0)),
    });
    return;
  }

  if (shape.fill || shape.borderColor) {
    const paint = {
      color: shape.fill ? toRgb(shape.fill, rgb(1, 1, 1)) : undefined,
      borderColor: shape.borderColor ? toRgb(shape.borderColor, rgb(0, 0, 0)) : undefined,
      borderWidth: shape.borderColor ? Math.max(0.5, shape.borderWidth || 1) : undefined,
      rotate: shape.rot ? degrees(shape.rot) : undefined,
    };
    if (shape.geom === 'ellipse') {
      page.drawEllipse({
        x: shape.x + shape.w / 2,
        y: y + shape.h / 2,
        xScale: Math.max(0, shape.w / 2),
        yScale: Math.max(0, shape.h / 2),
        ...paint,
      });
    } else {
      page.drawRectangle({
        x: shape.x,
        y,
        width: Math.max(0, shape.w),
        height: Math.max(0, shape.h),
        ...paint,
      });
    }
  }

  if (shape.type === 'table' && shape.table) {
    const rows = shape.table.cells;
    const rowHeights = shape.table.rowHeights.length ? shape.table.rowHeights : rows.map(() => shape.h / Math.max(1, rows.length));
    const colWidths = shape.table.colWidths.length ? shape.table.colWidths : rows[0]?.map(() => shape.w / Math.max(1, rows[0].length)) || [];
    let cy = shape.y;
    rows.forEach((row, ri) => {
      let cx = shape.x;
      const rh = rowHeights[ri] || 24;
      row.forEach((cell, ci) => {
        const cw = colWidths[ci] || 80;
        if (cell.merged) {
          cx += cw;
          return;
        }
        const py = toPdfY(pageHeight, cy, rh);
        page.drawRectangle({ x: cx, y: py, width: cw, height: rh, color: toRgb(cell.fill, rgb(1, 1, 1)), borderColor: rgb(0.55, 0.55, 0.55), borderWidth: 0.5 });
        const font = cell.bold ? fonts.bold : fonts.regular;
        const size = Math.max(5, ptToPx(cell.sizePt || 11) * 0.72);
        const lines = wrapText(cell.text || '', Math.max(8, cw - 6), font, size, fonts.unicode).slice(0, Math.max(1, Math.floor((rh - 4) / (size * 1.15))));
        lines.forEach((line, lineIndex) => drawTextSafe(page, line, { x: cx + 3, y: py + rh - 4 - size - lineIndex * size * 1.15, size, font, color: toRgb(cell.color, rgb(0, 0, 0)) }, fonts.unicode));
        cx += cw;
      });
      cy += rh;
    });
    return;
  }

  if (shape.type === 'chart') {
    page.drawRectangle({ x: shape.x, y, width: shape.w, height: shape.h, color: rgb(0.96, 0.96, 0.96), borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 1 });
    drawTextSafe(page, 'Chart', { x: shape.x + 8, y: y + shape.h / 2, size: 11, font: fonts.bold, color: rgb(0.4, 0.4, 0.4) }, fonts.unicode);
    return;
  }

  if (shape.text?.paragraphs.length) {
    let cursorY = toPdfY(pageHeight, shape.y) - 12;
    const minY = toPdfY(pageHeight, shape.y + shape.h) + 5;
    for (const p of shape.text.paragraphs) {
      cursorY = drawParagraph(page, p, shape, fonts, { x: shape.x + 9, y: cursorY }, minY);
      if (cursorY <= minY) break;
    }
  }
}

async function drawSlide(pdf: PDFDocument, deck: PptxDocument, slide: PptxSlide, fonts: ConversionFonts) {
  const page = pdf.addPage([deck.slideWidth, deck.slideHeight]);
  page.drawRectangle({ x: 0, y: 0, width: deck.slideWidth, height: deck.slideHeight, color: toRgb(slide.background, rgb(1, 1, 1)) });
  if (slide.backgroundImageUrl) {
    const img = await embedImage(pdf, slide.backgroundImageUrl).catch(() => null);
    if (img) page.drawImage(img, { x: 0, y: 0, width: deck.slideWidth, height: deck.slideHeight });
  }
  for (const shape of slide.shapes) {
    await drawShape(pdf, page, shape, fonts, deck.slideHeight);
  }
}

export async function convertPptxToPdf(
  file: Blob,
  onProgress?: (progress: number, message: string) => void,
): Promise<PptxPdfConversionResult> {
  onProgress?.(0.04, 'Reading PowerPoint structure…');
  const deck = await renderPptx(file, { lazyMedia: true });
  const pdf = await PDFDocument.create();

  try {
    const total = Math.max(1, deck.slides.length);
    let rasterAvailable = hasBrowserRasterSupport();
    let fonts: ConversionFonts | null = null;
    let rasterWarnings = 0;

    for (const slide of deck.slides) {
      onProgress?.(
        0.08 + ((slide.slideNumber - 1) / total) * 0.82,
        `Rendering slide ${slide.slideNumber} of ${total} with PowerPoint colours…`,
      );
      await deck.ensureSlideMedia(slide.slideNumber);

      let rendered = false;
      if (rasterAvailable) {
        try {
          // Primary path: let the browser/WebView paint the actual positioned
          // slide DOM (gradients, rgba fills, clipped pictures, mixed run
          // styles), then place that faithful bitmap on the PDF page. The old
          // pdf-lib-only path below is retained as a safe fallback for tests and
          // older browsers without canvas foreignObject support.
          const page = await drawSlideRaster(pdf, deck, slide);
          if (slide.text.trim()) {
            fonts ??= await loadFonts(pdf);
            drawSearchableTextLayer(page, slide, fonts, deck.slideHeight);
          }
          rendered = true;
        } catch (err) {
          rasterWarnings += 1;
          if (rasterWarnings <= 2) console.warn('High-fidelity PPTX raster render failed; falling back to vector PDF drawing.', err);
          if (rasterWarnings >= 2) rasterAvailable = false;
        }
      }

      if (!rendered) {
        fonts ??= await loadFonts(pdf);
        await drawSlide(pdf, deck, slide, fonts);
      }
      await yieldToBrowser();
    }
    onProgress?.(0.94, 'Finalising PDF…');
    pdf.setTitle('Converted PowerPoint');
    pdf.setProducer('PharmaTRACK');
    pdf.setCreator('PharmaTRACK PPTX to PDF converter');
    const pdfBytes = await pdf.save({ useObjectStreams: true });
    return {
      pdfBytes,
      text: deck.fullText,
      pageTexts: deck.slides.map((slide) => ({ page: slide.slideNumber, text: slide.text })),
      pageCount: deck.slides.length,
    };
  } finally {
    deck.dispose();
  }
}
