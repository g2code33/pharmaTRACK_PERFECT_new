import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const appVersion = (
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version;

export default defineConfig({
  plugins: [react()],
  // Mirrors vite.config.ts so components can read the real version in tests.
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // src-tauri/target holds a huge Rust build dir; never scan it.
    exclude: ['node_modules', 'dist', 'src-tauri'],
  },
});
