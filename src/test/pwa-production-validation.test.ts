import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isPwaStandalone, PWA_UPDATE_EVENT } from '../pwa';

const root = path.resolve(process.cwd());

function readPublic(name: string): string {
  return fs.readFileSync(path.join(root, 'public', name), 'utf8');
}

function readDist(name: string): string {
  return fs.readFileSync(path.join(root, 'dist', name), 'utf8');
}

describe('PHARMATRACK — Production PWA Validation Suite', () => {
  describe('1. Web App Manifest', () => {
    it('provides a complete, standard-compliant manifest with standalone display and theme colors', () => {
      const manifest = JSON.parse(readPublic('manifest.webmanifest')) as Record<string, unknown>;
      expect(manifest.name).toBe('PharmaTRACK');
      expect(manifest.short_name).toBe('PharmaTRACK');
      expect(manifest.display).toBe('standalone');
      expect(manifest.start_url).toBe('./index.html#/');
      expect(manifest.scope).toBe('./');
      expect(manifest.theme_color).toBe('#0f172a');
      expect(manifest.background_color).toBe('#f8fafc');
    });

    it('manifest links standard 192x192 and 512x512 maskable icons that exist on disk', () => {
      const manifest = JSON.parse(readPublic('manifest.webmanifest')) as {
        icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
      };
      expect(manifest.icons).toBeDefined();

      const icon192 = manifest.icons.find((icon) => icon.sizes === '192x192');
      expect(icon192).toBeDefined();
      expect(icon192?.purpose).toContain('maskable');
      expect(fs.existsSync(path.join(root, 'public', icon192!.src.replace('./', '')))).toBe(true);

      const icon512 = manifest.icons.find((icon) => icon.sizes === '512x512');
      expect(icon512).toBeDefined();
      expect(icon512?.purpose).toContain('maskable');
      expect(fs.existsSync(path.join(root, 'public', icon512!.src.replace('./', '')))).toBe(true);
    });

    it('index.html correctly references the manifest and apple-touch-icons with viewport-fit=cover', () => {
      const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      expect(indexHtml).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
      expect(indexHtml).toContain('viewport-fit=cover');
      expect(indexHtml).toContain('apple-mobile-web-app-capable');
      expect(indexHtml).toContain('apple-touch-icon');
      expect(indexHtml).toContain('theme-color');
    });
  });

  describe('2. Service Worker Lifecycle & Offline Shell', () => {
    it('defines a deterministic, version-stamped offline shell in public and compiled dist', () => {
      const swPublic = readPublic('sw.js');
      expect(swPublic).toContain('const CACHE_PREFIX = \'pharmatrack-shell-\';');
      expect(swPublic).toContain('const CACHE_VERSION = `${CACHE_PREFIX}__PHARMATRACK_VERSION__`;');
      expect(swPublic).toContain('const APP_SHELL = [');
      expect(swPublic).toContain('\'./icon-192.png\'');
      expect(swPublic).toContain('\'./icon-512.png\'');

      if (fs.existsSync(path.join(root, 'dist', 'sw.js'))) {
        const swDist = readDist('sw.js');
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
        expect(swDist).toContain(`const CACHE_VERSION = \`\${CACHE_PREFIX}${pkg.version}\`;`);
        expect(swDist).not.toContain('__PHARMATRACK_VERSION__');
      }
    });

    it('enforces network-first navigation with offline fallback to cached shell', () => {
      const sw = readPublic('sw.js');
      expect(sw).toContain('request.mode === \'navigate\'');
      expect(sw).toContain('fetch(request)');
      expect(sw).toContain('caches.match(\'./index.html\')');
    });

    it('never caches sensitive authenticated API, Supabase, or examination network requests', () => {
      const sw = readPublic('sw.js');
      expect(sw).toContain('request.headers.has(\'authorization\')');
      expect(sw).toContain('api|auth|rest|functions|supabase|pharmaexam');
    });
  });

  describe('3. Cache Invalidation & Seamless Updates', () => {
    it('prunes stale caches on activation and claims clients immediately', () => {
      const sw = readPublic('sw.js');
      expect(sw).toContain('caches.keys()');
      expect(sw).toContain('caches.delete(key)');
      expect(sw).toContain('self.clients.claim()');
    });

    it('supports controlled skipWaiting via postMessage so ongoing exams are not disrupted', () => {
      const sw = readPublic('sw.js');
      expect(sw).toContain('event.data?.type === \'SKIP_WAITING\'');
      expect(sw).toContain('self.skipWaiting()');
    });

    it('emits PWA_UPDATE_EVENT for the application UI banner', () => {
      expect(PWA_UPDATE_EVENT).toBe('pharmatrack:pwa-update');
    });
  });

  describe('4. HTTPS & Security Context Enforcements', () => {
    it('wrangler production configuration specifies HTTPS canonical Pages and Workers domains', () => {
      const wrangler = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
      expect(wrangler).toContain('https://pharmatrack-web.pages.dev');
      expect(wrangler).toContain('https://pharmatrack-web-staging.pages.dev');
      expect(wrangler).not.toContain('CORS_ORIGINS = "*"');
    });
  });

  describe('5. Standalone Mode & Responsive Layout', () => {
    it('detects standalone display mode on desktop, Android, and iOS', () => {
      // Browser with matchMedia standalone
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === '(display-mode: standalone)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })) as unknown as typeof window.matchMedia;

      expect(isPwaStandalone()).toBe(true);

      // Browser not standalone
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })) as unknown as typeof window.matchMedia;

      expect(isPwaStandalone()).toBe(false);

      // iOS navigator.standalone
      (navigator as unknown as { standalone: boolean }).standalone = true;
      expect(isPwaStandalone()).toBe(true);

      // Restore
      delete (navigator as unknown as { standalone?: boolean }).standalone;
      window.matchMedia = originalMatchMedia;
    });

    it('index.css declares safe-area insets and touch target minimums', () => {
      const indexCss = fs.readFileSync(path.join(root, 'src', 'index.css'), 'utf8');
      expect(indexCss).toContain('safe-area-inset');
      expect(indexCss).toContain('min-height: 44px');
    });
  });
});
