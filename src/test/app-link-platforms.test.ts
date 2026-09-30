import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const readSource = (path: string) => readFileSync(join(root, path), 'utf8');

describe('platform app-link registration', () => {
  it('registers the quick quiz protocol on Android', () => {
    const manifest = readSource('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:scheme="pharmatrack"');
    expect(manifest).toContain('android:host="pharmatrack-web.pages.dev"');
  });

  it('publishes Android App Links verification for the signed APK certificate', () => {
    const assetLinks = JSON.parse(readSource('public/.well-known/assetlinks.json')) as Array<{
      relation: string[];
      target: {
        namespace: string;
        package_name: string;
        sha256_cert_fingerprints: string[];
      };
    }>;
    expect(assetLinks).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.pharmatrack.app',
          sha256_cert_fingerprints: [
            '8C:26:79:8C:42:90:06:99:12:21:46:69:C3:04:54:C8:44:71:99:96:E8:6F:EF:EE:98:49:94:6A:DB:C8:18:28',
          ],
        },
      },
    ]);
  });

  it('registers the quick quiz protocol in the Linux desktop entry', () => {
    const desktop = readSource('src-tauri/templates/deb.desktop');
    expect(desktop).toContain('x-scheme-handler/pharmatrack');
    expect(desktop).toContain('%U');
  });

  it('registers the quick quiz protocol for Windows desktop launches', () => {
    const main = readSource('src-tauri/src/main.rs');
    expect(main).toContain('register_windows_protocol_handler');
    expect(main).toContain('HKCU\\\\Software\\\\Classes\\\\pharmatrack');
  });

  it('keeps installed PWAs link-capture friendly for quick quiz web links', () => {
    const manifest = JSON.parse(readSource('public/manifest.webmanifest')) as Record<
      string,
      unknown
    >;
    expect(manifest.id).toBe('./index.html#/');
    expect(manifest.handle_links).toBe('preferred');
    expect(manifest.protocol_handlers).toEqual([
      { protocol: 'web+pharmatrack', url: './index.html#/app-link?url=%s' },
    ]);
    expect(manifest.launch_handler).toEqual({ client_mode: 'navigate-existing' });
  });
});
