import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerPwa } from '../pwa';

const root = path.resolve(process.cwd());

function readPublic(name: string): string {
  return fs.readFileSync(path.join(root, 'public', name), 'utf8');
}

describe('PWA web shell', () => {
  it('has an installable manifest with standalone display and relative paths', () => {
    const manifest = JSON.parse(readPublic('manifest.webmanifest')) as Record<string, unknown>;
    expect(manifest.name).toBe('PharmaTRACK');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./index.html#/');
    expect(manifest.scope).toBe('./');
    expect(manifest.theme_color).toBe('#0f172a');
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: './icon.png', purpose: 'any maskable' }),
    ]));
  });

  it('uses a versioned, invalidating shell cache and excludes private API traffic', () => {
    const worker = readPublic('sw.js');
    expect(worker).toContain('CACHE_PREFIX');
    expect(worker).toContain('__PHARMATRACK_VERSION__');
    expect(worker).toContain('caches.delete');
    expect(worker).toContain('SKIP_WAITING');
    expect(worker).toContain('request.headers.has(\'authorization\')');
    expect(worker).toContain('request.mode === \'navigate\'');
    expect(worker).not.toContain('supabase.auth');
  });

  it('fails open when service workers are unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    expect(await registerPwa()).toBeUndefined();
    if (original) Object.defineProperty(navigator, 'serviceWorker', original);
    else delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  describe('re-checks for a new release when a long-lived tab resurfaces', () => {
    const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

    afterEach(() => {
      vi.unstubAllEnvs();
      if (originalServiceWorker) Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
      else delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    });

    it('calls registration.update() again when the tab becomes visible or the window regains focus', async () => {
      // A phone browser tab is routinely backgrounded for weeks rather than
      // closed, so booting with a single update check (the old behaviour)
      // left it running whatever build was current the day it was first
      // opened. Returning to the tab must prompt a fresh check every time.
      vi.stubEnv('PROD', true);
      const update = vi.fn().mockResolvedValue(undefined);
      const fakeRegistration = {
        installing: null,
        waiting: null,
        update,
        addEventListener: vi.fn(),
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: null,
          register: vi.fn().mockResolvedValue(fakeRegistration),
          addEventListener: vi.fn(),
        },
      });

      await registerPwa();
      expect(update).toHaveBeenCalledTimes(1);

      document.dispatchEvent(new Event('visibilitychange'));
      expect(update).toHaveBeenCalledTimes(2);

      window.dispatchEvent(new Event('focus'));
      expect(update).toHaveBeenCalledTimes(3);
    });
  });
});
