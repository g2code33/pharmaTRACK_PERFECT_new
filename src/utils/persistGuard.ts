/**
 * Latch that stops saveState from replacing a semester file it could not read.
 * Kept out of storage.ts so test setup can reset it without loading IndexedDB
 * (which would defeat idb-keyval mocks).
 */
let persistBlockedReason: string | null = null;

export const blockWorkspacePersist = (reason: string): void => {
  persistBlockedReason = reason;
};

export const allowWorkspacePersist = (): void => {
  persistBlockedReason = null;
};

export const isWorkspacePersistBlocked = (): boolean => persistBlockedReason !== null;

export const workspacePersistBlockReason = (): string | null => persistBlockedReason;

export const clearPersistBlockIfSet = (): void => {
  persistBlockedReason = null;
};
