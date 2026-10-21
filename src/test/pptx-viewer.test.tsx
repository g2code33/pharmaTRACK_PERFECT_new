/**
 * UI tests for the native .pptx viewer.
 *
 * Covers the acceptance flow: parse → slide stage → navigation (buttons,
 * keyboard, swipe, thumbnails, direct jump) → zoom → find (deep-link into a
 * matching slide) → notes → fullscreen → file info → resume position →
 * error fallback with "Download Original" / "View Extracted Text" / "Retry".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import JSZip from 'jszip';
import React from 'react';

import PptxViewer from '../components/PptxViewer';
import { buildPowerPointDeck } from './pptx-powerpoint-fixture';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const slideXml = (title: string, body: string) => `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const notesXml = `<?xml version="1.0"?>
<p:notes xmlns:p="${P}" xmlns:a="${A}">
  <a:p><a:r><a:t>Emphasise the beta blocker contraindication</a:t></a:r></a:p>
</p:notes>`;

const buildDeck = async (titles: [string, string][]) => {
  const zip = new JSZip();
  titles.forEach(([t, b], i) => zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(t, b)));
  zip.file('ppt/notesSlides/notesSlide1.xml', notesXml);
  return (await zip.generateAsync({ type: 'blob' })) as Blob;
};

const mockFetchBlob = (blob: Blob) => {
  // The viewer only calls .blob(); return the jsdom Blob directly (a real
  // Response would hand back a Node Blob that jsdom's FileReader rejects).
  vi.mocked(fetch).mockResolvedValue({ blob: async () => blob } as unknown as Response);
};

const DECK: [string, string][] = [
  ['Intro Cardio', 'Intro body text'],
  ['Beta blockers', 'Beta blockers block adrenergic receptors'],
  ['Side effects', 'List of side effects'],
];

const pageInput = () => screen.getByLabelText('Go to slide') as HTMLInputElement;
const nextBtn = () => screen.getByTitle('Next slide (→)');
const prevBtn = () => screen.getByTitle('Previous slide (←)');

/**
 * Slide-content queries are scoped to the stage: the thumbnail sidebar
 * renders the same text at miniature scale, so a global query would hit
 * both.
 */
const stageContains = (text: string): boolean =>
  Array.from(screen.getByTestId('pptx-stage').querySelectorAll('*')).some(
    (el) => el.children.length === 0 && el.textContent === text,
  );

describe('PptxViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('parses the deck, shows the first slide and "n of N"', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-1" title="Cardiovascular Pharmacology" />);

    await waitFor(() => expect(pageInput().value).toBe('1'));
    expect(screen.getByText('of 3')).toBeTruthy();
    expect(stageContains('Intro Cardio')).toBe(true);
    // Body text is rendered as real DOM text (selectable/searchable).
    expect(stageContains('Intro body text')).toBe(true);
    // Other slides are not rendered in the stage (single-slide view).
    expect(stageContains('Beta blockers')).toBe(false);
  });

  it('navigates with buttons and the keyboard', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-2" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    fireEvent.click(nextBtn());
    expect(pageInput().value).toBe('2');
    // Slides parse on demand from the lazy deck, so the stage content lands
    // a tick after the page counter moves.
    await waitFor(() => expect(stageContains('Beta blockers')).toBe(true));

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(pageInput().value).toBe('3');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(pageInput().value).toBe('2');

    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(pageInput().value).toBe('3');
    expect(nextBtn()).toBeDisabled();

    fireEvent.keyDown(window, { key: 'Home' });
    expect(pageInput().value).toBe('1');
    expect(prevBtn()).toBeDisabled();

    fireEvent.keyDown(window, { key: 'End' });
    expect(pageInput().value).toBe('3');
  });

  it('supports swipe navigation', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-3" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const stage = screen.getByTestId('pptx-stage');
    fireEvent.touchStart(stage, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 120, clientY: 100 }] });
    expect(pageInput().value).toBe('2');

    fireEvent.touchStart(stage, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 320, clientY: 100 }] });
    expect(pageInput().value).toBe('1');
  });

  it('renders a lazy thumbnail sidebar and jumps on click', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-4" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    expect(screen.getByTestId('pptx-thumb-1')).toBeTruthy();
    expect(screen.getByTestId('pptx-thumb-2')).toBeTruthy();
    expect(screen.getByTestId('pptx-thumb-3')).toBeTruthy();

    fireEvent.click(screen.getByTestId('pptx-thumb-3'));
    expect(pageInput().value).toBe('3');
    await waitFor(() => expect(stageContains('Side effects')).toBe(true));
  });

  it('zooms in/out and shows the percentage', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-5" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    fireEvent.click(screen.getByTitle('Zoom in (Ctrl +)'));
    expect(screen.getByText('120%')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Zoom out (Ctrl -)'));
    fireEvent.click(screen.getByTitle('Zoom out (Ctrl -)'));
    expect(screen.getByText('80%')).toBeTruthy();
  });

  it('opens file info with slide count, size and type', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-6" title="Pharmaco" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    fireEvent.click(screen.getByTitle('More tools'));
    fireEvent.click(screen.getByText('File Info'));
    expect(screen.getByText('PowerPoint (PPTX)')).toBeTruthy();
    expect(screen.getByText('Slides')).toBeTruthy();
    // Exactly one "3" exists inside the info dialog.
    const dialog = screen.getByRole('dialog');
    expect(Array.from(dialog.querySelectorAll('dd')).some((dd) => dd.textContent === '3')).toBe(true);
    expect(screen.getByText('Download Original')).toBeTruthy();
  });

  it('resumes the last viewed slide per material', async () => {
    mockFetchBlob(await buildDeck(DECK));

    const first = render(<PptxViewer fileUrl="local:resume-1" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));
    fireEvent.click(nextBtn());
    fireEvent.click(nextBtn());
    expect(pageInput().value).toBe('3');
    first.unmount();

    const second = render(<PptxViewer fileUrl="local:resume-1" />);
    await waitFor(() => expect(pageInput().value).toBe('3'));
    expect(stageContains('Side effects')).toBe(true);
    second.unmount();

    // A different material starts from slide 1.
    const third = render(<PptxViewer fileUrl="local:resume-2" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));
    third.unmount();
  });

  it('deep-links to a slide with a prefilled search query', async () => {
    mockFetchBlob(await buildDeck(DECK));
    // "adrenergic" occurs on slide 2 only ("beta" would also match slide 1's
    // speaker notes, which are part of the searchable slide text).
    render(<PptxViewer fileUrl="local:test-7" jumpToPage={2} initialQuery="adrenergic" />);

    // Lands on slide 2, find bar open with the query, one matching slide.
    await waitFor(() => expect(pageInput().value).toBe('2'));
    expect(screen.getByDisplayValue('adrenergic')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeTruthy());
    expect(stageContains('Beta blockers')).toBe(true);
  });

  it('finds text across slides and steps through matches', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-8" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    fireEvent.click(screen.getByTitle('Find (Ctrl+F)'));
    const input = screen.getByPlaceholderText('Find in presentation…');
    fireEvent.change(input, { target: { value: 'effects' } });
    // "effects" appears on slide 3 only ("Side effects" + body).
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeTruthy());
    expect(pageInput().value).toBe('3');
  });

  it('shows speaker notes by default and toggles them off and on', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-9" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    // PowerPoint-style: the notes pane is visible under the slide on open.
    expect(screen.getByTestId('pptx-notes-pane')).toBeTruthy();
    expect(screen.getByText('Emphasise the beta blocker contraindication')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Toggle speaker notes'));
    expect(screen.queryByTestId('pptx-notes-pane')).toBeNull();
    fireEvent.click(screen.getByTitle('Toggle speaker notes'));
    expect(screen.getByText('Emphasise the beta blocker contraindication')).toBeTruthy();
  });

  it('lets the reader manually pick the notes text colour, defaulting to black, and remembers it', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-9b" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const notes = screen.getByTestId('pptx-notes-text');
    expect(notes.style.color).toBe('rgb(0, 0, 0)');

    const picker = screen.getByLabelText('Notes text colour') as HTMLInputElement;
    fireEvent.change(picker, { target: { value: '#ff0000' } });
    expect(screen.getByTestId('pptx-notes-text').style.color).toBe('rgb(255, 0, 0)');
    expect(localStorage.getItem('pharmatrack:pptx-notes-color')).toBe('#ff0000');
  });

  it('renders an embedded video as a playable <video> with controls and a poster, and keeps arrow keys for seeking instead of changing slides', async () => {
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const IMG_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
    const VIDEO_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video';

    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="Video 1"/>
        <p:cNvPicPr/>
        <p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="2743200"/></a:xfrm></p:spPr>
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
    mockFetchBlob((await zip.generateAsync({ type: 'blob' })) as Blob);

    render(<PptxViewer fileUrl="local:test-video" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const video = await waitFor(() => {
      const el = screen.getByTestId('pptx-stage').querySelector('video');
      expect(el).toBeTruthy();
      return el as HTMLVideoElement;
    });
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('poster')).toMatch(/^blob:/);
    expect(video.getAttribute('src')).toMatch(/^blob:/);

    // Arrow keys fired while the video itself has focus must seek the clip,
    // not flip to the next slide — the global slide-navigation shortcuts
    // defer to the browser's native video controls instead of fighting them.
    fireEvent.keyDown(video, { key: 'ArrowRight' });
    expect(pageInput().value).toBe('1');
  });

  it('falls back to the poster frame instead of a dead black box when a video codec is unsupported', async () => {
    // Regression test: Chromium cannot decode every historical PowerPoint
    // codec (notably some WMV variants), and some H.265 clips are
    // unsupported on Linux/WebKitGTK. An unplayable <video> firing `error`
    // must not leave the slide with a silent, broken player.
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const IMG_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
    const VIDEO_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video';

    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="Video 1"/>
        <p:cNvPicPr/>
        <p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="2743200"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}">
         <Relationship Id="rId2" Type="${IMG_REL}" Target="../media/poster1.png"/>
         <Relationship Id="rId3" Type="${VIDEO_REL}" Target="../media/clip1.wmv"/>
       </Relationships>`,
    );
    zip.file('ppt/media/poster1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    zip.file('ppt/media/clip1.wmv', new Uint8Array([48, 38, 178, 117]));
    mockFetchBlob((await zip.generateAsync({ type: 'blob' })) as Blob);

    render(<PptxViewer fileUrl="local:test-video-unplayable" />);
    const video = await waitFor(() => {
      const el = screen.getByTestId('pptx-stage').querySelector('video');
      expect(el).toBeTruthy();
      return el as HTMLVideoElement;
    });

    fireEvent.error(video);

    await waitFor(() => {
      expect(screen.getByTestId('pptx-stage').querySelector('video')).toBeNull();
      const poster = screen.getByTestId('pptx-stage').querySelector('img[alt*="codec"]');
      expect(poster).toBeTruthy();
      expect((poster as HTMLImageElement).src).toMatch(/^blob:/);
    });
  });

  it('shows an explicit placeholder instead of nothing when a video shape has neither a poster nor a resolvable clip', async () => {
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="Video 1"/>
        <p:cNvPicPr/>
        <p:nvPr><a:videoFile r:link="rId3"/></p:nvPr>
      </p:nvPicPr>
      <p:blipFill/>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="2743200"/></a:xfrm></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
    );
    // No rId3 relationship at all: neither the poster nor the clip resolves.
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${REL_NS}"></Relationships>`,
    );
    mockFetchBlob((await zip.generateAsync({ type: 'blob' })) as Blob);

    render(<PptxViewer fileUrl="local:test-video-unavailable" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));
    await waitFor(() => {
      expect(screen.getByTestId('pptx-stage').querySelector('video')).toBeNull();
      expect(screen.getByText(/video/i, { selector: '[aria-label="Embedded video unavailable"] span' })).toBeTruthy();
    });
  });

  it('enters fullscreen and exits with Escape', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-10" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const root = () => document.querySelector('[data-pptx-viewer]') as HTMLElement;
    expect(root().className).not.toContain('fixed');

    fireEvent.click(screen.getByTitle('Fullscreen presentation mode'));
    expect(root().className).toContain('fixed');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(root().className).not.toContain('fixed');
  });

  it('switches to "Fit to Screen" on entering the slide show, so the whole slide (and notes) always fits', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-10b" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    // Default reading-view zoom is "Fit Width".
    expect(screen.getByTitle('Zoom').textContent).toContain('Fit Width');

    fireEvent.click(screen.getByTitle('Fullscreen presentation mode'));
    expect(screen.getByTitle('Zoom').textContent).toContain('Fit to Screen');

    // Exiting the slide show does not fight the student's own zoom choice.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTitle('Zoom').textContent).toContain('Fit to Screen');
  });

  it('shows the error fallback with Download / View Extracted Text / Retry', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('boom'));
    render(
      <PptxViewer
        fileUrl="local:test-11"
        title="Broken deck"
        extractedText="Beta blockers reduce heart rate."
      />,
    );

    await screen.findByText('Unable to render this PowerPoint visually');
    expect(screen.getByText(/Your original presentation is safe/)).toBeTruthy();
    expect(screen.getByText('Download Original')).toBeTruthy();
    expect(screen.getByText('View Extracted Text')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();

    // Extracted text fallback shows the upload-time text.
    fireEvent.click(screen.getByText('View Extracted Text'));
    expect(screen.getByText(/Beta blockers reduce heart rate\./)).toBeTruthy();
    expect(screen.getByText('Download Original')).toBeTruthy();
  });

  it('keeps the original available from the menu and never blocks on a failed render', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('corrupt'));
    const { container } = render(<PptxViewer fileUrl="local:test-12" title="Corrupt.pptx" />);
    await screen.findByText('Unable to render this PowerPoint visually');
    // The file itself remains downloadable via the error card button.
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('treats a valid-but-empty presentation as unrenderable, not as a blank viewer', async () => {
    // A readable zip without any slides must not dead-end silently.
    mockFetchBlob(await buildDeck([]));
    render(<PptxViewer fileUrl="local:test-13" extractedText="Recovered lecture text" />);
    await screen.findByText('Unable to render this PowerPoint visually');
    expect(screen.getByText(/No slides were found in this file\./)).toBeTruthy();
    expect(screen.getByText('Download Original')).toBeTruthy();
    fireEvent.click(screen.getByText('View Extracted Text'));
    expect(screen.getByText('Recovered lecture text')).toBeTruthy();
  });

  it('closes the file info dialog with Escape and light-dismisses the zoom menu', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-14" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    // Zoom menu opens, then closes when clicking outside it.
    fireEvent.click(screen.getByTitle('Zoom'));
    expect(screen.getByText('Fit to Screen')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Fit to Screen')).toBeNull();

    // File info closes on Escape without leaving fullscreen handling behind.
    fireEvent.click(screen.getByTitle('More tools'));
    fireEvent.click(screen.getByText('File Info'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('always keeps the original presentation downloadable', async () => {
    mockFetchBlob(await buildDeck(DECK));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<PptxViewer fileUrl="local:test-16" title="Cardiovascular Pharmacology" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    fireEvent.click(screen.getByTitle('Download original file'));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // The saved file keeps a .pptx extension even when the title has none.
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('Cardiovascular Pharmacology.pptx');
    clickSpy.mockRestore();
  });

  it('exposes Download Original and the text fallback in the tools menu', async () => {
    mockFetchBlob(await buildDeck(DECK));
    render(<PptxViewer fileUrl="local:test-15" title="Lecture.pptx" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    fireEvent.click(screen.getByTitle('More tools'));
    expect(screen.getByText('First slide')).toBeTruthy();
    expect(screen.getByText('Last slide')).toBeTruthy();
    expect(screen.getByText('Download Original')).toBeTruthy();

    fireEvent.click(screen.getByText('View Extracted Text'));
    // Flat fallback lists every slide's text and can go back to slides. The
    // slide texts are read on demand (light XML pass), so they land a beat
    // after the mode switch.
    expect(screen.getByText('Back to Slides')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Intro body text')).toBeTruthy());
    expect(screen.getByText('List of side effects')).toBeTruthy();
    fireEvent.click(screen.getByText('Back to Slides'));
    expect(pageInput().value).toBe('1');
  });
});

/**
 * Real-PowerPoint rendering: the numbers below are the ones a natural
 * PowerPoint deck produces — 44pt centred titles from the master's
 * p:titleStyle, 32/28pt bulleted body text with marL indents, themed colours
 * and fonts, cropped/elliptically framed pictures, merged table cells and a
 * full-bleed background picture inherited from the master.
 */
describe('PptxViewer with real PowerPoint structure', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const openReal = async (opts = {}) => {
    mockFetchBlob(await buildPowerPointDeck(opts));
    render(<PptxViewer fileUrl="local:real-1" title="Cardio" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));
    return screen.getByTestId('pptx-stage');
  };

  const run = (root: HTMLElement, text: string) =>
    Array.from(root.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && el.textContent === text,
    ) as HTMLElement | undefined;

  it('renders master/layout style inheritance (sizes, alignment, fonts, bullets, indents)', async () => {
    const stage = await openReal();

    // 44pt centred title in the theme's major font.
    const title = run(stage, 'Cardiovascular Pharmacology')!;
    const titlePara = title.closest('[style*="font-size"]') as HTMLElement;
    expect(Math.round(parseFloat(titlePara.style.fontSize))).toBe(59); // 44pt
    expect(titlePara.style.textAlign).toBe('center');
    expect(title.style.fontFamily).toBe('Georgia');

    // 24pt subtitle from the layout's own lstStyle, theme minor font.
    const sub = run(stage, 'Lecture 1')!;
    const subPara = sub.closest('[style*="font-size"]') as HTMLElement;
    expect(Math.round(parseFloat(subPara.style.fontSize))).toBe(32); // 24pt
    expect(sub.style.fontFamily).toBe('Verdana');

    // Body placeholder: 32pt with the master's • bullet and marL indent.
    const body = run(stage, 'Blocks beta-1 receptors')!;
    const bodyPara = body.closest('[style*="font-size"]') as HTMLElement;
    expect(Math.round(parseFloat(bodyPara.style.fontSize))).toBe(43); // 32pt
    expect(bodyPara.style.marginLeft).toBe('36px'); // marL 342900 EMU
    const deeper = run(stage, 'Reduces heart rate')!;
    const deeperPara = deeper.closest('[style*="font-size"]') as HTMLElement;
    expect(Math.round(parseFloat(deeperPara.style.fontSize))).toBe(37); // 28pt
    expect(deeperPara.style.marginLeft).toBe('78px');
    expect(stage.textContent).toContain('•');
    expect(stage.textContent).toContain('–'); // lvl2 bullet from the real master
  });

  it('paints theme colours and clips cropped / elliptical pictures', async () => {
    const stage = await openReal();

    const accent = Array.from(stage.querySelectorAll('div')).find((d) =>
      (d.getAttribute('style') || '').includes('rgb(0, 166, 81)'),
    );
    expect(accent).toBeTruthy(); // theme accent1 through p:clrMap

    // The picture is cropped (a:srcRect) inside an elliptical frame
    // (prstGeom prst="ellipse"): an overflow box clips the stretched image.
    const img = stage.querySelector('img') as HTMLImageElement;
    const frame = img.parentElement as HTMLElement;
    expect(frame.className).toContain('overflow-hidden');
    expect(frame.style.borderRadius).toBe('50%');
    expect(frame.style.left).toBe('96px');
    // Kept region 65% × 70% of the source, stretched into the 384×288 frame.
    expect(img.style.width).toBe('590.7692307692307px');
    expect(img.style.left).toBe('-147.69230769230768px');
  });

  it('renders merged table cells with spans and no continuation cells', async () => {
    const stage = await openReal();
    const tds = Array.from(stage.querySelectorAll('td'));
    const cell = (text: string) => tds.find((td) => td.textContent === text)!;
    expect(cell('Class').getAttribute('colspan')).toBe('2');
    expect(cell('Atenolol').getAttribute('rowspan')).toBe('2');
    // 4 grid columns: row 1 has 3 tds (one spanning 2), row 2 has 4,
    // and the merged-away continuation cells are not rendered.
    expect(tds.length).toBe(3 + 4 + 3);
    expect(tds.some((td) => td.textContent === '')).toBe(false);
  });

  it('paints a background picture inherited from the master', async () => {
    const stage = await openReal({ masterBackground: 'picture' });
    const slideEl = stage.querySelector('div[style*="background-image"]') as HTMLElement;
    const css = slideEl.getAttribute('style') || '';
    expect(css).toContain('background-image: url("blob:');
    expect(css).toContain('background-size: cover');
  });
});

describe('PptxViewer — bullet rendering regressions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * The bullet separator must be a real non-breaking space. It was once the
   * bare JSX text `\u00A0`, which React renders as the six literal characters
   * "backslash u 0 0 A 0" after every bullet — the garbage prefix that made
   * every bulleted line on the user's lecture decks unreadable.
   */
  it('renders a Wingdings bullet as a clean glyph followed by a real NBSP', async () => {
    const slide = `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody>
        <a:lstStyle>
          <a:lvl1pPr marL="285750" indent="-285750">
            <a:buFont typeface="Wingdings"/>
            <a:buChar char="&#xF0B7;"/>
            <a:defRPr><a:latin typeface="Symbol"/></a:defRPr>
          </a:lvl1pPr>
        </a:lstStyle>
        <a:p><a:r><a:t>First run inherits the level</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slide);
    mockFetchBlob((await zip.generateAsync({ type: 'blob' })) as Blob);
    render(<PptxViewer fileUrl="local:bullets" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const stage = screen.getByTestId('pptx-stage');
    // Nothing anywhere renders the literal escape sequence.
    const allText = Array.from(stage.querySelectorAll('*')).map((el) => el.textContent || '');
    for (const t of allText) expect(t).not.toContain('\\u00A0');

    // The bullet span holds exactly: the REAL Wingdings glyph at 0xB7 (a
    // clock face — verified against the font's own glyph table) + NBSP.
    const bulletSpan = stage.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(bulletSpan).toBeTruthy();
    expect(bulletSpan.textContent).toBe(String.fromCodePoint(0x1f550) + '\u00A0');

    // The level's Symbol font (the bullet's font) never reaches text runs.
    const runSpan = Array.from(stage.querySelectorAll('span')).find(
      (el) => el.textContent === 'First run inherits the level',
    ) as HTMLElement;
    expect(runSpan).toBeTruthy();
    expect((runSpan.style.fontFamily || '').toLowerCase()).not.toContain('symbol');
  });

  /**
   * Round 3, the user's exact deck: PowerPoint's bullet gallery authors
   * square bullets as buChar "§" with buFont Wingdings — the section sign is
   * a CODE POINT into Wingdings' glyph table, not a character to draw. The
   * renderer must show the glyph PowerPoint shows (the small filled square),
   * never a literal "§".
   */
  it('renders a Wingdings "§" bullet as the small square PowerPoint draws', async () => {
    const slide = `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody>
        <a:lstStyle>
          <a:lvl1pPr marL="285750" indent="-285750">
            <a:buFont typeface="Wingdings"/>
            <a:buChar char="\u00A7"/>
          </a:lvl1pPr>
          <a:lvl2pPr marL="571500" indent="-285750">
            <a:buFont typeface="Symbol"/>
            <a:buChar char="\u00B7"/>
          </a:lvl2pPr>
        </a:lstStyle>
        <a:p><a:r><a:t>Level one</a:t></a:r></a:p>
        <a:p><a:pPr lvl="1"/><a:r><a:t>Level two</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slide);
    mockFetchBlob((await zip.generateAsync({ type: 'blob' })) as Blob);
    render(<PptxViewer fileUrl="local:square" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const stage = screen.getByTestId('pptx-stage');
    const bullets = Array.from(stage.querySelectorAll('span[aria-hidden="true"]'))
      .map((el) => el.textContent || '');
    // Wingdings 0xA7 = the small filled square; Symbol 0xB7 = the round bullet.
    expect(bullets).toContain('\u25AA\u00A0');
    expect(bullets).toContain('\u2022\u00A0');
    // And never the raw code-point characters.
    expect(bullets.join('')).not.toContain('\u00A7');
  });

  /**
   * Round 3, the selection ask: slide text must be selectable and the cursor
   * must signal it — an I-beam over text shapes and table cells (matching
   * PowerPoint), the normal arrow elsewhere.
   */
  it('makes text shapes selectable with a text cursor', async () => {
    const slide = `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody>
        <a:p><a:r><a:t>Selectable lecture text</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slide);
    mockFetchBlob((await zip.generateAsync({ type: 'blob' })) as Blob);
    render(<PptxViewer fileUrl="local:cursor" />);
    await waitFor(() => expect(pageInput().value).toBe('1'));

    const stage = screen.getByTestId('pptx-stage');
    const shape = stage.querySelector('[data-shape="text"]') as HTMLElement;
    expect(shape).toBeTruthy();
    expect(shape.style.cursor).toBe('text');
    expect(shape.style.userSelect).toBe('text');
    // The text itself is present as real DOM text (selectable, copyable).
    expect(stage.textContent).toContain('Selectable lecture text');
  });
});
