/**
 * Tests for the installation self-verification.
 *
 * The check exists because a damaged installation is invisible to the user:
 * the shell serves whatever bytes are on disk with the MIME those bytes
 * imply, and the app then dies inside a module import with an error that
 * names nothing actionable. The verification must turn that into a named
 * list of wrong files — and must never report "fine" when it could not run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  lastIntegrityResult,
  verifyInstallation,
  integrityRepairHint,
} from '../utils/integrityCheck';

const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const nativeShell = vi.hoisted(() => ({ value: true }));
vi.mock('../platform/runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('../platform/runtime')>();
  return {
    ...original,
    isNativeShell: () => nativeShell.value,
  };
});

function mockFetch(routes: Record<string, { ok?: boolean; body?: string }>) {
  const calls: string[] = [];
  const impl = (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(new Response(route.body ?? '', { status: route.ok === false ? 500 : 200 }));
  };
  vi.stubGlobal('fetch', vi.fn(impl));
  return calls;
}

describe('installation integrity verification', () => {
  beforeEach(() => {
    localStorage.clear();
    nativeShell.value = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports ok when every file matches the manifest', async () => {
    const good = 'console.log("fine");';
    mockFetch({
      'integrity.json': { body: JSON.stringify({ files: { 'assets/index-1.js': sha256(good) } }) },
      'assets/index-1.js': { body: good },
    });
    const result = await verifyInstallation();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.corrupted).toEqual([]);
    expect(result!.missing).toEqual([]);
    expect(lastIntegrityResult()?.ok).toBe(true);
  });

  it('names the file whose bytes no longer match the release', async () => {
    const good = 'console.log("fine");';
    const onDisk = '%PDF-1.7 this is not javascript';
    mockFetch({
      'integrity.json': { body: JSON.stringify({ files: { 'assets/StudyMaterials-2.js': sha256(good) } }) },
      'assets/StudyMaterials-2.js': { body: onDisk },
    });
    const result = await verifyInstallation();
    expect(result!.ok).toBe(false);
    expect(result!.corrupted).toEqual(['assets/StudyMaterials-2.js']);
  });

  it('separates files that could not be fetched at all', async () => {
    const good = 'x';
    mockFetch({
      'integrity.json': { body: JSON.stringify({ files: { 'assets/gone.js': sha256(good) } }) },
      // assets/gone.js intentionally absent -> 404
    });
    const result = await verifyInstallation();
    expect(result!.ok).toBe(false);
    expect(result!.missing).toEqual(['assets/gone.js']);
    expect(result!.corrupted).toEqual([]);
  });

  it('returns null, not ok, when it cannot run', async () => {
    mockFetch({}); // integrity.json itself is missing
    expect(await verifyInstallation()).toBeNull();

    nativeShell.value = false; // the web app has nothing local to verify
    expect(await verifyInstallation()).toBeNull();
  });

  it('keeps a result that was never "ok" out of the "fine" path', () => {
    localStorage.setItem(
      'pharmatrack.integrity',
      JSON.stringify({ ok: false, corrupted: ['assets/x.js'], missing: [], checkedAt: 'now' }),
    );
    const result = lastIntegrityResult();
    expect(result?.ok).toBe(false);
    expect(result?.corrupted).toEqual(['assets/x.js']);
  });

  it('offers a repair command that reinstalls the release', () => {
    const hint = integrityRepairHint();
    expect(hint.length).toBeGreaterThan(20);
  });
});
