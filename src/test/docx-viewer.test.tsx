/**
 * DOCX viewer — acceptance tests.
 *
 * The viewer must render the ORIGINAL .docx bytes in the browser with
 * docx-preview. docx-preview needs a real browser DOM (it reads computed
 * styles and page geometry that jsdom does not provide), so these tests mock
 * `renderAsync` with a faithful stand-in: it unzips the REAL bytes the viewer
 * fetched, throws for containers without word/document.xml exactly like the
 * real engine, and writes the paragraphs into the body container the viewer
 * passes. That pins everything the viewer is responsible for — wiring, zoom,
 * Download Original, selection, and honest failure — while layout fidelity
 * remains docx-preview's own contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JSZip from 'jszip';
import { renderAsync } from 'docx-preview';
import DocxViewer from '../components/DocxViewer';

vi.mock('docx-preview', () => ({
  /**
   * Stand-in for docx-preview.renderAsync with the same observable contract:
   *   - rejects when the blob is not a docx package (no word/document.xml);
   *   - writes the document's paragraphs into the body container;
   *   - writes page styles into the style container, never <head>.
   */
  renderAsync: vi.fn(async (data: Blob, container: HTMLElement, stylesContainer?: HTMLElement) => {
    const zip = await JSZip.loadAsync(data);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('Not a valid docx package');
    const xml = await entry.async('string');
    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
    for (const text of texts) {
      const p = document.createElement('p');
      p.textContent = text;
      container.appendChild(p);
    }
    if (stylesContainer) {
      const style = document.createElement('style');
      style.textContent = '/* docx-preview page styles */';
      stylesContainer.appendChild(style);
    }
    return undefined as never;
  }),
}));

const wordXml = (paragraphs: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}
  </w:body>
</w:document>`;

const bytesForBlob = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function makeDocxBytes(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file('word/document.xml', wordXml(paragraphs));
  return zip.generateAsync({ type: 'uint8array' });
}

async function makeDocxBlob(paragraphs: string[]): Promise<Blob> {
  const bytes = await makeDocxBytes(paragraphs);
  return new Blob([bytesForBlob(bytes)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

const stubFetch = (body: Blob) => {
  const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => body }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DocxViewer — rendering the original file', () => {
  it('renders a real docx and shows its paragraphs', async () => {
    stubFetch(
      await makeDocxBlob([
        'Parasympathetic anatomy',
        'The vagus nerve carries preganglionic fibres.',
      ]),
    );

    render(<DocxViewer fileUrl="blob:lecture" title="Autonomic Lecture" />);

    // Loading state is honest…
    expect(screen.getByTestId('docx-viewer-loading')).toBeTruthy();

    // …then the document appears, laid out from the original bytes.
    await waitFor(() => {
      expect(screen.queryByTestId('docx-viewer-loading')).toBeNull();
    });
    const rendered = screen.getByTestId('docx-viewer-body').textContent ?? '';
    expect(rendered).toContain('Parasympathetic anatomy');
    expect(rendered).toContain('The vagus nerve carries preganglionic fibres.');
    expect(screen.queryByTestId('docx-viewer-error')).toBeNull();
  });

  it('identifies itself as the Word engine with a Word badge', async () => {
    stubFetch(await makeDocxBlob(['Badge check']));
    render(<DocxViewer fileUrl="blob:badge" />);
    await waitFor(() => {
      expect(screen.queryByTestId('docx-viewer-loading')).toBeNull();
    });
    expect(screen.getByText('Word')).toBeTruthy();
  });

  it('hands renderAsync the fetched blob, its body container, and a style container', async () => {
    const blob = await makeDocxBlob(['wiring check']);
    stubFetch(blob);

    render(<DocxViewer fileUrl="blob:wiring" />);
    await waitFor(() => {
      expect(vi.mocked(renderAsync)).toHaveBeenCalled();
    });

    const call = vi.mocked(renderAsync).mock.calls[0];
    expect(call[0]).toBe(blob);
    expect(call[1]).toBe(screen.getByTestId('docx-viewer-body'));
    // Page styles land in OUR container, never <head> — nothing leaks
    // between documents.
    expect(call[2]).toBeTruthy();
    expect(call[2]).not.toBe(document.head);
    expect(call[2]!.querySelector('style')).toBeTruthy();
  });
});

describe('DocxViewer — zoom', () => {
  it('steps zoom between 75% and 150% with the buttons', async () => {
    stubFetch(await makeDocxBlob(['zoom']));
    render(<DocxViewer fileUrl="blob:zoom" />);

    await waitFor(() => {
      expect(screen.queryByTestId('docx-viewer-loading')).toBeNull();
    });

    expect(screen.getByText('100%')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(screen.getByText('125%')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(screen.getByText('150%')).toBeTruthy();
    // Clamped at the top…
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(screen.getByText('150%')).toBeTruthy();
    // …and at the bottom.
    fireEvent.click(screen.getByTitle('Zoom out'));
    fireEvent.click(screen.getByTitle('Zoom out'));
    fireEvent.click(screen.getByTitle('Zoom out'));
    expect(screen.getByText('75%')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Zoom out'));
    expect(screen.getByText('75%')).toBeTruthy();
  });
});

describe('DocxViewer — Download Original', () => {
  it('offers the original file download and keeps the title extension', async () => {
    stubFetch(await makeDocxBlob(['download']));
    render(<DocxViewer fileUrl="blob:doc" title="Lecture 3 — Autonomics" />);

    await waitFor(() => {
      expect(screen.queryByTestId('docx-viewer-loading')).toBeNull();
    });

    const clicks: Array<[string, string | null]> = [];
    const anchor = document.createElement('a');
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'a' ? anchor : realCreate(tag),
    );
    anchor.click = () => clicks.push([anchor.getAttribute('href') ?? '', anchor.getAttribute('download')]);

    fireEvent.click(screen.getByTitle('Download original file'));

    expect(clicks).toHaveLength(1);
    expect(clicks[0][0]).toBe('blob:doc');
    expect(clicks[0][1]).toBe('Lecture 3 — Autonomics.docx');
  });
});

describe('DocxViewer — failure is honest, the file survives', () => {
  it('shows the error card with Download Original when the bytes are not a docx', async () => {
    // A real ZIP container that is NOT a word processing document — the
    // stand-in (like the real engine) refuses it.
    const zip = new JSZip();
    zip.file('hello.txt', 'not a docx');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    stubFetch(new Blob([bytesForBlob(bytes)]));

    render(<DocxViewer fileUrl="blob:corrupt" title="broken.docx" />);

    const card = await screen.findByTestId('docx-viewer-error');
    expect(card.textContent).toContain('Unable to render this Word document');
    // The original is still one click away — never a dead end.
    expect(screen.getByRole('button', { name: /Download Original/i })).toBeTruthy();
    expect(screen.queryByTestId('docx-viewer-loading')).toBeNull();
  });

  it('reports a fetch failure the same way instead of a blank pane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network gone'); }));

    render(<DocxViewer fileUrl="blob:gone" title="gone.docx" />);
    expect(await screen.findByTestId('docx-viewer-error')).toBeTruthy();
  });

  it('re-renders when the fileUrl changes and clears the previous document', async () => {
    const a = await makeDocxBlob(['First document']);
    const b = await makeDocxBlob(['Second document']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        blob: async () => (url.includes('two') ? b : a),
      }) as unknown as Response),
    );

    const { rerender } = render(<DocxViewer fileUrl="blob:one" title="one" />);
    await waitFor(() => {
      expect(screen.getByTestId('docx-viewer-body').textContent).toContain('First document');
    });

    rerender(<DocxViewer fileUrl="blob:two" title="two" />);
    await waitFor(() => {
      expect(screen.getByTestId('docx-viewer-body').textContent).toContain('Second document');
    });
    expect(screen.getByTestId('docx-viewer-body').textContent).not.toContain('First document');
  });
});
