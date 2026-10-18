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
    expect(manifest.launch_handler).toEqual({
      client_mode: ['focus-existing', 'navigate-existing', 'auto'],
    });
    expect(manifest.related_applications).toEqual([
      { platform: 'webapp', url: 'https://pharmatrack-web.pages.dev/manifest.webmanifest' },
    ]);
    expect(manifest.prefer_related_applications).toBe(false);
  });

  it('keeps Android versionCode above every previously published build', () => {
    const gradle = readSource('android/app/build.gradle.kts');
    const pkg = JSON.parse(readSource('package.json')) as { version: string };
    const offsetMatch = gradle.match(/val pharmaVersionCodeOffset = ([\d_]+)/);
    expect(offsetMatch).not.toBeNull();

    const offset = Number((offsetMatch?.[1] || '0').replace(/_/g, ''));
    const [major, minor, patch] = pkg.version.split('.').map((part) => Number(part) || 0);
    const versionCode = offset + major * 10_000 + minor * 100 + patch;

    // 1.1.126 shipped as versionCode 10_226; a lower code cannot install over it.
    expect(versionCode).toBeGreaterThan(10_226);
  });
});
