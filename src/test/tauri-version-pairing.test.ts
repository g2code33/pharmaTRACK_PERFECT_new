/**
 * The Tauri bundler and the Tauri runtime are a matched pair.
 *
 * `tauri build` does not just compile the Rust shell — after compiling, the
 * CLI's bundler patches the finished executable with bundle-type information
 * (so the updater can pick the right installer format when several formats
 * target one platform, e.g. our .msi + .exe on Windows). That handshake only
 * works when the CLI and the `tauri` crate come from the same minor
 * generation. Dependabot updates npm and cargo in separate PRs, so it kept
 * delivering half of a new generation at a time:
 *
 *   CLI 2.12.3 + tauri crate 2.11.3 → desktop bundling fails after compile
 *   CLI 2.11.3 + tauri crate 2.12.4 → desktop bundling fails after compile
 *
 * Both halves must land together. This test pins that: the CLI, the JS api
 * package and every plugin JS package have to sit on the same minor as their
 * Rust counterparts in src-tauri/Cargo.lock.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const npmLock = JSON.parse(read('package-lock.json')) as {
  packages: Record<string, { version?: string }>;
};

const npmVersion = (name: string): string => {
  const version = npmLock.packages[`node_modules/${name}`]?.version;
  if (!version) {
    throw new Error(`${name} is missing from package-lock.json — is it still a dependency?`);
  }
  return version;
};

const cargoVersion = (name: string): string => {
  // Cargo.lock blocks are `name = "x"` then `version = "y"`. Anchor both so a
  // crate whose name merely ends in `name` (e.g. `tauri-utils`) cannot match.
  const lock = read('src-tauri/Cargo.lock');
  const match = lock.match(new RegExp(`^name = "${name}"$\\n^version = "([^"]+)"$`, 'm'));
  if (!match) {
    throw new Error(`${name} is missing from src-tauri/Cargo.lock — is it still a dependency?`);
  }
  return match[1];
};

/** "2.12.4" → "2.12". Patch drift between the two halves is fine; minor drift is not. */
const minorOf = (version: string) => version.split('.').slice(0, 2).join('.');

describe('the Tauri CLI and the Tauri Rust crates stay in lockstep', () => {
  it('the bundling CLI matches the compiled tauri crate', () => {
    // npm ships the CLI (@tauri-apps/cli) that bundles; cargo ships the tauri
    // crate that gets compiled into the executable the bundler then patches.
    // A minor mismatch here is exactly the combination that broke desktop
    // packaging: every job compiled fine and the bundle step still failed.
    expect(
      minorOf(npmVersion('@tauri-apps/cli')),
      `@tauri-apps/cli ${npmVersion('@tauri-apps/cli')} cannot bundle an app built with the tauri ${cargoVersion('tauri')} crate — update both halves to the same minor in one change`,
    ).toBe(minorOf(cargoVersion('tauri')));
  });

  it('the JS api package matches the compiled tauri crate', () => {
    expect(
      minorOf(npmVersion('@tauri-apps/api')),
      `@tauri-apps/api ${npmVersion('@tauri-apps/api')} and the tauri ${cargoVersion('tauri')} crate belong to different minor generations — move them together`,
    ).toBe(minorOf(cargoVersion('tauri')));
  });

  it.each(['plugin-process', 'plugin-shell', 'plugin-updater'] as const)(
    '%s ships the same minor on both sides of the IPC bridge',
    (plugin) => {
      const js = npmVersion(`@tauri-apps/${plugin}`);
      const rs = cargoVersion(`tauri-${plugin}`);
      expect(
        minorOf(js),
        `@tauri-apps/${plugin} ${js} (npm) and tauri-${plugin} ${rs} (cargo) must be updated together`,
      ).toBe(minorOf(rs));
    },
  );
});
