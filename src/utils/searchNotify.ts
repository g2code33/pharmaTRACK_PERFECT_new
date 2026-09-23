/** Tiny pub/sub so the header can refresh once a background index finishes. */
const listeners = new Set<() => void>();

export function bumpSearchIndex(): void {
  listeners.forEach((fn) => fn());
}

export function onSearchIndex(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
