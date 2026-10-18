import * as idb from '../utils/idbStore';
import { randomBytes } from './crypto';
import { asCryptoBuffer } from './cryptoBuffer';

export const EXAM_DEVICE_KEY = 'pharmatrack_exam_device_key_v1';

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

async function createRawDeviceKey(): Promise<CryptoKey> {
  const raw = randomBytes(32);
  const record: RawDeviceKeyRecord = {
    format: 'raw-aes-gcm-256',
    key: base64(raw),
    createdAt: new Date().toISOString(),
  };
  await idb.set(EXAM_DEVICE_KEY, record);
  return importRawKey(raw);
}

async function deviceKey(): Promise<CryptoKey> {
  const existing = await idb.get<StoredDeviceKey>(EXAM_DEVICE_KEY);
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
  return createRawDeviceKey();
}

export async function saveEncryptedJson<T>(key: string, value: T): Promise<void> {
  const iv = randomBytes(12);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asCryptoBuffer(iv) },
    await deviceKey(),
    asCryptoBuffer(new TextEncoder().encode(JSON.stringify(value))),
  );
  const record: EncryptedRecord = {
    encrypted: true,
    algorithm: 'AES-GCM-256',
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  };
  await idb.set(key, record);
}

export async function loadEncryptedJson<T>(key: string): Promise<T | null> {
  const record = await idb.get<EncryptedRecord | T>(key);
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
    await deviceKey(),
    asCryptoBuffer(bytes(encrypted.ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function encryptedStorageAvailable(): Promise<boolean> {
  try {
    const probeKey = `pharmatrack_exam_probe_${Date.now()}`;
    await saveEncryptedJson(probeKey, { ok: true });
    await idb.del(probeKey);
    return true;
  } catch {
    return false;
  }
}
