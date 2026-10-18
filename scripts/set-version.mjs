#!/usr/bin/env node
/**
 * Single source of truth for the app version.
 *
 * The version used to live in several hand-edited places. Miss one and the
 * build breaks in a way that is painful to spot:
 *   - tauri.conf.json is what the updater compares against, so if it lags
 *     behind, users are never offered the update at all.
 *   - Cargo.toml / Cargo.lock disagreeing makes the Rust build fail.
 *
 * src/ is deliberately not in that list any more. The two components that
 * display a version used to hold their own copies of it, and they drifted the
 * moment one of them was split out of the other — the header said 1.2.0 while
 * the title bar above it said 1.2.1. They now read __APP_VERSION__, which the
 * Vite and Vitest configs inject from package.json, so there is nothing to
 * keep in step. `check` enforces that by failing if any source file grows a
 * version literal again.
 *
 * Usage:
 *   npm run version:set 1.1.83   # write a new version everywhere
 *   npm run version:check        # verify all files agree (used by build)
 *
 * package.json is treated as the source of truth for version:check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(root, ...s);

const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s);

// Preserves the file's original trailing-newline style so we don't create
// noisy one-character diffs in git.
const writeJson = (file, obj, original) => {
  const nl = original.endsWith('\n') ? '\n' : '';
  write(file, JSON.stringify(obj, null, 2) + nl);
};

const FILES = {
  pkg: p('package.json'),
  pkgLock: p('package-lock.json'),
  tauriConf: p('src-tauri', 'tauri.conf.json'),
  cargoToml: p('src-tauri', 'Cargo.toml'),
  cargoLock: p('src-tauri', 'Cargo.lock'),
};

const SRC = p('src');
/** `0.0.0` is the "could not read one" sentinel in semesterArchive.ts. */
const VERSION_LITERAL = /['"`](\d+\.\d+\.\d+)['"`]/g;

/** Source files that have gone back to hardcoding a version. */
const findPinnedVersionsInSource = () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test') walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const hits = [...read(full).matchAll(VERSION_LITERAL)]
        .map((m) => m[1])
        .filter((v) => v !== '0.0.0');
      if (hits.length) offenders.push(`${path.relative(root, full)} (${[...new Set(hits)].join(', ')})`);
    }
  };
  walk(SRC);
  return offenders;
};

const getVersions = () => {
  const out = {};
  out['package.json'] = JSON.parse(read(FILES.pkg)).version;
  if (fs.existsSync(FILES.pkgLock)) {
    out['package-lock.json'] = JSON.parse(read(FILES.pkgLock)).version;
  }
  out['src-tauri/tauri.conf.json'] = JSON.parse(read(FILES.tauriConf)).version;

  // Only the [package] version at the top of Cargo.toml, not dependencies'.
  out['src-tauri/Cargo.toml'] =
    read(FILES.cargoToml).match(/^\s*\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;

  // Only the pharmatrack entry in the lockfile.
  out['src-tauri/Cargo.lock'] =
    read(FILES.cargoLock).match(/name = "pharmatrack"\nversion = "([^"]+)"/)?.[1] ?? null;

  return out;
};

const setVersion = (v) => {
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`✖ Invalid version "${v}". Use MAJOR.MINOR.PATCH, e.g. 1.1.83`);
    process.exit(1);
  }

  const pkgRaw = read(FILES.pkg);
  const pkg = JSON.parse(pkgRaw);
  pkg.version = v;
  writeJson(FILES.pkg, pkg, pkgRaw);

  if (fs.existsSync(FILES.pkgLock)) {
    const lockRaw = read(FILES.pkgLock);
    const lock = JSON.parse(lockRaw);
    lock.version = v;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = v;
    }
    writeJson(FILES.pkgLock, lock, lockRaw);
  }

  const confRaw = read(FILES.tauriConf);
  const conf = JSON.parse(confRaw);
  conf.version = v;
  writeJson(FILES.tauriConf, conf, confRaw);

  write(
    FILES.cargoToml,
    read(FILES.cargoToml).replace(
      /^(\s*\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
      `$1${v}$2`,
    ),
  );

  write(
    FILES.cargoLock,
    read(FILES.cargoLock).replace(
      /(name = "pharmatrack"\nversion = ")[^"]+(")/,
      `$1${v}$2`,
    ),
  );

  const distSw = p('dist', 'sw.js');
  if (fs.existsSync(distSw)) {
    const swRaw = read(distSw);
    write(
      distSw,
      swRaw.replace(
        /const CACHE_VERSION = `\${CACHE_PREFIX}[^`]+`;/,
        `const CACHE_VERSION = \`\${CACHE_PREFIX}${v}\`;`,
      ),
    );
  }

  console.log(`✔ Version set to ${v} in all ${Object.keys(getVersions()).length} locations:`);
  for (const [f, ver] of Object.entries(getVersions())) console.log(`   ${ver}  ${f}`);
  console.log('\nNext: npm run tauri:dev to test, then commit.');
};

const checkVersions = () => {
  const versions = getVersions();
  const expected = versions['package.json'];
  const bad = Object.entries(versions).filter(([, v]) => v !== expected);

  const pinned = findPinnedVersionsInSource();
  if (pinned.length) {
    console.error('✖ A source file is hardcoding a version again:\n');
    for (const offender of pinned) console.error(`   ✖ ${offender}`);
    console.error(
      '\nRead the version from __APP_VERSION__ instead; it is injected from' +
      '\npackage.json by vite.config.ts and vitest.config.ts.',
    );
    process.exit(1);
  }

  if (bad.length) {
    console.error(`✖ Version mismatch (package.json says ${expected}):\n`);
    for (const [f, v] of Object.entries(versions)) {
      console.error(`   ${v === expected ? '✔' : '✖'} ${v ?? 'NOT FOUND'}  ${f}`);
    }
    console.error(`\nFix it with:  npm run version:set ${expected}`);
    process.exit(1);
  }

  console.log(
    `✔ Version ${expected} is consistent across all ${Object.keys(versions).length} locations,` +
    ' and no source file pins one.',
  );
};

const [, , cmd] = process.argv;
if (cmd === 'check') checkVersions();
else if (cmd) setVersion(cmd);
else {
  console.error('Usage:\n  npm run version:set <x.y.z>\n  npm run version:check');
  process.exit(1);
}
