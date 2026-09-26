/**
 * PharmaTRACK AI Engine — persisted local index (RAG stage 5).
 *
 * The index lives in IndexedDB, offline, and is the reason a question about
 * slide 23 does not have to load and re-split forty materials. It is a *derived*
 * cache: it can always be rebuilt from academic data, so losing it costs time,
 * never data.
 *
 * It is also deliberately excluded from semester archives — see
 * `PROTECTED_IDB_KEYS` in `utils/semesterArchive.ts`.
 */
import * as idb from 'idb-keyval';
import { RAG_INDEX_KEY, RAG_INDEX_VERSION } from './types';
import type { RagIndexShape } from './types';

export const emptyIndex = (): RagIndexShape => ({ version: RAG_INDEX_VERSION, materials: {} });

/** Loads the index, discarding anything written by an older index format. */
export async function loadRagIndex(): Promise<RagIndexShape> {
  try {
    const raw = (await idb.get(RAG_INDEX_KEY)) as RagIndexShape | undefined | null;
    if (!raw || typeof raw !== 'object' || !raw.materials) return emptyIndex();
    if (raw.version !== RAG_INDEX_VERSION) return emptyIndex();
    return raw;
  } catch {
    // A corrupt or unavailable index is not an error the student can act on —
    // retrieval simply rebuilds what it needs.
    return emptyIndex();
  }
}

export async function saveRagIndex(index: RagIndexShape): Promise<void> {
  try {
    await idb.set(RAG_INDEX_KEY, index);
  } catch {
    /* Private-mode / quota failures must never break a question. */
  }
}

export async function clearRagIndex(): Promise<void> {
  try {
    await idb.del(RAG_INDEX_KEY);
  } catch {
    /* ignore */
  }
}
