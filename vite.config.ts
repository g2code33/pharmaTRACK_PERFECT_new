import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The single source of truth for the app version is package.json. Anything in
 * src/ that needs it reads __APP_VERSION__, so a release bump can never leave
 * one component announcing a version the build is not.
 */
const appVersion = (
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version;

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

/**
 * Writes dist/integrity.json after every build: the SHA-256 of every shipped
 * file. The packaged app verifies itself against this manifest at startup, so
 * an installation whose files were corrupted after packaging (interrupted
 * package unpack, disk error, tampering) is DETECTED and named instead of
 * crashing with a misleading "not a valid JavaScript MIME type" module error.
 *
 * The desktop shell's asset protocol decides a response's MIME type from the
 * file's actual content, not its extension — a file that contains PDF bytes
 * at its start is served as application/pdf no matter what it is called, and
 * the app then cannot load the module. Only a reinstall can repair that, and
 * the user needs to be told so in words.
 */
function integrityManifest(): Plugin {
  return {
    name: 'pharmatrack-integrity-manifest',
    closeBundle() {
      const dist = path.resolve(process.cwd(), 'dist');
      if (!fs.existsSync(dist)) return;
      const files: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name !== 'integrity.json') {
            const relative = path.relative(dist, full).split(path.sep).join('/');
            files[relative] = crypto
              .createHash('sha256')
              .update(fs.readFileSync(full))
              .digest('hex');
          }
        }
      };
      walk(dist);
      fs.writeFileSync(
        path.join(dist, 'integrity.json'),
        `${JSON.stringify({ files }, null, 2)}\n`,
      );
      console.log(`[integrity] manifest written for ${Object.keys(files).length} files`);
    },
  };
}

/**
 * Writes dist/chunk-map.json: source path -> emitted chunk file, for every
 * dynamically imported page. The router hands each page's source path to
 * lazyRoute, so when a webview refuses a module the app can name and re-fetch
 * the EXACT file instead of guessing from the resource timeline. WebKit's
 * refusal ("'application/pdf' is not a valid JavaScript MIME type") carries no
 * URL at all, which is what makes the map necessary — see
 * src/utils/moduleRescue.ts.
 *
 * Only dynamic entries are recorded: those are the lazy routes. (The plugin
 * deliberately records the emitted name from the same build that wrote it, so
 * a stale hash can never be looked up.)
 */
function routeChunkMap(): Plugin {
  return {
    name: 'pharmatrack-route-chunk-map',
    apply: 'build',
    generateBundle(_options, bundle) {
      const map: Record<string, string> = {};
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        if (!item.isDynamicEntry || !item.facadeModuleId) continue;
        const id = path
          .relative(process.cwd(), item.facadeModuleId)
          .split(path.sep)
          .join('/');
        map[id] = item.fileName;
      }
      this.emitFile({
        type: 'asset',
        fileName: 'chunk-map.json',
        source: `${JSON.stringify(map, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    versionServiceWorker(),
    integrityManifest(),
    routeChunkMap(),
  ],
  base: './',
  
  // This explicitly forces Vite to read the GitHub Action secrets!
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(process.env.VITE_SUPABASE_URL),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.VITE_SUPABASE_ANON_KEY),
    __APP_VERSION__: JSON.stringify(appVersion)
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