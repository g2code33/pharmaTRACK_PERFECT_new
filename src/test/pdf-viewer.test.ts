/**
 * Guards for the PDF viewer's text layer and find-in-document.
 *
 * Highlighting silently did nothing because pdf.js 3.x positions text-layer
 * spans with `calc(var(--scale-factor) * ...)`. With that CSS variable unset
 * every span collapses, so there is nothing to select and no selection event
 * ever fires. pdf.js only reports it as a console.error, which is easy to miss.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const viewer = fs.readFileSync(
  path.resolve(__dirname, '../components/PdfViewer.tsx'), 'utf8',
);
const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
const reader = fs.readFileSync(path.resolve(__dirname, '../pages/SlideReader.tsx'), 'utf8');
const pptxViewer = fs.readFileSync(path.resolve(__dirname, '../components/PptxViewer.tsx'), 'utf8');
const layout = fs.readFileSync(path.resolve(__dirname, '../components/Layout.tsx'), 'utf8');
const titleBar = fs.readFileSync(path.resolve(__dirname, '../components/NativeTitleBar.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
const highlightsPage = fs.readFileSync(path.resolve(__dirname, '../pages/Highlights.tsx'), 'utf8');
const uploader = fs.readFileSync(path.resolve(__dirname, '../components/FileUploader.tsx'), 'utf8');
const studyMaterials = fs.readFileSync(path.resolve(__dirname, '../pages/StudyMaterials.tsx'), 'utf8');
const courseDetail = fs.readFileSync(path.resolve(__dirname, '../pages/CourseDetail.tsx'), 'utf8');

describe('pdf.js text layer requirements', () => {
  it('sets --scale-factor on the text layer container', () => {
    // The exact requirement pdf.js enforces. Without this line, selection and
    // therefore highlighting are impossible.
    expect(viewer).toMatch(/setProperty\(\s*'--scale-factor'\s*,\s*String\(viewport\.scale\)\s*\)/);
  });

  it('sets it before rendering the text layer, not after', () => {
    const setIdx = viewer.indexOf("setProperty('--scale-factor'");
    const renderIdx = viewer.indexOf('pdfjs.renderTextLayer');
    expect(setIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    // pdf.js reads the computed value when renderTextLayer is called.
    expect(setIdx).toBeLessThan(renderIdx);
  });

  it('keeps the text layer above saved highlights so selection still works', () => {
    // Highlights sit at z-index 1, the text layer at 2. Reversing these makes
    // highlighted passages unselectable.
    expect(viewer).toMatch(/background: overlayFor\(h\.color\)[\s\S]{0,120}zIndex: 1/);
    expect(viewer).toMatch(/pdf-text-layer[\s\S]{0,140}zIndex: 2/);
  });

  it('styles the text layer spans as transparent and absolutely positioned', () => {
    expect(css).toMatch(/\.pdf-text-layer span[\s\S]{0,200}position:\s*absolute/);
    expect(css).toMatch(/\.pdf-text-layer span[\s\S]{0,200}color:\s*transparent/);
  });
});

describe('find-in-document', () => {
  it('paints matches onto the rendered spans', () => {
    expect(viewer).toMatch(/mark\[data-find\]/);
    expect(css).toMatch(/\.pdf-text-layer mark\[data-find\]/);
  });

  it('clears previous marks before painting new ones', () => {
    // Otherwise marks accumulate and stale matches stay highlighted.
    expect(viewer).toMatch(/querySelectorAll\('mark\[data-find\]'\)/);
  });

  it('escapes regex metacharacters in the query', () => {
    // A query like "C(2)" must not compile as a capture group. Both the
    // hit-finding pass and the mark-painting pass go through escapeRe.
    expect(viewer).toMatch(/const escapeRe = \(s: string\) => s\.replace\(/);
    expect(viewer.split('escapeRe(raw)').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('supports match case, whole words and highlight all', () => {
    expect(viewer).toContain('matchCase');
    expect(viewer).toContain('wholeWords');
    expect(viewer).toContain('highlightAllMatches');
  });

  it('re-applies marks immediately after the text layer is rebuilt', () => {
    // renderTextLayer replaces the layer's children, so without this call the
    // marks vanish every time a page is re-rendered or revisited.
    expect(viewer).toMatch(/await textTask\.promise;[\s\S]{0,140}paintMarks\(pageNum\)/);
  });

  it('re-applies marks when returning to a cached page', () => {
    // Cache hits skip rendering entirely, so they must still repaint.
    expect(viewer).toMatch(/renderedKey\.current\.get\(pageNum\) === key\) \{ paintMarks\(pageNum\); return; \}/);
  });

  it('tracks and styles the active match distinctly', () => {
    expect(viewer).toContain('data-active');
    expect(css).toMatch(/mark\[data-find\]\[data-active\]/);
  });

  it('honours "highlight all" without losing the active match', () => {
    expect(css).toMatch(/\.find-active-only mark\[data-find\]:not\(\[data-active\]\)/);
  });

  it('has a search results panel in the sidebar', () => {
    expect(viewer).toContain('SearchResultsPanel');
    expect(viewer).toMatch(/sidebarTab === 'search'/);
  });
});

describe('viewer toolbar features', () => {
  const required: [string, RegExp][] = [
    ['sidebar toggle', /setSidebarOpen/],
    ['thumbnails', /sidebarTab === 'thumbnails'/],
    ['outline / bookmarks', /getOutline\(\)/],
    ['attachments', /getAttachments\(\)/],
    ['search results panel', /SearchResultsPanel/],
    ['zoom presets', /Automatic Zoom[\s\S]{0,200}Actual Size/],
    ['page fit / width', /'fit', 'Page Fit'[\s\S]{0,60}'width', 'Page Width'/],
    ['rotate both ways', /Rotate Clockwise[\s\S]{0,400}Rotate Counterclockwise/],
    ['scroll modes', /Vertical Scrolling[\s\S]{0,200}Horizontal Scrolling[\s\S]{0,200}Wrapped Scrolling/],
    ['spread modes', /No Spreads[\s\S]{0,200}Odd Spreads[\s\S]{0,200}Even Spreads/],
    ['text selection tool', /tool === 'select'/],
    ['hand tool', /tool === 'hand'/],
    ['first / last page', /Go to First Page[\s\S]{0,300}Go to Last Page/],
    ['print', /handlePrint/],
    ['download', /download=\{title/],
    ['document properties', /Document Properties/],
  ];

  it.each(required)('has %s', (_label, pattern) => {
    expect(viewer).toMatch(pattern);
  });
});

describe('instant page navigation', () => {
  it('caches renders per page, scale and rotation', () => {
    // Without a cache every scroll re-rasterises pages already on screen,
    // which is what made paging feel slow.
    expect(viewer).toMatch(/renderedKey = useRef<Map<number, string>>/);
    expect(viewer).toMatch(/const key = `\$\{scale\.toFixed\(3\)\}\|\$\{rotation\}`/);
    expect(viewer).toMatch(/renderedKey\.current\.set\(pageNum, key\)/);
  });

  it('invalidates the cache when zoom or rotation changes', () => {
    expect(viewer).toMatch(/renderedKey\.current\.clear\(\);[\s\S]{0,120}\[scale, rotation\]/);
  });

  it('sizes page boxes before rendering so scrolling is accurate', () => {
    // Boxes get their real dimensions from the measured viewport, so the
    // scrollbar is correct from the first frame and jumps land in one go.
    expect(viewer).toMatch(/const scaledSize = useCallback/);
    expect(viewer).toMatch(/width: size\?\.w[\s\S]{0,60}height: size\?\.h/);
  });

  it('pre-renders a small sequential window around the viewport', () => {
    expect(viewer).toContain('const RENDER_WINDOW = 2');
    expect(viewer).toMatch(/const renderWindow = useCallback/);
    expect(viewer).toContain('await renderPage(p);');
    expect(viewer).toContain('await yieldToMainThread();');
  });

  it('evicts distant canvases so long documents stay bounded', () => {
    // A single high-DPR page canvas is many MB; keeping 100 would exhaust memory.
    expect(viewer).toContain('const KEEP_WINDOW = 8');
    expect(viewer).toMatch(/Math\.abs\(p - centre\) > KEEP_WINDOW/);
  });

  it('does not extract every page of text until Find needs it', () => {
    expect(viewer).toContain('if (!showSearch && !initialQuery) return;');
    expect(viewer).toContain('const dpr = Math.min(window.devicePixelRatio || 1, 1.5);');
  });

  it('renders the destination before scrolling to it', () => {
    expect(viewer).toMatch(/renderWindow\(clamped\);[\s\S]{0,120}scrollIntoView/);
  });

  it('avoids duplicate concurrent renders of the same page', () => {
    expect(viewer).toMatch(/inFlight\.current\.has\(pageNum\)/);
  });
});

describe('no re-render churn while scrolling', () => {
  it('does not recompute zoom from currentPage or scale', () => {
    // Including either created a feedback loop: scroll -> currentPage changes
    // -> fit recomputes -> setScale -> every cached raster invalidated -> the
    // visible pages re-render. That is what looked like constant refreshing.
    expect(viewer).toMatch(/\}, \[doc, zoomPreset, rotation, spreadMode, baseSizes\]\);/);
    expect(viewer).not.toMatch(/\[doc, zoomPreset, rotation, spreadMode, baseSizes, currentPage, scale\]/);
  });

  it('ignores sub-pixel resize noise', () => {
    expect(viewer).toMatch(/Math\.abs\(clamped - prev\) > 0\.01/);
  });
});

describe('study bank deep link', () => {
  it('accepts a highlight id, not just a page', () => {
    expect(viewer).toContain('focusHighlightId');
    expect(highlightsPage).toMatch(/params\.set\('highlight', h\.id\)/);
  });

  it('scrolls the highlight itself into view and flashes it', () => {
    expect(viewer).toMatch(/data-highlight-id="\$\{focusHighlightId\}"/);
    expect(viewer).toMatch(/scrollIntoView\(\{ block: 'center'/);
    expect(css).toMatch(/@keyframes highlight-flash/);
  });

  it('is wired through the reader', () => {
    expect(reader).toMatch(/searchParams\.get\('highlight'\)/);
    expect(reader).toContain('focusHighlightId={focusHighlightId}');
  });
});

describe('whole-document uploads', () => {
  it('has no single-file content-type gate in the upload dialogs', () => {
    // "PDF / Word / PowerPoint / Image" tabs meant the picker filtered to one
    // type, which is why .docx and .pptx appeared to be missing.
    for (const src of [studyMaterials, courseDetail]) {
      expect(src).not.toMatch(/Material Format/);
      expect(src).not.toMatch(/label: 'PowerPoint'/);
      expect(src).toMatch(/Upload documents/);
    }
  });

  it('always allows multiple files', () => {
    expect(uploader).toMatch(/^\s*multiple$/m);
    expect(uploader).not.toContain('multiple={!compact}');
  });
});

describe('stable layout', () => {
  it('keeps the native titlebar and hamburger/sidebar shell white, not green-gradient', () => {
    // The window strip lives in its own component so every full-height screen
    // can render it; the Layout mounts that component.
    expect(titleBar).toContain('native-titlebar flex h-9 flex-shrink-0 items-center border-b border-slate-200 bg-white');
    expect(layout).toContain('<NativeTitleBar />');
    expect(layout).toContain('mobile-sidebar fixed inset-y-0 left-0 z-[230] bg-white text-slate-900');
    expect(css).toContain('background: #ffffff !important;');
    expect(css).not.toContain('linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(6, 78, 59, 0.84))');
  });

  it('adds a universal back button to the app header on non-home routes', () => {
    expect(layout).toContain("const showBackButton = location.pathname !== '/';");
    expect(layout).toContain('aria-label="Go back"');
    expect(layout).toContain("if (typeof window !== 'undefined' && window.history.length > 1) navigate(-1);");
  });

  it('does not force dark-mode native desktop backgrounds back to white', () => {
    const darkShell = css.match(/\.dark \.app-shell \{([\s\S]*?)\}/)?.[1] ?? '';
    const darkHeader = css.match(/\.dark \.app-shell \.app-header \{([\s\S]*?)\}/)?.[1] ?? '';
    const darkPage = css.match(/\.dark \.app-shell \.app-page-main \{([\s\S]*?)\}/)?.[1] ?? '';
    const darkSidebar = css.match(/\.dark \.app-shell \.mobile-sidebar \{([\s\S]*?)\}/)?.[1] ?? '';

    expect(layout).toContain('app-header bg-white dark:bg-slate-900');
    expect(layout).toContain('mobile-bottom-nav lg:hidden fixed inset-x-0 bottom-0');
    expect(layout).toContain('dark:bg-slate-900');
    expect(darkShell).toContain('background: #020617');
    expect(darkHeader).toContain('background: #0f172a !important');
    expect(darkPage).toContain('background: #0f172a !important');
    expect(darkSidebar).toContain('background: #1e293b !important');
    expect(darkHeader).not.toContain('background: #ffffff !important');
    expect(darkPage).not.toContain('background: #f8fafc !important');
  });

  it('does not apply expensive native hover filters/transforms or always-on shell animations', () => {
    expect(css).not.toContain('filter: brightness(1.03)');
    expect(css).not.toContain('transform: translateY(1px) scale(0.99)');
    expect(layout).not.toContain('animate-ping');
    expect(layout).not.toContain('animate-pulse');
  });

  it('lets the reader fill the available app page without a second page scroll or bottom void', () => {
    expect(reader).toContain("isFullscreen ? 'fixed inset-0 z-[250] h-[100dvh] w-screen' : 'h-full flex-1'");
    expect(reader).toContain('slide-reader-fullbleed');
    expect(reader).toContain('flex flex-1 min-h-0 overflow-hidden relative');
    expect(reader).toContain('flex-1 overflow-hidden flex flex-col items-stretch p-0');
    // The reader layout is keyed off the route rather than a `:has()` rule on
    // the main scroll container, which the style engine had to re-check on
    // every DOM mutation inside the page.
    expect(layout).toContain("isReaderRoute ? 'app-page-main--reader p-0 overflow-hidden flex flex-col' : 'p-3 sm:p-6 overflow-y-auto'");
    expect(css).toMatch(/app-page-main--reader[\s\S]{0,180}display:\s*flex/);
  });

  it('opens the reader at full width instead of showing a default split panel', () => {
    expect(reader).toContain('const [showAIPanel, setShowAIPanel] = useState(false);');
    expect(reader).toContain('Expand Reader');
  });

  it('opens documents at page-width zoom so the page fills the reader area', () => {
    expect(viewer).toContain('initialZoom?: ZoomPreset');
    expect(reader).toContain('initialZoom="width"');
    expect(reader).not.toContain("initialZoom={isConvertedPresentationPdf ? 'fit' : 'width'}");
  });

  it('keeps a permanent scrollbar gutter so pages cannot shift sideways', () => {
    // An appearing/disappearing scrollbar changed the track width, which moved
    // every centred page horizontally.
    expect(viewer).toContain('overflow-y-scroll');
  });

  it('renders ahead during PDF scrolling and repaints canvases after app resume', () => {
    expect(viewer).toContain('const RENDER_WINDOW = 2;');
    expect(viewer).toContain("rootMargin: '900px 0px'");
    expect(viewer).toContain("addEventListener('scroll', onScroll, { passive: true })");
    expect(viewer).toContain("window.addEventListener('pharmatrack:resume', onResume)");
    expect(css).toContain('.pdf-viewer-scroll');
    expect(css).toContain('.pdf-page-shell');
  });

  it('has a resume-paint watchdog so returning to the app cannot leave a black frame', () => {
    expect(app).toContain('ResumePaintRecovery');
    expect(app).toContain("window.dispatchEvent(new CustomEvent('pharmatrack:resume'))");
    expect(app).toContain("window.addEventListener('pageshow', repaint)");
    expect(css).toContain('html.pharmatrack-resume-paint #root');
  });

  it('also refreshes the slide viewer surface after resume', () => {
    expect(pptxViewer).toContain("window.addEventListener('pharmatrack:resume', onResume)");
    expect(pptxViewer).toContain('pptx-viewer-scroll');
    expect(pptxViewer).toContain('pptx-slide-stage');
    expect(css).toContain('.pptx-viewer-scroll');
  });

  it('centres pages with a stable margin rather than a utility class', () => {
    expect(viewer).toMatch(/marginInline: inline \? undefined : 'auto'/);
  });
});

describe('page numbering', () => {
  it('reads publisher page labels when present', () => {
    // Lecture decks are often numbered i, ii, 1, 2 or start at an offset, so
    // the sheet index is not what is printed on the page.
    expect(viewer).toContain('getPageLabels()');
    expect(viewer).toMatch(/const labelFor = useCallback/);
  });

  it('ignores label sets that just repeat the index', () => {
    expect(viewer).toMatch(/labels\.some\(\(l, i\) => l !== String\(i \+ 1\)\)/);
  });

  it('falls back to the sheet number', () => {
    expect(viewer).toMatch(/pageLabels\?\.\[n - 1\] \?\? String\(n\)/);
  });
});

describe('highlights sidebar', () => {
  it('the toolbar count opens the highlights panel', () => {
    expect(viewer).toMatch(/setSidebarTab\('highlights'\)/);
  });

  it('lists every highlight with its page and jumps to it', () => {
    expect(viewer).toMatch(/sidebarTab === 'highlights'/);
    expect(viewer).toMatch(/data-highlight-id="\$\{h\.id\}"/);
  });
});

describe('deep search hand-off', () => {
  it('accepts a query from global search and pre-fills the find bar', () => {
    expect(viewer).toContain('initialQuery');
    expect(reader).toMatch(/searchParams\.get\('q'\)/);
  });

  it('opens the material the hit came from, not the first one', () => {
    expect(reader).toMatch(/searchParams\.get\('material'\)/);
    expect(reader).toMatch(/materialList\.findIndex\(\(m\) => m\.id === deepLinkMaterial\)/);
  });
});
