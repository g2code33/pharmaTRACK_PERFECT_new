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

export type IndexShape = Record<string, IndexedDoc>;

/** In-memory mirror so lookups are synchronous. */
let memoryIndex: IndexShape = {};
let loaded = false;

/**
 * Trigram postings built once from `memoryIndex`. A search intersects these
 * lists and only then reads the candidate pages, so typing does not walk
 * every document's full text. The page text itself stays in the index that
 * was loaded at startup — it is not fetched again per keystroke.
 */
type PageKey = string;
const PAGE_SEP = '\u0000';
let postings: Map<string, PageKey[]> | null = null;
let postingsGen = 0;
let builtGen = -1;

const pageKey = (materialId: string, page: number): PageKey => `${materialId}${PAGE_SEP}${page}`;

const invalidatePostings = () => {
  postingsGen++;
  postings = null;
};

const ensurePostings = (): Map<string, PageKey[]> => {
  if (postings && builtGen === postingsGen) return postings;
  const map = new Map<string, PageKey[]>();
  for (const doc of Object.values(memoryIndex)) {
    for (const page of doc.pages) {
      const key = pageKey(doc.materialId, page.page);
      const hay = page.text.toLowerCase();
      const seen = new Set<string>();
      for (let i = 0; i <= hay.length - 3; i++) {
        const gram = hay.slice(i, i + 3);
        if (seen.has(gram)) continue;
        seen.add(gram);
        const list = map.get(gram);
        if (list) list.push(key);
        else map.set(gram, [key]);
      }
    }
  }
  postings = map;
  builtGen = postingsGen;
  return map;
};

/** Pages that contain every trigram of `term`. Terms shorter than 3 are not indexed. */
const pagesForTerm = (index: Map<string, PageKey[]>, term: string): Set<PageKey> | null => {
  if (term.length < 3) return null;
  const lists: PageKey[][] = [];
  for (let i = 0; i <= term.length - 3; i++) {
    const list = index.get(term.slice(i, i + 3));
    if (!list || list.length === 0) return new Set();
    lists.push(list);
  }
  lists.sort((a, b) => a.length - b.length);
  let acc = new Set(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    const next = new Set<PageKey>();
    for (const key of lists[i]) if (acc.has(key)) next.add(key);
    acc = next;
    if (acc.size === 0) break;
  }
  return acc;
};

export const loadSearchIndex = async (): Promise<void> => {
  if (loaded) return;
  try {
    memoryIndex = (await idb.get<IndexShape>(INDEX_KEY)) ?? {};
  } catch (err) {
    console.error('Could not load the search index:', err);
    memoryIndex = {};
  } finally {
    loaded = true;
    invalidatePostings();
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
  invalidatePostings();
  await persist();
};

export const removeFromIndex = async (materialId: string): Promise<void> => {
  if (!memoryIndex[materialId]) return;
  delete memoryIndex[materialId];
  invalidatePostings();
  await persist();
};

// --- Raw accessors used by the semester-archive system ---------------------
// The index holds the ONLY full copy of offloaded per-page text, so an archive
// must carry it, a restore must put it back, and a semester reset must clear
// it (stale entries would point search at materials that no longer exist).

/** The persisted index, or null when there is none. */
export const getSearchIndexRaw = async (): Promise<IndexShape | null> => {
  try {
    return (await idb.get<IndexShape>(INDEX_KEY)) ?? null;
  } catch (err) {
    console.error('Could not read search index for archival:', err);
    return null;
  }
};

/** Replaces both the persisted and in-memory index (null clears it). */
export const setSearchIndexRaw = async (index: IndexShape | null): Promise<void> => {
  memoryIndex = index ?? {};
  loaded = true;
  invalidatePostings();
  try {
    if (index === null) {
      await idb.del(INDEX_KEY);
    } else {
      await idb.set(INDEX_KEY, index);
    }
  } catch (err) {
    console.error('Could not write search index:', err);
    throw err;
  }
};

/** Drops the persisted index and its in-memory mirror. */
export const clearSearchIndex = async (): Promise<void> => {
  await setSearchIndexRaw(null);
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

const recordHit = (hits: DeepHit[], doc: IndexedDoc, page: IndexedPage, terms: string[]) => {
  const hay = page.text.toLowerCase();
  // Every term must appear on the page, so multi-word queries behave as AND.
  if (!terms.every((t) => hay.includes(t))) return;

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
};

/**
 * Searches indexed document text.
 * Synchronous by design so the global search box updates as the user types.
 * Candidate pages come from the trigram index; the includes() check is what
 * actually decides a hit, so ranking and snippets stay the same.
 */
export const searchDeep = (rawQuery: string, limit = 12): DeepHit[] => {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 3) return [];

  const terms = query.split(/\s+/).filter(Boolean);
  const hits: DeepHit[] = [];
  const index = ensurePostings();

  let candidates: Set<PageKey> | null = null;
  let shortTerm = false;
  for (const term of terms) {
    const pages = pagesForTerm(index, term);
    if (!pages) {
      shortTerm = true;
      continue;
    }
    if (pages.size === 0) return [];
    if (!candidates) candidates = pages;
    else {
      const next = new Set<PageKey>();
      for (const key of pages) if (candidates.has(key)) next.add(key);
      candidates = next;
      if (candidates.size === 0) return [];
    }
  }

  // "ab cd" has no trigram to narrow with. Rare, and still correct.
  if (!candidates || (shortTerm && terms.every((t) => t.length < 3))) {
    for (const doc of Object.values(memoryIndex)) {
      for (const page of doc.pages) recordHit(hits, doc, page, terms);
    }
  } else {
    for (const key of candidates) {
      const sep = key.indexOf('\0');
      const materialId = key.slice(0, sep);
      const pageNum = Number(key.slice(sep + 1));
      const doc = memoryIndex[materialId];
      const page = doc?.pages.find((p) => p.page === pageNum);
      if (doc && page) recordHit(hits, doc, page, terms);
    }
  }

  // Pages with more occurrences first, then earlier pages.
  return hits.sort((a, b) => b.count - a.count || a.page - b.page).slice(0, limit);
};

/** Exposed for tests. */
export const __resetIndex = () => {
  memoryIndex = {};
  loaded = false;
  invalidatePostings();
};
