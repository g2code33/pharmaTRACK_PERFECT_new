/**
 * Account-recoverable AI secret encryption.
 *
 * The account password is used only at login/unlock time to derive a non-
 * extractable AES-GCM key. The password and derived key are never persisted.
 * Server records contain only authenticated ciphertext and an IV; the server
 * cannot decrypt provider credentials.
 */

import { asCryptoBuffer } from '../examination/cryptoBuffer';

export const ACCOUNT_VAULT_KDF = 'PBKDF2-SHA-256';
export const ACCOUNT_VAULT_KDF_ITERATIONS = 310_000;
export const ACCOUNT_VAULT_ALGORITHM = 'AES-GCM-256';

export interface EncryptedSecretEnvelope {
  version: 1;
  algorithm: typeof ACCOUNT_VAULT_ALGORITHM;
  iv: string;
  ciphertext: string;
  aad: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  const result = new Uint8Array(length);
  crypto.getRandomValues(result);
  return result;
}

export function createVaultSalt(): string {
  return toBase64(randomBytes(16));
}

export async function deriveAccountVaultKey(password: string, salt: string): Promise<CryptoKey> {
  if (!password) throw new Error('A password is required to unlock the account AI vault.');
  const material = await crypto.subtle.importKey(
    'raw',
    asCryptoBuffer(new TextEncoder().encode(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: asCryptoBuffer(fromBase64(salt)),
      iterations: ACCOUNT_VAULT_KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptAccountSecret(
  key: CryptoKey,
  value: unknown,
  aad: string,
): Promise<EncryptedSecretEnvelope> {
  const iv = randomBytes(12);
  const additionalData = new TextEncoder().encode(aad);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: asCryptoBuffer(iv),
      additionalData: asCryptoBuffer(additionalData),
      tagLength: 128,
    },
    key,
    asCryptoBuffer(new TextEncoder().encode(JSON.stringify(value))),
  );
  return {
    version: 1,
    algorithm: ACCOUNT_VAULT_ALGORITHM,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    aad,
  };
}

export async function decryptAccountSecret<T>(
  key: CryptoKey,
  envelope: EncryptedSecretEnvelope,
  expectedAad?: string,
): Promise<T> {
  if (!isEncryptedSecretEnvelope(envelope)) {
    throw new Error('Malformed account secret envelope.');
  }
  if (expectedAad !== undefined && envelope.aad !== expectedAad) {
    throw new Error('Account secret envelope binding does not match the provider.');
  }
  if (envelope.version !== 1 || envelope.algorithm !== ACCOUNT_VAULT_ALGORITHM) {
    throw new Error('Unsupported account secret envelope.');
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asCryptoBuffer(fromBase64(envelope.iv)),
      additionalData: asCryptoBuffer(new TextEncoder().encode(envelope.aad)),
      tagLength: 128,
    },
    key,
    asCryptoBuffer(fromBase64(envelope.ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export function isEncryptedSecretEnvelope(value: unknown): value is EncryptedSecretEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EncryptedSecretEnvelope>;
  return (
    candidate.version === 1 &&
    candidate.algorithm === ACCOUNT_VAULT_ALGORITHM &&
    typeof candidate.iv === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.aad === 'string'
  );
}
