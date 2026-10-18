/**
 * Self-verification of the packaged installation, against the manifest the
 * build writes next to the bundle (dist/integrity.json — see the
 * integrityManifest plugin in vite.config.ts).
 *
 * Why this exists: the desktop shell decides a served file's MIME type from
 * its CONTENT, not its name. A file under assets/ that no longer contains
 * what the release shipped — a truncated or partially-unpacked package, a
 * disk error, anything — is served as whatever its bytes say it is, and the
 * app then fails to load that module with an error like "'application/pdf'
 * is not a valid JavaScript MIME type". That message names nothing the user
 * can act on. This check turns it into: which files are wrong, and the exact
 * command that repairs them.
 *
 * Runs only in a packaged shell (the web app is served fresh on every load
 * and has nothing local to verify), once, while the machine is idle.
 */
import { isNativeShell } from '../platform/runtime';
import { isServiceWorkerControlled } from './serviceWorkerRecovery';

export interface IntegrityResult {
  ok: boolean;
  /** Present but their bytes do not match the release. */
  corrupted: string[];
  /** Could not be fetched at all. */
  missing: string[];
  checkedAt: string;
}

const STORAGE_KEY = 'pharmatrack.integrity';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function lastIntegrityResult(): IntegrityResult | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IntegrityResult;
  } catch {
    return null;
  }
}

/** Drops a stored result so a stale failure cannot outlive its cause. */
export function clearIntegrityResult(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifies every file in the manifest. Returns null when a check cannot run
 * (not a packaged shell, no manifest, no crypto) — absence of a result must
 * never read as "installation is fine".
 */
export async function verifyInstallation(): Promise<IntegrityResult | null> {
  if (!isNativeShell()) return null;
  // A controlling service worker intercepts /assets/ fetches and its own
  // fetches bypass the shell's protocol handler, so the results here would
  // describe the worker, not the installation. Refuse to report damage in
  // that state; the enforcement loop removes the worker first.
  if (isServiceWorkerControlled()) return null;
  if (typeof fetch !== 'function' || typeof crypto?.subtle?.digest !== 'function') return null;

  let manifest: { files: Record<string, string> };
  try {
    const response = await fetch('integrity.json', { cache: 'no-store' });
    if (!response.ok) return null;
    manifest = (await response.json()) as { files: Record<string, string> };
  } catch {
    return null;
  }

  const corrupted: string[] = [];
  const missing: string[] = [];
  for (const [file, expected] of Object.entries(manifest.files)) {
    try {
      const response = await fetch(file, { cache: 'no-store' });
      if (!response.ok) {
        missing.push(file);
        continue;
      }
      const actual = await sha256Hex(await response.arrayBuffer());
      if (actual !== expected) corrupted.push(file);
    } catch {
      missing.push(file);
    }
  }

  const result: IntegrityResult = {
    ok: corrupted.length === 0 && missing.length === 0,
    corrupted,
    missing,
    checkedAt: new Date().toISOString(),
  };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    /* the banner just won't survive a restart */
  }
  return result;
}

/** The repair command, per platform, for the damage banner. */
export function integrityRepairHint(): string {
  const updatesScript =
    'curl -fsSL -o /tmp/pharmatrack-update.sh ' +
    'https://raw.githubusercontent.com/g2code33/pharmaTRACK_PERFECT_new/arena/01a0e837-pharmatrack-perfect-new/scripts/update-ubuntu.sh' +
    ' && sudo bash /tmp/pharmatrack-update.sh';
  return /win/i.test(navigator.userAgent ?? '')
    ? 'Download the newest installer from the GitHub releases page and run it over this installation.'
    : `sudo bash -c "${updatesScript}"`;
}
