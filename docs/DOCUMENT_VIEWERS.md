# Document viewers — engine reference

How study materials are opened, rendered, searched and exported. This document
is the contract the code in `src/documents/registry.ts`, `src/utils/extractText.ts`
and `src/components/*Viewer.tsx` implements.

## The contract

1. **A supported document opens its ORIGINAL file.** The bytes the user
   uploaded are the bytes that are stored, the bytes that are rendered and the
   bytes that are downloaded. Nothing is converted, re-encoded or reconstructed
   at upload time. (Before this engine, PPTX decks were rebuilt into
   reconstructed PDFs at upload and the originals were discarded.)
2. **Viewing never waits on extraction.** Text extraction, OCR and AI indexing
   are best-effort side services (`src/utils/extractText.ts`). A file whose
   text cannot be read still uploads, still opens, still downloads — the
   material is simply marked "no readable text".
3. **Routing is decided by the material's real kind**, resolved as
   *bytes sniffed at open time* → *stored `materialKind`* → *original filename
   extension* → *legacy `fileType` inference*. A renamed file still opens
   correctly; records created years ago keep opening unchanged; no stored data
   is rewritten to migrate.
4. **An unsupported format is an explanation, not a blank screen.** The
   registry returns an honest card naming what is missing and a
   **Download Original** button. Legacy binary `.ppt` and `.doc` land here.
5. **PDF export is an explicit action in the PPTX viewer** ("Export as PDF"),
   never a prerequisite for opening and never run at upload.

## Architecture

```
upload (FileUploader)
   │  original bytes ──────────────► storage.saveFile (IndexedDB)
   │  best-effort text ──► extractText.ts (search index / AI context only)
   ▼
open (SlideReader / ArchiveViewer / StudyMaterials)
   │  bytes sniff (first 4 KB)
   ▼
documents/registry.ts ── routeMaterial ──► { viewer, engine, limitations }
   │
   ├─ pdf   ► PdfViewer            (PDF.js, bundled worker — no CDN)
   ├─ pptx  ► PptxViewer           (native renderer, lazy slide parse)
   ├─ docx  ► DocxViewer           (docx-preview)
   ├─ xlsx  ► XlsxViewer           (SheetJS CE; .xls and .csv included)
   ├─ image ► browser decoder
   ├─ text  ► plain text
   └─ else  ► unsupported card + Download Original
```

The PPTX viewer opens a deck by parsing `presentation.xml` only, then parses
each slide on demand with a bounded cache (`openPptxDeck`). Find and AI-context
text come from a separate text-only pass (`deck.textIndex()`) that never
touches layouts, masters or media.

## Capability table

| Format | Viewer | Engine | Honest limitations |
| ------ | ------ | ------ | ------------------ |
| `.pdf` | PdfViewer | PDF.js (bundled) | Scanned pages without a text layer are images; run OCR at upload to make them searchable. |
| `.pptx`, `.pptm` | PptxViewer | Native PPTX renderer (`pptxRenderer.ts`) | Animations, transitions, SmartArt and charts render as static shapes/frames; hidden slides are skipped like PowerPoint's slideshow. `.pptm` macros are never executed. |
| `.docx` | DocxViewer | docx-preview | Tracked-change balloons, macros and embedded OLE objects are not drawn. |
| `.xlsx`, `.xlsm`, `.xls`, `.csv` | XlsxViewer | SheetJS CE (`@e965/xlsx`) | Charts, cell colours, conditional formatting and frozen panes are not drawn; formula cells show their stored result with the formula in the tooltip. |
| `.jpg`, `.png`, … | image viewer | browser decoder | — |
| `.txt`, `.md` | text viewer | plain text | — |
| `.ppt`, `.doc` | unsupported card | — | Legacy binary formats are not rendered in-app. Download Original opens them in the OS handler (PowerPoint, LibreOffice, an Android office suite). |

Presentations that were converted to PDF *before* this engine existed are
stored as PDFs; their bytes say `pdf`, so they keep opening in the PDF viewer.
Nothing rewrites them.

## Platform capability matrix

Every viewer is bundled JavaScript that runs in the platform's WebView, so the
capability table above is identical on every target and works fully offline:

| Platform | WebView | Engine differences vs the table |
| -------- | ------- | ------------------------------- |
| Windows / Linux (Tauri) | Tauri WebView (WebView2 / WebKitGTK) | none |
| Android (Tauri app) | Chromium WebView | none |
| iPad / iPhone (PWA) | Safari | none |
| Desktop browsers (PWA) | Chromium / Firefox / Safari | none |

Deliberately NOT used: the platform's native PDF stack (Android's PDFium
renderers, desktop PDF applications). Delegating would make behaviour differ
per platform and require handing the file to an external process; the bundled
engines guarantee the same rendering and the same limits everywhere. The
operating system's handlers remain the escape hatch for what the app does not
render at all (`.ppt`, `.doc`) — via Download Original.

## The extraction service (search / AI only)

`src/utils/extractText.ts` — never on the opening path:

| Function | Used for | Failure behaviour |
| -------- | -------- | ----------------- |
| `extractPdfText` | PDF text layer | `{ failed: true, text: '' }` — never throws |
| `extractPptxSlideTexts` | slide + notes text | same |
| `extractDocxText` (mammoth) | DOCX paragraphs | same |
| `extractSpreadsheetText` | sheet cells | same |

Mammoth (BSD-2-Clause) is extraction-only: it is never the visual document
path. OCR remains opt-in per upload.

## Licence audit

All engines ship in the app bundle; none loads from a CDN; none sends bytes
anywhere.

| Package | Version | Licence | Role |
| ------- | ------- | ------- | ---- |
| `pdfjs-dist` | 3.11.174 | Apache-2.0 | PDF viewer + text extraction |
| `docx-preview` | 0.4.1 | Apache-2.0 | DOCX visual rendering |
| `@e965/xlsx` (SheetJS CE) | 0.20.3 | Apache-2.0 | spreadsheet parsing (community fork with the CVE-2024-22363 / prototype-pollution fixes; npm `xlsx` is NOT used) |
| `mammoth` | 1.12.0 | BSD-2-Clause | DOCX → text (extraction only) |
| `jszip` | 3.10.1 | MIT OR GPL-3.0 (used under MIT) | ZIP container access |
| `pdf-lib` | 1.17.1 | MIT | explicit PPTX→PDF export |

All are permissively licensed and compatible with the app's distribution;
there is no copyleft obligation (jszip is dual-licensed and used under MIT).

## Benchmarks

Reproduce with:

```sh
RUN_BENCH=1 npx vitest run src/test/bench.documents.test.ts
```

Indicative single-run numbers (Node 22, jsdom; the suite asserts only that the
work happened, never timings, so CI stays deterministic):

| Path | Deck / file | Time |
| ---- | ----------- | ---- |
| eager `renderPptx` (whole deck at once — export path) | 120 slides | ~241 ms |
| **lazy open → first slide on screen** | 120 slides | **~26 ms** |
| lazy flip through all 120 slides (user-paced, cached) | 120 slides | ~164 ms total |
| `textIndex()` (find / AI text pass) | 120 slides | ~121 ms |
| `extractPptxSlideTexts` (upload pipeline) | 120 slides | ~74 ms |
| `extractPdfText` (upload pipeline) | 200 pages | ~823 ms |

Opening cost stays near-flat as decks grow, while the old eager path scales
with slide count:

| Deck | lazy open + slide 1 | eager whole-deck render |
| ---- | -------------------- | ----------------------- |
| 30 slides | ~6 ms | ~32 ms |
| 120 slides | ~10 ms | ~119 ms |
| 240 slides | ~25 ms | ~270 ms |

## Tests

| Suite | Pins |
| ----- | ---- |
| `src/documents/registry.test.ts` | routing, kind precedence (sniff > metadata > filename > legacy), unsupported honesty, MIME, presentation semantics |
| `src/test/pptx-lazy-deck.test.ts` | one-slide open, on-demand parse, bounded cache, text-only pass, eager back-compat, disposal |
| `src/test/pptx-viewer.test.tsx` | viewer UX: stages, thumbnails, find, text mode, notes |
| `src/test/pptx-to-pdf.test.ts` | export is explicit-only; the reader never converts |
| `src/test/docx-viewer.test.tsx` | wiring to docx-preview, zoom, Download Original, honest error card |
| `src/test/xlsx-viewer.test.tsx` | values, formulas, merges, tabs, find, bounded AI context, CSV |
| `src/test/document-engine.test.tsx` | upload→storage→viewer: byte-identical saves, no conversion, extraction failure survives, storage failure blocks the record, source boundaries |
| `src/test/document-processing.test.ts` | extraction service happy paths + corrupt inputs |
| `src/test/bench.documents.test.ts` | benchmarks (skipped unless `RUN_BENCH=1`) |

## Rollback

`git revert` the engine commits. Rollback is safe for user data because the
engine performs **no stored-data migration**: routing is computed at open time
from each record's own fields, and the original bytes were never rewritten.
The deleted `universalProcessor.ts` is restored by the same revert.
