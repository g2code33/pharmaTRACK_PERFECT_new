import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'

function versionServiceWorker(): Plugin {
  return {
    name: 'pharmatrack-version-service-worker',
    closeBundle() {
      const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
      ) as { version: string };
      const serviceWorker = path.resolve(process.cwd(), 'dist/sw.js');
      if (!fs.existsSync(serviceWorker)) return;
      const source = fs.readFileSync(serviceWorker, 'utf8');
      fs.writeFileSync(
        serviceWorker,
        source.replaceAll('__PHARMATRACK_VERSION__', packageJson.version),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), versionServiceWorker()],
  base: './',
  
  // This explicitly forces Vite to read the GitHub Action secrets!
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(process.env.VITE_SUPABASE_URL),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.VITE_SUPABASE_ANON_KEY)
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Split the vendor libraries out of the single 2.1 MB app chunk. The heavy,
    // rarely-changing ones (pdf.js, charts, docx) become their own files, so
    // the browser caches them and startup only parses what it needs.
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-pdf': ['pdfjs-dist'],
          'vendor-charts': ['recharts'],
          'vendor-docx': ['mammoth', 'jszip'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
    // Raised so the build stops warning about chunks we've deliberately kept
    // together; anything above this is a genuine regression worth looking at.
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Arena's preview host is a subdomain of e2b.app. Vite 5 blocks unknown hosts.
    allowedHosts: ['.e2b.app'],
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/node_modules/**'
      ]
    }
  }
})