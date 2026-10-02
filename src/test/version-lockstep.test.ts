/**
 * One release, one version number.
 *
 * These four artefacts are what a user can see a version in: the web bundle,
 * the desktop installer, the Rust crate and the Android package. They have
 * drifted before — the title bar was extracted out of the layout and the two
 * copies of the fallback immediately disagreed, so the desktop window
 * announced 1.2.1 while the header underneath it said 1.2.0.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const version = (JSON.parse(read('package.json')) as { version: string }).version;

describe('every artefact ships the same version', () => {
  it('package.json is the source of truth and looks like a version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the desktop installer agrees', () => {
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string };
    expect(tauri.version).toBe(version);
  });

  it('the Rust crate agrees', () => {
    expect(read('src-tauri/Cargo.toml')).toContain(`version = "${version}"`);
  });

  it('both lockfiles agree, or the build will not even start', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(version);
    expect(lock.packages['']?.version).toBe(version);
    expect(read('src-tauri/Cargo.lock')).toContain(`name = "pharmatrack"\nversion = "${version}"`);
  });

  it('bumps only the app in package-lock.json, never a dependency', () => {
    // Blind find-and-replace across the lockfile once rewrote three
    // dependencies that happened to share the old version number.
    const lines = read('package-lock.json').split('\n');
    const bumped = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line === `"version": "${version}",`);
    expect(bumped.map(({ index }) => index)).toEqual([2, 8]);
  });

  it('Android derives its own, so it cannot disagree', () => {
    const gradle = read('android/app/build.gradle.kts');
    expect(gradle).toContain('val pharmaVersionName = (parsedPackage["version"] as? String)');
    expect(gradle).toContain('versionName = pharmaVersionName');
    expect(gradle).toContain('versionCode = pharmaVersionCode');
  });

  it('Android never goes backwards over an existing install', () => {
    const [major, minor, patch] = version.split('.').map(Number);
    const code = 1_000 + major * 10_000 + minor * 100 + patch;
    // 1.2.1 shipped as 11201; anything released after it must exceed that.
    expect(code).toBeGreaterThan(11_201);
  });
});

describe('the app itself', () => {
  it('reads the version from the build rather than pinning its own copy', () => {
    for (const file of ['src/components/Layout.tsx', 'src/components/NativeTitleBar.tsx']) {
      expect(read(file)).toContain('const APP_VERSION_FALLBACK = __APP_VERSION__;');
    }
  });

  it('has no hardcoded version anywhere in the source', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'test') walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        // A version-shaped literal in a quoted string. `0.0.0` is allowed:
        // it is the "we could not read one" sentinel in semesterArchive, not
        // a number anybody has to remember to change.
        const literals = source.match(/['"`]\d+\.\d+\.\d+['"`]/g) ?? [];
        if (literals.some((literal) => !literal.includes('0.0.0'))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, 'src'));
    expect(offenders).toEqual([]);
  });

  it('gets the value injected by both the app build and the test build', () => {
    for (const config of ['vite.config.ts', 'vitest.config.ts']) {
      expect(read(config)).toContain('__APP_VERSION__: JSON.stringify(appVersion)');
    }
    expect(read('src/vite-env.d.ts')).toContain('declare const __APP_VERSION__: string;');
    // And it actually resolves at runtime, which is the whole point.
    expect(__APP_VERSION__).toBe(version);
  });
});
