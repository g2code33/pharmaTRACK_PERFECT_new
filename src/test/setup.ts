import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

// jsdom has no navigator.onLine setter, but the whole app branches on it
// (offline-first). This lets tests flip between online and offline.
export const setOnline = (value: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
};

// Default to online; individual tests opt into offline.
setOnline(true);

// jsdom implements neither of these, but the PPTX renderer and file previews
// rely on them. Minimal stand-ins so those paths are testable.
if (typeof URL.createObjectURL !== 'function') {
  let counter = 0;
  URL.createObjectURL = () => `blob:mock/${++counter}`;
  URL.revokeObjectURL = () => {};
}
