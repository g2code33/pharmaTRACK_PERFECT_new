import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    port: 5173,
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/node_modules/**'
      ]
    }
  }
})