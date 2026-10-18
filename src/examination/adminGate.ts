/**
 * Password gate for the Admin Examination Control Center.
 *
 * Students and invigilators run the same app; the only thing that separates
 * the admin console from a curious student on the examination Wi-Fi is this
 * gate. It is deliberately simple and honest about what it is:
 *
 *   - The console password and the phantom PIN (the second secret that must
 *     be presented to change the password) are stored ONLY as salted SHA-256
 *     hashes on this device — never in plaintext.
 *   - Unlocking is per browser tab (sessionStorage), so a reload in the same
 *     tab stays open while a fresh tab — e.g. a student navigating to the
 *     admin route — always starts at the lock screen.
 *   - The seed values below exist so the very first launch has a working
 *     password; they live in code, which means anyone holding the source can
 *     compute them. Change both from the console on first setup — the change
 *     path re-salts and stores only the new hashes.
 *   - This gates the local UI. It is not DRM: the invigilator's machine is
 *     the trusted device, the LAN authority already exposes no admin routes,
 *     and production kiosk builds compile developer tools out.
 */
import { randomBytes, sha256 } from './crypto';
import { get, set } from '../utils/idbStore';

const GATE_KEY = 'pharmatrack:admin-gate';
const UNLOCKED_FLAG = 'pharmatrack:admin-gate-unlocked';

/**
 * Seed credentials configured at setup. Change both from the admin console
 * (change requires the phantom PIN) before relying on the gate.
 */
const DEFAULT_ADMIN_PASSWORD = 'godnogosHamEi2';
const DEFAULT_PHANTOM_PIN = 'iseedeAdpeople';

/** Minimum length for a new console password. */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

interface AdminGateRecord {
  salt: string;
  passwordHash: string;
  phantomHash: string;
  updatedAt: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashSecret(salt: string, secret: string): Promise<string> {
  // The prefix ties the hash to this exact purpose, so a hash lifted from
  // another record in the store cannot be replayed here.
  return sha256(`${salt}:pharmatrack-admin-gate:${secret}`);
}

async function loadGate(): Promise<AdminGateRecord> {
  const existing = await get<AdminGateRecord>(GATE_KEY);
  if (existing && existing.salt && existing.passwordHash && existing.phantomHash) return existing;
  const salt = hex(randomBytes(16));
  const record: AdminGateRecord = {
    salt,
    passwordHash: await hashSecret(salt, DEFAULT_ADMIN_PASSWORD),
    phantomHash: await hashSecret(salt, DEFAULT_PHANTOM_PIN),
    updatedAt: new Date().toISOString(),
  };
  await set(GATE_KEY, record);
  return record;
}

/** True only for the exact, non-empty password this device stores a hash of. */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (!password) return false;
  const gate = await loadGate();
  return (await hashSecret(gate.salt, password)) === gate.passwordHash;
}

export function isAdminGateUnlocked(): boolean {
  try {
    return sessionStorage.getItem(UNLOCKED_FLAG) === '1';
  } catch {
    return false;
  }
}

export function markAdminGateUnlocked(): void {
  try {
    sessionStorage.setItem(UNLOCKED_FLAG, '1');
  } catch {
    // Storage may be unavailable (private mode quirks); the in-memory state
    // still gates this tab's rendering.
  }
}

export function lockAdminGate(): void {
  try {
    sessionStorage.removeItem(UNLOCKED_FLAG);
  } catch {
    // Nothing meaningful to do; see markAdminGateUnlocked.
  }
}

export type AdminPasswordChangeResult =
  | { ok: true }
  | { ok: false; error: 'wrong-password' | 'wrong-phantom-pin' | 'invalid-new-password' };

/**
 * Change the console password. Requires the current password AND the phantom
 * PIN; on success the salt is rotated and only the new hashes are stored, so
 * the old password stops working immediately.
 */
export async function changeAdminPassword(
  currentPassword: string,
  nextPassword: string,
  phantomPin: string,
): Promise<AdminPasswordChangeResult> {
  if (nextPassword.trim().length < MIN_ADMIN_PASSWORD_LENGTH)
    return { ok: false, error: 'invalid-new-password' };
  const gate = await loadGate();
  if ((await hashSecret(gate.salt, currentPassword)) !== gate.passwordHash)
    return { ok: false, error: 'wrong-password' };
  if ((await hashSecret(gate.salt, phantomPin)) !== gate.phantomHash)
    return { ok: false, error: 'wrong-phantom-pin' };
  const salt = hex(randomBytes(16));
  const record: AdminGateRecord = {
    salt,
    passwordHash: await hashSecret(salt, nextPassword),
    phantomHash: await hashSecret(salt, phantomPin),
    updatedAt: new Date().toISOString(),
  };
  await set(GATE_KEY, record);
  return { ok: true };
}
