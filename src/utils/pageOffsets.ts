/**
 * Viewport maths for long, paginated scrollers (the PDF reader).
 *
 * Finding "which page am I looking at?" used to be answered with
 * `document.elementsFromPoint()` on every scroll frame. A hit test flushes
 * layout and walks the paint order of everything under the probe point, which
 * on a reader page (canvas + a full transparent text layer) is one of the most
 * expensive calls the DOM offers — and it ran up to 60 times a second while
 * the wheel was moving. Measuring page offsets once per layout change and then
 * doing a binary search against the scroll offset is pure arithmetic, so the
 * scroll thread never waits for us.
 */

/**
 * Index (0-based) of the last entry whose start offset is at or before
 * `probe`. `offsets` must be sorted non-decreasing — i.e. the start of each
 * page along the scroll axis.
 *
 * Returns 0 for an empty list or a probe that sits before the first page, and
 * the final index once the probe passes the last page start.
 */
export const pageIndexAtOffset = (offsets: readonly number[], probe: number): number => {
  if (offsets.length === 0) return 0;

  let low = 0;
  let high = offsets.length - 1;
  let best = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= probe) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
};

/**
 * 1-based page number for a scroller, clamped into `[1, pageCount]`.
 *
 * `probe` is a position in the scroller's own coordinate space (scroll offset
 * plus a fraction of the visible size), matching the values stored in
 * `offsets`.
 */
export const pageNumberAtOffset = (
  offsets: readonly number[],
  probe: number,
  pageCount: number,
): number => {
  if (pageCount <= 0) return 1;
  const index = pageIndexAtOffset(offsets, probe);
  return Math.min(Math.max(index + 1, 1), pageCount);
};

/**
 * Guards against acting on a measurement taken before the document had a
 * layout. Straight after mount — or while a zoom change is still being applied
 * — every page rectangle can come back at the same position, and a binary
 * search over "all zeroes" happily reports the *last* page, which would yank
 * the reader to the end of the document. A usable measurement has one entry
 * per page and is strictly increasing from first to last.
 */
export const offsetsAreMeasured = (offsets: readonly number[], pageCount: number): boolean => {
  if (pageCount <= 0 || offsets.length !== pageCount) return false;
  if (pageCount === 1) return true;
  return offsets[offsets.length - 1] > offsets[0];
};

/**
 * Page numbers ordered by how near they are to `centre`, nearest first.
 *
 * Used to decide what to prepare ahead of the reader. Work queued in this
 * order means the pages someone is most likely to jump to next are ready
 * first, and a document that is still being prepared is always prepared
 * around wherever they actually are.
 */
export const pagesByDistance = (pageCount: number, centre: number): number[] => {
  if (!Number.isFinite(pageCount) || pageCount < 1) return [];
  const anchor = Math.min(Math.max(1, Math.round(centre) || 1), pageCount);
  const pages = [anchor];
  for (let d = 1; pages.length < pageCount; d++) {
    if (anchor - d >= 1) pages.push(anchor - d);
    if (anchor + d <= pageCount) pages.push(anchor + d);
  }
  return pages;
};
