import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import regularFontUrl from '../assets/fonts/DejaVuSans.ttf?url';
import boldFontUrl from '../assets/fonts/DejaVuSans-Bold.ttf?url';
import { renderPptx, ptToPx, type PptxDocument, type PptxParagraph, type PptxShape, type PptxSlide } from './pptxRenderer';

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

function drawParagraph(
  page: PDFPage,
  p: PptxParagraph,
  shape: PptxShape,
  fonts: ConversionFonts,
  cursor: { x: number; y: number },
  maxY: number,
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
    }, fonts.unicode);
    y -= lineHeight;
  }
  return y - (p.spaceAfterPt ? ptToPx(p.spaceAfterPt) * 0.5 : 0);
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
  const fonts = await loadFonts(pdf);

  try {
    const total = Math.max(1, deck.slides.length);
    for (const slide of deck.slides) {
      onProgress?.(0.08 + ((slide.slideNumber - 1) / total) * 0.82, `Converting slide ${slide.slideNumber} of ${total} to PDF…`);
      await deck.ensureSlideMedia(slide.slideNumber);
      await drawSlide(pdf, deck, slide, fonts);
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
