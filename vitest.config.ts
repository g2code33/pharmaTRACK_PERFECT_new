import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // src-tauri/target holds a huge Rust build dir; never scan it.
    exclude: ['node_modules', 'dist', 'src-tauri'],
  },
});
