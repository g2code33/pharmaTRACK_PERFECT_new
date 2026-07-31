import JSZip from 'jszip';

/**
 * Renders .pptx natively in the browser.
 *
 * Why not convert to PDF: there is no reliable in-browser PPTX->PDF converter.
 * Real conversion needs LibreOffice (~300 MB) or a cloud API, and a cloud call
 * breaks the offline-first promise this app is built on. A .pptx is just a ZIP
 * of XML plus media, so we can read it directly and lay it out ourselves —
 * fully offline, no extra dependency beyond JSZip which is already installed.
 *
 * We extract, per slide: title, body text (in reading order), speaker notes,
 * and embedded images resolved through the slide's relationship file.
 */

export interface PptxSlide {
  slideNumber: number;
  title: string;
  /** Body paragraphs, excluding the title. */
  body: string[];
  /** Speaker notes, if present. */
  notes: string;
  /** Object URLs for images placed on this slide. */
  images: string[];
  /** Everything as one string, for search and AI context. */
  text: string;
}

export interface PptxDocument {
  slides: PptxSlide[];
  /** Combined text of every slide. */
  fullText: string;
  /** Call when unmounting to release the image object URLs. */
  dispose: () => void;
}

const MEDIA_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', emf: 'image/emf', wmf: 'image/wmf',
};

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

/** Numeric sort so slide10 doesn't land between slide1 and slide2. */
const byNumber = (a: string, b: string) =>
  (parseInt(a.match(/(\d+)\.xml$/)?.[1] ?? '0', 10)) -
  (parseInt(b.match(/(\d+)\.xml$/)?.[1] ?? '0', 10));

/**
 * Pulls text out of a shape, preserving paragraph breaks.
 * PPTX splits a single sentence across many <a:t> runs (one per formatting
 * change), so runs must be joined within a paragraph but separated between.
 */
const shapeText = (shape: Element): string => {
  const paragraphs = Array.from(shape.getElementsByTagName('a:p'));
  return paragraphs
    .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent ?? '').join(''))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
};

/** True when a shape is the slide's title placeholder. */
const isTitleShape = (shape: Element): boolean => {
  const ph = shape.getElementsByTagName('p:ph')[0];
  const type = ph?.getAttribute('type') ?? '';
  return type === 'title' || type === 'ctrTitle';
};

export const renderPptx = async (file: File | Blob): Promise<PptxDocument> => {
  const zip = await JSZip.loadAsync(file);
  const objectUrls: string[] = [];

  const slidePaths = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(byNumber);

  const slides: PptxSlide[] = [];

  for (let i = 0; i < slidePaths.length; i++) {
    const path = slidePaths[i];
    const xml = await zip.file(path)?.async('text');
    if (!xml) continue;

    const doc = parseXml(xml);

    // --- text ---
    let title = '';
    const body: string[] = [];
    for (const shape of Array.from(doc.getElementsByTagName('p:sp'))) {
      const text = shapeText(shape);
      if (!text) continue;
      if (!title && isTitleShape(shape)) title = text.split('\n')[0];
      else body.push(text);
    }

    // --- images, resolved via the slide's rels file ---
    const relsPath = path.replace(/slides\/(slide\d+)\.xml$/, 'slides/_rels/$1.xml.rels');
    const relsXml = await zip.file(relsPath)?.async('text');
    const images: string[] = [];

    if (relsXml) {
      const rels = parseXml(relsXml);
      const idToTarget = new Map<string, string>();
      for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target && /image/i.test(rel.getAttribute('Type') ?? '')) {
          idToTarget.set(id, target.replace(/^\.\.\//, 'ppt/'));
        }
      }

      // <a:blip r:embed="rId2"/> points at a relationship, not a file path.
      for (const blip of Array.from(doc.getElementsByTagName('a:blip'))) {
        const rId = blip.getAttribute('r:embed') ?? blip.getAttribute('r:link');
        const target = rId ? idToTarget.get(rId) : undefined;
        if (!target) continue;

        const entry = zip.file(target) ?? zip.file(target.replace(/^ppt\//, ''));
        if (!entry) continue;

        const ext = target.split('.').pop()?.toLowerCase() ?? 'png';
        // EMF/WMF are vector formats browsers can't display; skip rather than
        // render a broken image icon.
        if (ext === 'emf' || ext === 'wmf') continue;

        const blob = await entry.async('blob');
        const url = URL.createObjectURL(new Blob([blob], { type: MEDIA_MIME[ext] ?? 'image/png' }));
        objectUrls.push(url);
        images.push(url);
      }
    }

    // --- speaker notes ---
    const notesPath = path.replace(/slides\/slide(\d+)\.xml$/, 'notesSlides/notesSlide$1.xml');
    const notesXml = await zip.file(notesPath)?.async('text');
    let notes = '';
    if (notesXml) {
      const notesDoc = parseXml(notesXml);
      notes = Array.from(notesDoc.getElementsByTagName('a:p'))
        .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent ?? '').join(''))
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n')
        // The notes slide repeats the slide number as a lone numeric line.
        .replace(/^\d+\s*$/gm, '')
        .trim();
    }

    const slideNumber = i + 1;
    const text = [title, ...body, notes && `Notes: ${notes}`].filter(Boolean).join('\n');

    slides.push({ slideNumber, title: title || `Slide ${slideNumber}`, body, notes, images, text });
  }

  return {
    slides,
    fullText: slides.map((s) => `--- Slide ${s.slideNumber} ---\n${s.text}`).join('\n\n'),
    dispose: () => objectUrls.forEach((u) => URL.revokeObjectURL(u)),
  };
};
