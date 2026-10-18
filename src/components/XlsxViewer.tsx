import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Download, FileSpreadsheet, Loader2, Search, X,
} from 'lucide-react';

/**
 * Spreadsheet viewer — renders the ORIGINAL workbook with a real spreadsheet
 * surface: worksheets as tabs, rows and columns with their stored widths and
 * heights, merged cells, and the *displayed* value of every cell (formatted
 * numbers and dates; a formula's result is shown, with the formula itself in
 * the cell tooltip).
 *
 * Parsing is SheetJS Community Edition (@e965/xlsx, Apache-2.0) — offline,
 * in the same WebView as the app, on every platform. Binary .xls is parsed
 * too (same engine); charts, frozen panes, cell colours and conditional
 * formatting are NOT rendered — recorded limitations, not silent claims.
 * The original file is always one click away (Download Original).
 */

export interface XlsxViewerProps {
  fileUrl: string;
  title?: string;
  /** Reports the visible sheet's text (page = sheet number) for AI context. */
  onSheetChange?: (sheet: number, total: number, text: string) => void;
}

interface Cell {
  /** Displayed value (formatted when the workbook carries a format). */
  text: string;
  /** Formula source, when the cell is a formula. */
  formula?: string;
}

interface SheetModel {
  name: string;
  rows: Cell[][];
  colWidths: (number | undefined)[];
  rowHeights: (number | undefined)[];
  /** 'r,c' of merge anchors; spanned cells are in `covered`. */
  merges: Map<string, { rowspan: number; colspan: number }>;
  covered: Set<string>;
}

const colName = (n: number): string => {
  let s = '';
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode((x % 26) + 65) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
};

/** Char-width column measure → px (approximate, like desktop apps). */
const colPx = (wch: number | undefined): number | undefined =>
  wch && Number.isFinite(wch) ? Math.max(24, Math.round(wch * 7.5 + 8)) : undefined;
const rowPx = (hpt: number | undefined): number | undefined =>
  hpt && Number.isFinite(hpt) ? Math.max(18, Math.round(hpt * 1.333)) : undefined;

const cellText = (cell: unknown): string => {
  if (cell == null) return '';
  const c = cell as { w?: string | number; v?: unknown; t?: string; f?: string };
  if (c.w != null) return String(c.w);
  if (c.v == null) return '';
  if (c.t === 'b') return c.v ? 'TRUE' : 'FALSE';
  if (c.v instanceof Date) return c.v.toLocaleDateString();
  return String(c.v);
};

const buildSheet = (
  XLSX: typeof import('@e965/xlsx'),
  ws: import('@e965/xlsx').WorkSheet,
  name: string,
): SheetModel => {
  const ref = ws['!ref'] ?? 'A1';
  const range = XLSX.utils.decode_range(ref);
  const rows: Cell[][] = [];
  const colWidths: (number | undefined)[] = [];
  const rowHeights: (number | undefined)[] = [];
  const merges = new Map<string, { rowspan: number; colspan: number }>();
  const covered = new Set<string>();

  for (const m of ws['!merges'] ?? []) {
    const anchor = `${m.s.r},${m.s.c}`;
    merges.set(anchor, { rowspan: m.e.r - m.s.r + 1, colspan: m.e.c - m.s.c + 1 });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) covered.add(`${r},${c}`);
      }
    }
  }

  const rawCols = ws['!cols'] ?? [];
  for (let c = 0; c <= range.e.c; c++) colWidths.push(colPx(rawCols[c]?.wch));
  const rawRows = ws['!rows'] ?? [];
  for (let r = 0; r <= range.e.r; r++) rowHeights.push(rowPx(rawRows[r]?.hpt));

  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const raw = ws[addr] as { f?: string } | undefined;
      row.push({ text: cellText(raw), formula: raw?.f ? `=${raw.f}` : undefined });
    }
    rows.push(row);
  }

  return { name, rows, colWidths, rowHeights, merges, covered };
};

const XlsxViewer: React.FC<XlsxViewerProps> = ({ fileUrl, title, onSheetChange }) => {
  const [sheets, setSheets] = useState<SheetModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [showFind, setShowFind] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSheets(null);
    setActive(0);
    setQuery('');

    (async () => {
      try {
        const res = await fetch(fileUrl);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const XLSX = await import('@e965/xlsx');
        const wb = XLSX.read(bytes, { type: 'array' });
        const models = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          return ws ? buildSheet(XLSX, ws, name) : null;
        }).filter((s): s is SheetModel => !!s);
        if (cancelled) return;
        if (!models.length) {
          setError('No worksheets were found in this workbook.');
        } else {
          setSheets(models);
        }
        setLoading(false);
      } catch (err) {
        console.error('Spreadsheet parse failed:', err);
        if (!cancelled) {
          setError('This spreadsheet could not be read. It may be corrupted or password-protected.');
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fileUrl]);

  const sheet = sheets?.[active];

  useEffect(() => {
    if (!sheet || !sheets) return;
    // The visible sheet only — the AI context never receives the whole
    // workbook. First ~40 non-empty rows keep the payload bounded.
    const text = sheet.rows
      .map((row) => row.map((c) => c.text).filter(Boolean).join('\t'))
      .filter((line) => line.trim())
      .slice(0, 40)
      .join('\n');
    onSheetChange?.(active + 1, sheets.length, text);
  }, [sheet, sheets, active, onSheetChange]);

  const download = useCallback(() => {
    const base = title?.trim() || 'spreadsheet';
    const hasExt = /\.(xlsx|xlsm|xls|csv)$/i.test(base);
    const name = hasExt ? base : `${base}.xlsx`;
    const a = document.createElement('a');
    a.href = fileUrl;
    a.download = name;
    a.click();
  }, [fileUrl, title]);

  /** Cells matching the find query get a highlight ring. */
  const matchCells = useMemo(() => {
    const q = query.trim().toLowerCase();
    const set = new Set<string>();
    if (!q || !sheet) return set;
    sheet.rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell.text && cell.text.toLowerCase().includes(q)) set.add(`${r},${c}`);
      });
    });
    return set;
  }, [query, sheet]);

  const iconBtn = 'rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-40';

  if (!loading && error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-100 p-4" data-testid="xlsx-viewer-error">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
            <AlertTriangle className="h-7 w-7 text-red-500" />
          </div>
          <h3 className="text-lg font-bold text-gray-900">Unable to open this spreadsheet</h3>
          <p className="mt-2 text-sm text-gray-500">
            Parsing failed. Your original file is safe. {error}
          </p>
          <button
            onClick={download}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#2D6A4F] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#24523e] transition-colors"
          >
            <Download className="h-4 w-4" /> Download Original
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-slate-200">
      {/* toolbar */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-slate-300 bg-slate-100 px-2 py-1.5 shadow-sm">
        <span className="mr-1 flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] font-black uppercase tracking-wider text-emerald-700 shadow-sm">
          <FileSpreadsheet className="h-3.5 w-3.5" /> Spreadsheet
        </span>
        <button
          onClick={() => setShowFind((s) => !s)}
          title="Find in this sheet"
          className={`${iconBtn} ${showFind ? 'bg-[#2D6A4F]/10 text-[#2D6A4F]' : ''}`}
        >
          <Search className="h-4 w-4" />
        </button>
        {showFind ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Find in sheet…"
              data-testid="xlsx-find-input"
              className="w-44 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[#2D6A4F]/20"
            />
            {query.trim() ? (
              <span className="text-xs font-bold text-slate-500">{matchCells.size} cell(s)</span>
            ) : null}
            <button onClick={() => { setShowFind(false); setQuery(''); }} title="Close find" className={iconBtn}>
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        <div className="ml-auto" />
        <button onClick={download} title="Download original file" className={iconBtn}>
          <Download className="h-4 w-4" />
        </button>
      </div>

      {/* sheet tabs */}
      {sheets && sheets.length > 1 ? (
        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-300 bg-white px-2 py-1">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActive(i)}
              data-testid={`xlsx-sheet-tab-${i}`}
              className={`shrink-0 rounded-t-md border-b-2 px-3 py-1 text-xs font-bold transition-colors ${
                i === active
                  ? 'border-[#2D6A4F] bg-[#2D6A4F]/5 text-[#2D6A4F]'
                  : 'border-transparent text-slate-500 hover:bg-slate-100'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}

      {/* grid */}
      <div className="xlsx-viewer-scroll flex-1 overflow-auto p-4" data-testid="xlsx-viewer-scroll">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm font-bold text-slate-400" data-testid="xlsx-viewer-loading">
            <Loader2 className="h-5 w-5 animate-spin" /> Reading workbook…
          </div>
        ) : null}
        {sheet ? (
          <div className="mx-auto w-fit overflow-x-auto rounded-lg border border-slate-300 bg-white shadow-xl">
            <table className="border-collapse text-[13px]" data-testid="xlsx-grid">
              <colgroup>
                <col style={{ width: 44 }} />
                {sheet.colWidths.map((w, i) => (
                  <col key={i} style={w ? { width: w } : undefined} />
                ))}
              </colgroup>
              <tbody>
                <tr className="bg-slate-100 text-slate-500">
                  <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-1 text-[10px] font-black" />
                  {sheet.colWidths.map((_, c) => (
                    <th key={c} className="border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase">
                      {colName(c)}
                    </th>
                  ))}
                </tr>
                {sheet.rows.map((row, r) => (
                  <tr key={r} style={sheet.rowHeights[r] ? { height: sheet.rowHeights[r] } : undefined}>
                    <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-1 text-center text-[10px] font-black text-slate-400">
                      {r + 1}
                    </th>
                    {row.map((cell, c) => {
                      const key = `${r},${c}`;
                      if (sheet.covered.has(key)) return <td key={c} className="border border-slate-200" />;
                      const merge = sheet.merges.get(key);
                      const isMatch = matchCells.has(key);
                      return (
                        <td
                          key={c}
                          rowSpan={merge?.rowspan}
                          colSpan={merge?.colspan}
                          title={cell.formula ?? undefined}
                          data-testid={`xlsx-cell-${r}-${c}`}
                          className={`whitespace-nowrap border border-slate-200 px-2 py-0.5 text-slate-800 ${
                            isMatch ? 'bg-amber-100 font-bold ring-1 ring-amber-400' : ''
                          } ${typeof cell.text === 'string' && /^[0-9.,()%\s-]+$/.test(cell.text) ? 'text-right tabular-nums' : ''}`}
                        >
                          {cell.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {sheet && !sheet.rows.length ? (
          <p className="py-16 text-center text-sm font-bold text-slate-400">This sheet is empty.</p>
        ) : null}
      </div>
    </div>
  );
};

export default XlsxViewer;
