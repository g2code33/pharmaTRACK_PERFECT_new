/** Offline cryptographic helpers for examination identity and packages. */

import { asCryptoBuffer } from './cryptoBuffer';
import type { PasswordVerifier } from './types';

const textEncoder = () => new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomId(prefix = 'id'): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid}`;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? textEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', asCryptoBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestJson(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

export const PBKDF2_ITERATIONS =
  typeof process !== 'undefined' && process.env?.NODE_ENV === 'test' ? 100 : 210_000;

export async function derivePasswordVerifier(
  password: string,
  salt = bytesToBase64(randomBytes(16)),
): Promise<PasswordVerifier> {
  const material = await crypto.subtle.importKey(
    'raw',
    asCryptoBuffer(textEncoder().encode(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: asCryptoBuffer(base64ToBytes(salt)),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    256,
  );
  return {
    algorithm: 'PBKDF2-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt,
    verifier: bytesToBase64(new Uint8Array(bits)),
  };
}

export async function verifyPassword(
  password: string,
  verifier: PasswordVerifier,
): Promise<boolean> {
  if (verifier.algorithm !== 'PBKDF2-SHA-256') return false;
  const material = await crypto.subtle.importKey(
    'raw',
    asCryptoBuffer(textEncoder().encode(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: asCryptoBuffer(base64ToBytes(verifier.salt)),
      iterations: verifier.iterations,
      hash: 'SHA-256',
    },
    material,
    256,
  );
  const actual = new Uint8Array(bits);
  const expected = base64ToBytes(verifier.verifier);
  if (actual.length !== expected.length) return false;
  let different = 0;
  for (let i = 0; i < actual.length; i += 1) different |= actual[i] ^ expected[i];
  return different === 0;
}

export function sequentialKioskPassword(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0)
    throw new Error('Kiosk sequence must be a non-negative integer.');
  let value = sequence;
  let suffix = '';
  do {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `RX30${suffix}`;
}

/**
 * Picks a RANDOM, not-yet-issued RX30 kiosk password instead of handing
 * them out in strict registration order.
 *
 * A purely sequential scheme (1st student registered gets RX30a, 2nd gets
 * RX30b, ...) needs no technical skill at all to attack: anyone who simply
 * watches the registration queue in the room can guess a classmate's kiosk
 * password from their position in line. Randomizing which slot each
 * student gets removes that guess, while still handing out every
 * single-letter slot (a..z — 26 of them) before any two-letter slot, so
 * passwords stay as short as the sequential scheme for as long as possible
 * — exactly the same "complete a, b, c ... before aa, ab, ac" shape as
 * {@link sequentialKioskPassword}, just drawn in random order within each
 * shell rather than in order.
 *
 * `usedSlots` is the set of slot numbers already handed out — not the
 * passwords themselves, which this app never stores in any recoverable
 * form. Each call returns a slot that has not appeared in `usedSlots`.
 */
export function randomUnusedKioskPassword(
  usedSlots: readonly number[],
): { password: string; slot: number } {
  const used = new Set(usedSlots);
  let shellStart = 0;
  let shellSize = 26;
  // A shell this loop cannot exhaust in practice (26^30 slots) — the cap
  // only exists so a corrupted `usedSlots` list fails loudly instead of
  // spinning forever.
  for (let shell = 0; shell < 30; shell += 1) {
    const free: number[] = [];
    for (let i = 0; i < shellSize; i += 1) {
      const slot = shellStart + i;
      if (!used.has(slot)) free.push(slot);
    }
    if (free.length > 0) {
      const slot = free[Math.floor(Math.random() * free.length)];
      return { password: sequentialKioskPassword(slot), slot };
    }
    shellStart += shellSize;
    shellSize *= 26;
  }
  throw new Error('The kiosk password space is exhausted.');
}

export function normalizeLevel(level: string): string {
  const match = level.match(/(?:level\s*)?(100|200|300|400|500|600)/i);
  return match ? `Level ${match[1]}` : '';
}
