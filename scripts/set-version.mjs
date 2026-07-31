#!/usr/bin/env node
/**
 * Single source of truth for the app version.
 *
 * The version used to live in 5 hand-edited places. Miss one and the build
 * breaks in a way that is painful to spot:
 *   - tauri.conf.json is what the updater compares against, so if it lags
 *     behind, users are never offered the update at all.
 *   - Cargo.toml / Cargo.lock disagreeing makes the Rust build fail.
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
  tauriConf: p('src-tauri', 'tauri.conf.json'),
  cargoToml: p('src-tauri', 'Cargo.toml'),
  cargoLock: p('src-tauri', 'Cargo.lock'),
  layout: p('src', 'components', 'Layout.tsx'),
};

const getVersions = () => {
  const out = {};
  out['package.json'] = JSON.parse(read(FILES.pkg)).version;
  out['src-tauri/tauri.conf.json'] = JSON.parse(read(FILES.tauriConf)).version;

  // Only the [package] version at the top of Cargo.toml, not dependencies'.
  out['src-tauri/Cargo.toml'] =
    read(FILES.cargoToml).match(/^\s*\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;

  // Only the pharmatrack entry in the lockfile.
  out['src-tauri/Cargo.lock'] =
    read(FILES.cargoLock).match(/name = "pharmatrack"\nversion = "([^"]+)"/)?.[1] ?? null;

  // The hardcoded fallback shown before Tauri's getVersion() resolves.
  out['src/components/Layout.tsx'] =
    read(FILES.layout).match(/useState\(['"](\d+\.\d+\.\d+)['"]\)/)?.[1] ?? null;

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

  write(
    FILES.layout,
    read(FILES.layout).replace(
      /(useState\(['"])\d+\.\d+\.\d+(['"]\))/,
      `$1${v}$2`,
    ),
  );

  console.log(`✔ Version set to ${v} in all 5 locations:`);
  for (const [f, ver] of Object.entries(getVersions())) console.log(`   ${ver}  ${f}`);
  console.log('\nNext: npm run tauri:dev to test, then commit.');
};

const checkVersions = () => {
  const versions = getVersions();
  const expected = versions['package.json'];
  const bad = Object.entries(versions).filter(([, v]) => v !== expected);

  if (bad.length) {
    console.error(`✖ Version mismatch (package.json says ${expected}):\n`);
    for (const [f, v] of Object.entries(versions)) {
      console.error(`   ${v === expected ? '✔' : '✖'} ${v ?? 'NOT FOUND'}  ${f}`);
    }
    console.error(`\nFix it with:  npm run version:set ${expected}`);
    process.exit(1);
  }

  console.log(`✔ Version ${expected} is consistent across all 5 locations.`);
};

const [, , cmd] = process.argv;
if (cmd === 'check') checkVersions();
else if (cmd) setVersion(cmd);
else {
  console.error('Usage:\n  npm run version:set <x.y.z>\n  npm run version:check');
  process.exit(1);
}
