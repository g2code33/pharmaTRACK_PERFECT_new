import * as idb from '../utils/idbStore';
import { randomBytes } from './crypto';
import { asCryptoBuffer } from './cryptoBuffer';

export const EXAM_DEVICE_KEY = 'pharmatrack_exam_device_key_v1';

// ---------------------------------------------------------------------------
// Last-resort localStorage fallback — OPT IN ONLY.
//
// `idbStore.ts` already self-heals a TRANSIENT IndexedDB failure (a wedged
// cold-start connection on WebKitGTK, etc.) by discarding the connection and
// retrying once against a fresh one. What it cannot fix is a device where
// IndexedDB genuinely never works at all for the lifetime of this session —
// seen in the wild on some Windows WebView2 profiles (locked-down group
// policy, a corrupted profile directory, endpoint-protection software
// intercepting storage APIs, …). Before this fallback, that showed up as the
// exam readiness screen permanently stuck on "Local encrypted storage
// unavailable" with no way forward for the student, even though the exam
// itself has nothing to do with IndexedDB specifically — it only needs SOME
// place on this device to keep small encrypted JSON blobs.
//
// This module is shared by more than just exam data — `ai/credentials.ts`
// (provider API keys) and `ai/accountSync.ts` (device session) also encrypt
// through the exact same saveEncryptedJson/loadEncryptedJson. Those callers
// have their own deliberate "fail loudly, never silently redirect" contract
// (storageManager.ts's versioned-migration rollback logic specifically
// depends on a credential write failure staying a failure). So the fallback
// below only activates for a call that explicitly opts in via
// `{ allowLocalStorageFallback: true }` — today that is only the
// examination flow (exam state, the staged package cache, the kiosk result
// outbox, and the readiness probe). Every other caller behaves EXACTLY as
// it did before this existed: a real IndexedDB failure still propagates.
// ---------------------------------------------------------------------------
const LOCAL_STORAGE_FALLBACK_PREFIX = 'pharmatrack:examfallback:';
// Generous for one exam's encrypted state, deliberately bounded so a large
// admin device (many imported exams/question banks) never risks blowing
// through localStorage's much smaller per-origin quota just mirroring data
// that IndexedDB is already holding fine — the mirror is a convenience
// safety net, not a replacement, so it is allowed to just skip when huge.
const LOCAL_STORAGE_MIRROR_MAX_CHARS = 1_500_000;

// Latched only by (and only consulted for) calls that opted into the
// fallback — an unrelated caller's own simulated/real failure never flips
// this, and this flag never short-circuits a non-opted-in caller's own
// fresh attempt against IndexedDB.
let indexedDbBrokenForFallbackCallers = false;

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function localStorageGet<T>(key: string): T | undefined {
  const raw = localStorage.getItem(LOCAL_STORAGE_FALLBACK_PREFIX + key);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function localStorageSet(key: string, value: unknown): void {
  localStorage.setItem(LOCAL_STORAGE_FALLBACK_PREFIX + key, JSON.stringify(value));
}

function localStorageDel(key: string): void {
  localStorage.removeItem(LOCAL_STORAGE_FALLBACK_PREFIX + key);
}

/**
 * Best-effort copy into localStorage made every time IndexedDB itself still
 * succeeds, for a fallback-enabled write. This is what lets a read keep
 * working even if IndexedDB starts failing ONLY on reads (not writes)
 * partway through a session, or fails for the first time on the very next
 * call after this one — without it, the fallback would have nothing to
 * serve until the next successful write. A failure here (quota,
 * unavailable, oversized payload) is silently ignored: the real write
 * already succeeded through the primary backend.
 */
function mirrorToLocalStorageBestEffort(key: string, value: unknown): void {
  if (!hasLocalStorage()) return;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > LOCAL_STORAGE_MIRROR_MAX_CHARS) return;
    localStorage.setItem(LOCAL_STORAGE_FALLBACK_PREFIX + key, serialized);
  } catch {
    /* best-effort only */
  }
}

interface StorageOptions {
  /** Opt in to a localStorage fallback when IndexedDB itself is unusable. */
  allowLocalStorageFallback?: boolean;
}

async function storageGet<T>(key: string, opts: StorageOptions): Promise<T | undefined> {
  const useFallback = opts.allowLocalStorageFallback === true;
  if (!useFallback || !indexedDbBrokenForFallbackCallers) {
    try {
      return await idb.get<T>(key);
    } catch (error) {
      if (!useFallback) throw error; // unchanged behavior for non-opted-in callers
      indexedDbBrokenForFallbackCallers = true;
      console.error('IndexedDB read failed; falling back to local storage for exam data:', error);
    }
  }
  // Reaching here means a fallback-enabled caller has hit a broken
  // IndexedDB. If this device has no usable storage backend at all,
  // propagate the failure so callers with their own recovery (e.g.
  // storage.ts's in-memory cache) still get the chance to run, exactly as
  // before this fallback existed.
  if (!hasLocalStorage()) {
    throw new Error('Neither IndexedDB nor local storage is available on this device.');
  }
  return localStorageGet<T>(key);
}

async function storageSet(key: string, value: unknown, opts: StorageOptions): Promise<void> {
  const useFallback = opts.allowLocalStorageFallback === true;
  if (!useFallback || !indexedDbBrokenForFallbackCallers) {
    try {
      await idb.set(key, value);
      if (useFallback) mirrorToLocalStorageBestEffort(key, value);
      return;
    } catch (error) {
      if (!useFallback) throw error; // unchanged behavior for non-opted-in callers
      indexedDbBrokenForFallbackCallers = true;
      console.error('IndexedDB write failed; falling back to local storage for exam data:', error);
    }
  }
  // IndexedDB is (now) considered broken for fallback-enabled callers —
  // localStorage is the only remaining backend, so a failure here
  // (unavailable, genuinely full) is a real, total failure and must
  // propagate, exactly like an unrecovered IndexedDB failure always did.
  localStorageSet(key, value);
}

async function storageDel(key: string, opts: StorageOptions): Promise<void> {
  const useFallback = opts.allowLocalStorageFallback === true;
  if (!useFallback || !indexedDbBrokenForFallbackCallers) {
    try {
      await idb.del(key);
      if (useFallback && hasLocalStorage()) {
        try {
          localStorageDel(key);
        } catch {
          /* best-effort mirror cleanup only */
        }
      }
      return;
    } catch (error) {
      if (!useFallback) throw error; // unchanged behavior for non-opted-in callers
      indexedDbBrokenForFallbackCallers = true;
      console.error('IndexedDB delete failed; falling back to local storage for exam data:', error);
    }
  }
  if (hasLocalStorage()) localStorageDel(key);
}

/** Exposed for tests that need to force/inspect the fallback path. */
export const __storageFallback = {
  isActive: () => indexedDbBrokenForFallbackCallers,
  reset: () => {
    indexedDbBrokenForFallbackCallers = false;
  },
};

interface EncryptedRecord {
  encrypted: true;
  algorithm: 'AES-GCM-256';
  iv: string;
  ciphertext: string;
}

interface RawDeviceKeyRecord {
  format: 'raw-aes-gcm-256';
  key: string;
  createdAt: string;
}

type StoredDeviceKey = CryptoKey | RawDeviceKeyRecord | string;

function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof CryptoKey !== 'undefined' &&
    value instanceof CryptoKey &&
    value.type === 'secret' &&
    value.algorithm?.name === 'AES-GCM'
  );
}

function isRawDeviceKeyRecord(value: unknown): value is RawDeviceKeyRecord {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as RawDeviceKeyRecord).format === 'raw-aes-gcm-256' &&
    typeof (value as RawDeviceKeyRecord).key === 'string',
  );
}

async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asCryptoBuffer(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function createRawDeviceKey(opts: StorageOptions): Promise<CryptoKey> {
  const raw = randomBytes(32);
  const record: RawDeviceKeyRecord = {
    format: 'raw-aes-gcm-256',
    key: base64(raw),
    createdAt: new Date().toISOString(),
  };
  await storageSet(EXAM_DEVICE_KEY, record, opts);
  return importRawKey(raw);
}

async function resolveDeviceKey(opts: StorageOptions): Promise<CryptoKey> {
  const existing = await storageGet<StoredDeviceKey>(EXAM_DEVICE_KEY, opts);
  if (isCryptoKey(existing)) {
    // Legacy WebCrypto CryptoKeys can be read on some engines. Keep using it
    // for records encrypted with it, but new installs use the raw wrapped form
    // below because WebKit/Tauri can fail to structured-clone CryptoKey values.
    return existing;
  }
  if (isRawDeviceKeyRecord(existing)) {
    return importRawKey(bytes(existing.key));
  }
  if (typeof existing === 'string' && existing) {
    return importRawKey(bytes(existing));
  }
  return createRawDeviceKey(opts);
}

// `deviceKey()` used to re-read (and, on a brand-new device, re-CREATE) the
// key on every single call with NO coordination at all. The very first
// moments after opening the app fire off several storage reads/writes
// almost simultaneously (the kiosk's staged-package restore, examination
// state load, a device session write, ...). On a device with no key yet,
// two of those calls could each see "no key exists" and each generate and
// save their OWN random key — whichever save wins last becomes the only key
// from then on, silently leaving anything already encrypted under the
// loser's key undecryptable forever. That is a textbook match for "first
// time registration doesn't work right" and "an old registration can't log
// in anymore": the record was written correctly, just under a key nothing
// can produce again.
//
// The fix is to serialize calls through a chain (the same pattern
// `ExaminationRepository.writeChain` already uses for exam state writes),
// NOT to permanently cache the resolved key. Every call still does a real
// read — cheap, side-effect-free, and correctly notices if the underlying
// key record ever legitimately changes (e.g. a device whose storage was
// cleared while the page kept running) — but only one resolution is ever
// "in flight" at a time, so two callers racing to create a first-ever key
// are forced to run one after another: the second one's read will see the
// key the first one just created instead of also creating its own.
let deviceKeyChain: Promise<unknown> = Promise.resolve();

function deviceKey(opts: StorageOptions): Promise<CryptoKey> {
  const next = deviceKeyChain
    // A previous caller's failure must not permanently block every later
    // call — only that one call should see the error.
    .catch(() => undefined)
    .then(() => resolveDeviceKey(opts));
  deviceKeyChain = next.catch(() => undefined);
  return next;
}

export async function saveEncryptedJson<T>(key: string, value: T, opts: StorageOptions = {}): Promise<void> {
  const iv = randomBytes(12);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asCryptoBuffer(iv) },
    await deviceKey(opts),
    asCryptoBuffer(new TextEncoder().encode(JSON.stringify(value))),
  );
  const record: EncryptedRecord = {
    encrypted: true,
    algorithm: 'AES-GCM-256',
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  };
  await storageSet(key, record, opts);
}

export async function loadEncryptedJson<T>(key: string, opts: StorageOptions = {}): Promise<T | null> {
  const record = await storageGet<EncryptedRecord | T>(key, opts);
  if (record == null) return null;
  // Migration: Phase 1 could have written a structured record before the
  // encrypted wrapper was introduced. Read it without destroying it; the next
  // successful save upgrades it to encrypted storage.
  if (!(
    typeof record === 'object' &&
    record !== null &&
    'encrypted' in record &&
    (record as EncryptedRecord).encrypted === true
  )) {
    return record as T;
  }
  const encrypted = record as EncryptedRecord;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asCryptoBuffer(bytes(encrypted.iv)) },
    await deviceKey(opts),
    asCryptoBuffer(bytes(encrypted.ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Deletes one encrypted key, through the same IndexedDB→localStorage fallback as everything else here. */
export async function deleteEncryptedJson(key: string, opts: StorageOptions = {}): Promise<void> {
  await storageDel(key, opts);
}

/**
 * Reports whether this device can durably persist exam data at all. Always
 * exercises the localStorage fallback path (if IndexedDB can't) — a device
 * whose IndexedDB is genuinely broken but whose localStorage works is still
 * "ready", just backed differently; only a device with NEITHER should block
 * exam entry.
 */
export async function encryptedStorageAvailable(): Promise<boolean> {
  try {
    const probeKey = `pharmatrack_exam_probe_${Date.now()}`;
    await saveEncryptedJson(probeKey, { ok: true }, { allowLocalStorageFallback: true });
    await deleteEncryptedJson(probeKey, { allowLocalStorageFallback: true });
    return true;
  } catch {
    return false;
  }
}
