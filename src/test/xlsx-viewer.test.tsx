/**
 * Spreadsheet viewer — acceptance tests.
 *
 * The workbooks here are REAL files, generated in the test with the same
 * SheetJS build the viewer uses (@e965/xlsx), then served through a stubbed
 * fetch. The viewer parses the original bytes exactly as it will parse a
 * student's upload: values, formulas (shown result, formula in the tooltip),
 * merged cells, sheet tabs, find, and the bounded onSheetChange context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import XlsxViewer from '../components/XlsxViewer';
import { readBlobArrayBuffer } from '../utils/fileGuard';

type XLSXModule = typeof import('@e965/xlsx');

const bytesForBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function buildDoseWorkbook(): Promise<Uint8Array> {
  const XLSX: XLSXModule = await import('@e965/xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Drug', 'Dose (mg)', 'Route'],
    ['Paracetamol', 500, 'PO'],
    ['Amoxicillin', 250, 'PO'],
    ['Total', null, ''],
  ]);
  // A formula cell: SheetJS keeps the formula and the cached result; the
  // viewer must show the RESULT and expose the formula in the tooltip.
  ws['B4'] = { t: 'n', f: 'B2+B3', v: 750 } as never;
  // A merged header across A1:B1.
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  ws['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Doses');

  const notes = XLSX.utils.aoa_to_sheet([['Note'], ['Give with food.']]);
  XLSX.utils.book_append_sheet(wb, notes, 'Notes');

  // 50 rows — onSheetChange must bound its context to the first 40.
  const long = XLSX.utils.aoa_to_sheet(
    Array.from({ length: 50 }, (_, i) => [`ROW${i + 1}`]),
  );
  XLSX.utils.book_append_sheet(wb, long, 'Long');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

async function buildCsvBytes(): Promise<Uint8Array> {
  const XLSX: XLSXModule = await import('@e965/xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['name', 'score'], ['Ama', 91]]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const text = XLSX.write(wb, { type: 'string', bookType: 'csv' }) as string;
  return new TextEncoder().encode(text);
}

const stubFetchBytes = (bytes: Uint8Array) => {
  const buffer = bytesForBuffer(bytes);
  const fetchMock = vi.fn(
    async () => ({ ok: true, arrayBuffer: async () => buffer }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('XlsxViewer — rendering the original workbook', () => {
  it('shows every cell value from the parsed original bytes', async () => {
    stubFetchBytes(await buildDoseWorkbook());

    render(<XlsxViewer fileUrl="blob:doses" title="Dosage Chart" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
    });
    expect(screen.getByTestId('xlsx-cell-1-0').textContent).toBe('Paracetamol');
    expect(screen.getByTestId('xlsx-cell-1-1').textContent).toBe('500');
    expect(screen.getByTestId('xlsx-cell-2-0').textContent).toBe('Amoxicillin');
    // Column headers A..C are labelled like a spreadsheet.
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('shows a formula cell’s result and exposes the formula in its tooltip', async () => {
    stubFetchBytes(await buildDoseWorkbook());
    render(<XlsxViewer fileUrl="blob:formulas" title="f" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
    });
    const cell = screen.getByTestId('xlsx-cell-3-1');
    expect(cell.textContent).toBe('750');
    expect(cell.getAttribute('title')).toBe('=B2+B3');
  });

  it('renders merged cells as a single spanning cell', async () => {
    stubFetchBytes(await buildDoseWorkbook());
    render(<XlsxViewer fileUrl="blob:merges" title="m" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
    });
    const anchor = screen.getByTestId('xlsx-cell-0-0');
    expect(anchor.getAttribute('colspan')).toBe('2');
    const row = anchor.closest('tr')!;
    const tds = row.querySelectorAll('td');
    // Anchor (spanning 2) + covered cell (rendered empty) + Route.
    expect(tds).toHaveLength(3);
    expect(tds[1].textContent).toBe('');
  });

  it('parses CSV originals with the same engine', async () => {
    stubFetchBytes(await buildCsvBytes());
    render(<XlsxViewer fileUrl="blob:csv" title="scores.csv" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
    });
    expect(screen.getByTestId('xlsx-cell-0-0').textContent).toBe('name');
    expect(screen.getByTestId('xlsx-cell-1-1').textContent).toBe('91');
    expect(screen.queryByTestId('xlsx-viewer-error')).toBeNull();
  });
});

describe('XlsxViewer — sheet tabs and AI context', () => {
  it('offers every worksheet as a tab and switches on click', async () => {
    stubFetchBytes(await buildDoseWorkbook());
    render(<XlsxViewer fileUrl="blob:tabs" title="t" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
    });
    expect(screen.getByTestId('xlsx-sheet-tab-0').textContent).toBe('Doses');
    expect(screen.getByTestId('xlsx-sheet-tab-1').textContent).toBe('Notes');
    expect(screen.getByTestId('xlsx-sheet-tab-2').textContent).toBe('Long');

    fireEvent.click(screen.getByTestId('xlsx-sheet-tab-1'));
    await waitFor(() => {
      expect(screen.getByTestId('xlsx-cell-1-0').textContent).toBe('Give with food.');
    });
  });

  it('reports the visible sheet to onSheetChange, bounded to 40 rows', async () => {
    stubFetchBytes(await buildDoseWorkbook());
    const onSheetChange = vi.fn();
    render(<XlsxViewer fileUrl="blob:context" title="t" onSheetChange={onSheetChange} />);

    // Initial sheet: 1 of 3, its own text.
    await waitFor(() => {
      expect(onSheetChange).toHaveBeenCalledWith(
        1,
        3,
        expect.stringContaining('Paracetamol'),
      );
    });

    // Switch to the 50-row sheet: context carries sheet 3 of 3 and only the
    // first 40 rows.
    fireEvent.click(screen.getByTestId('xlsx-sheet-tab-2'));
    await waitFor(() => {
      expect(onSheetChange).toHaveBeenCalledWith(
        3,
        3,
        expect.stringContaining('ROW40'),
      );
    });
    const thirdCall = onSheetChange.mock.calls.find((c) => c[0] === 3)!;
    const text = thirdCall[2] as string;
    expect(text.split('\n').length).toBeLessThanOrEqual(40);
    expect(text).not.toContain('ROW50');
  });
});

describe('XlsxViewer — find in sheet', () => {
  it('highlights matching cells and shows the match count', async () => {
    stubFetchBytes(await buildDoseWorkbook());
    render(<XlsxViewer fileUrl="blob:find" title="t" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
    });

    fireEvent.click(screen.getByTitle('Find in this sheet'));
    const input = screen.getByTestId('xlsx-find-input');
    fireEvent.change(input, { target: { value: 'paracetamol' } });

    await waitFor(() => {
      expect(screen.getByText('1 cell(s)')).toBeTruthy();
    });
    const cell = screen.getByTestId('xlsx-cell-1-0');
    expect(cell.className).toContain('bg-amber-100');

    // Closing find clears the query and the highlights.
    fireEvent.click(screen.getByTitle('Close find'));
    expect(screen.queryByTestId('xlsx-find-input')).toBeNull();
    expect(screen.getByTestId('xlsx-cell-1-0').className).not.toContain('bg-amber-100');
  });
});

describe('XlsxViewer — Download Original', () => {
  it('downloads the original file, keeping an existing extension', async () => {
    stubFetchBytes(await buildDoseWorkbook());
    render(<XlsxViewer fileUrl="blob:dl" title="scores.csv" />);

    await waitFor(() => {
      expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
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
    expect(clicks[0][0]).toBe('blob:dl');
    // .csv stays .csv — the download is the ORIGINAL, not a re-export.
    expect(clicks[0][1]).toBe('scores.csv');
  });
});

describe('XlsxViewer — failure is honest, the file survives', () => {
  it('shows the error card with Download Original for undecodable bytes', async () => {
    // A broken ZIP: starts like an xlsx container but cannot be opened.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff]);
    stubFetchBytes(bytes);

    render(<XlsxViewer fileUrl="blob:corrupt" title="corrupt.xlsx" />);

    const card = await screen.findByTestId('xlsx-viewer-error');
    expect(card.textContent).toContain('Unable to open this spreadsheet');
    expect(screen.getByRole('button', { name: /Download Original/i })).toBeTruthy();
    expect(screen.queryByTestId('xlsx-viewer-loading')).toBeNull();
  });

  it('reports a fetch failure the same way instead of a blank pane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network gone'); }));

    render(<XlsxViewer fileUrl="blob:gone" title="gone.xlsx" />);
    expect(await screen.findByTestId('xlsx-viewer-error')).toBeTruthy();
  });
});
