import * as idb from 'idb-keyval';

/**
 * Full-text index for uploaded documents.
 *
 * Global search reads `slide.contentText` from app state, but saveState caps
 * that at 2000 characters to keep localStorage under its ~5 MB quota. So a
 * keyword on page 40 of a lecture was genuinely unfindable, even though the
 * text had been extracted at upload time.
 *
 * The full text lives in IndexedDB already (see utils/storage). This keeps a
 * parallel, search-shaped copy there: one record per material, holding the
 * per-page text. It is loaded into memory once on startup so global search
 * stays synchronous — an async search box that lags behind typing feels
 * broken, and the whole app is built to work offline without waiting.
 *
 * Memory is bounded by only holding a normalised lowercase copy and by
 * capping how much of any single document is indexed.
 */

const INDEX_KEY = 'pharmatrack_search_index';

/** Roughly 300 pages of dense text; beyond this the tail is dropped. */
const MAX_CHARS_PER_DOC = 600_000;

export interface IndexedPage {
  page: number;
  text: string;
}

export interface IndexedDoc {
  materialId: string;
  topicId: string;
  title: string;
  pages: IndexedPage[];
}

type IndexShape = Record<string, IndexedDoc>;

/** In-memory mirror so lookups are synchronous. */
let memoryIndex: IndexShape = {};
let loaded = false;

export const loadSearchIndex = async (): Promise<void> => {
  if (loaded) return;
  try {
    memoryIndex = (await idb.get<IndexShape>(INDEX_KEY)) ?? {};
  } catch (err) {
    console.error('Could not load the search index:', err);
    memoryIndex = {};
  } finally {
    loaded = true;
  }
};

const persist = async () => {
  try {
    await idb.set(INDEX_KEY, memoryIndex);
  } catch (err) {
    console.error('Could not save the search index:', err);
  }
};

export const indexDocument = async (doc: IndexedDoc): Promise<void> => {
  let budget = MAX_CHARS_PER_DOC;
  const pages: IndexedPage[] = [];

  for (const page of doc.pages) {
    if (budget <= 0) break;
    const text = page.text.slice(0, budget);
    budget -= text.length;
    if (text.trim()) pages.push({ page: page.page, text });
  }

  memoryIndex[doc.materialId] = { ...doc, pages };
  await persist();
};

export const removeFromIndex = async (materialId: string): Promise<void> => {
  if (!memoryIndex[materialId]) return;
  delete memoryIndex[materialId];
  await persist();
};

export interface DeepHit {
  materialId: string;
  topicId: string;
  title: string;
  page: number;
  /** Matched phrase with surrounding context. */
  snippet: string;
  /** Number of matches on that page, for ranking. */
  count: number;
}

/**
 * Searches the full text of every indexed document.
 * Synchronous by design so the global search box updates as the user types.
 */
export const searchDeep = (rawQuery: string, limit = 12): DeepHit[] => {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 3) return [];

  const terms = query.split(/\s+/).filter(Boolean);
  const hits: DeepHit[] = [];

  for (const doc of Object.values(memoryIndex)) {
    for (const page of doc.pages) {
      const hay = page.text.toLowerCase();
      // Every term must appear on the page, so multi-word queries behave as AND.
      if (!terms.every((t) => hay.includes(t))) continue;

      const first = hay.indexOf(terms[0]);
      const start = Math.max(0, first - 45);
      const end = Math.min(page.text.length, first + terms[0].length + 75);

      let count = 0;
      let from = 0;
      let at = hay.indexOf(terms[0], from);
      while (at !== -1 && count < 50) { count++; from = at + terms[0].length; at = hay.indexOf(terms[0], from); }

      hits.push({
        materialId: doc.materialId,
        topicId: doc.topicId,
        title: doc.title,
        page: page.page,
        snippet: `${start > 0 ? '…' : ''}${page.text.slice(start, end).trim()}…`,
        count,
      });
    }
  }

  // Pages with more occurrences first, then earlier pages.
  return hits.sort((a, b) => b.count - a.count || a.page - b.page).slice(0, limit);
};

/** Exposed for tests. */
export const __resetIndex = () => { memoryIndex = {}; loaded = false; };
