/**
 * Password gate for the Admin Examination Control Center and the Exam Builder.
 *
 * Students and invigilators run the same app; the only thing that separates
 * the admin console (and, since the builder lock, the exam builder) from a
 * curious student on the examination Wi-Fi is this gate. It is deliberately
 * simple and honest about what it is:
 *
 *   - The console password, the phantom PIN (the second secret that must be
 *     presented to change either password) and the builder password are each
 *     stored ONLY as a salted SHA-256 hash on this device — never in
 *     plaintext — and each has ITS OWN salt (see the note on record shape
 *     below for why that independence matters).
 *   - Unlocking is per browser tab (sessionStorage), so a reload in the same
 *     tab stays open while a fresh tab — e.g. a student navigating to the
 *     admin route — always starts at the lock screen.
 *   - The seed values below exist so the very first launch has a working
 *     password; they live in code, which means anyone holding the source can
 *     compute them. Change all of them from the console on first setup — the
 *     change paths re-salt and store only the new hash for the secret being
 *     changed.
 *   - This gates the local UI. It is not DRM: the invigilator's machine is
 *     the trusted device, the LAN authority already exposes no admin routes,
 *     and production kiosk builds compile developer tools out.
 */
import { randomBytes, sha256 } from './crypto';
import { get, set } from '../utils/idbStore';

const GATE_KEY = 'pharmatrack:admin-gate';
const UNLOCKED_FLAG = 'pharmatrack:admin-gate-unlocked';
const BUILDER_UNLOCKED_FLAG = 'pharmatrack:builder-gate-unlocked';

/**
 * Seed credentials configured at setup. Change all of them from the admin
 * console (changing any one requires the phantom PIN) before relying on the
 * gate.
 */
const DEFAULT_ADMIN_PASSWORD = 'godnogosHamEi2';
const DEFAULT_PHANTOM_PIN = 'iseedeAdpeople';
/** Seed password for the exam BUILDER's lock — a separate secret from the
 *  console password, so a builder leak never hands over the live console. */
const DEFAULT_BUILDER_PASSWORD = 'admin123';

/** Minimum length for a new console or builder password. */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

/**
 * Record shape, current version: every secret carries its OWN salt.
 *
 * This used to be one shared `salt` for all three hashes. That made the
 * three secrets silently entangled: changing the console password rotated
 * the shared salt (standard practice — a password change should get a fresh
 * salt), which recomputed passwordHash and phantomHash correctly, but there
 * was no plaintext builder password on hand at that moment to recompute
 * builderHash against the new salt — so it was left stale, and the stale
 * hash would never again match ANY builder password, correct or not. The
 * fix is structural, not a validation tweak: give each secret its own salt,
 * so rotating one can never affect the other two's stored hash at all.
 * loadGate() migrates old single-salt records in place.
 */
interface AdminGateRecord {
  passwordSalt: string;
  passwordHash: string;
  phantomSalt: string;
  phantomHash: string;
  builderSalt: string;
  builderHash: string;
  updatedAt: string;
}

/** Pre-migration shape (one shared salt for all three secrets). */
interface LegacyAdminGateRecord {
  salt: string;
  passwordHash: string;
  phantomHash: string;
  builderHash?: string;
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

function isCurrentShape(
  record: AdminGateRecord | LegacyAdminGateRecord,
): record is AdminGateRecord {
  return typeof (record as AdminGateRecord).passwordSalt === 'string';
}

async function loadGate(): Promise<AdminGateRecord> {
  const existing = await get<AdminGateRecord | LegacyAdminGateRecord>(GATE_KEY);

  if (existing && !isCurrentShape(existing) && existing.salt && existing.passwordHash && existing.phantomHash) {
    // Pre-migration record: reuse the one shared salt as each secret's own
    // salt, which keeps every already-stored hash valid (hashSecret(salt, x)
    // is unchanged), then split them apart so future changes never cross-
    // invalidate each other again. A record with no builderHash yet (saved
    // before the builder lock existed) gets the seed builder password.
    const migrated: AdminGateRecord = {
      passwordSalt: existing.salt,
      passwordHash: existing.passwordHash,
      phantomSalt: existing.salt,
      phantomHash: existing.phantomHash,
      builderSalt: existing.salt,
      builderHash: existing.builderHash ?? (await hashSecret(existing.salt, DEFAULT_BUILDER_PASSWORD)),
      updatedAt: new Date().toISOString(),
    };
    await set(GATE_KEY, migrated);
    return migrated;
  }

  if (existing && isCurrentShape(existing)) {
    // Already the current shape. Still patch a missing builder salt/hash —
    // defensive, in case a record is ever stored without one (e.g. partial
    // writes, or an old backup restored into a new build) — so the builder
    // gate is never permanently unanswerable without the invigilator even
    // knowing it is broken.
    if (!existing.builderSalt || !existing.builderHash) {
      const builderSalt = hex(randomBytes(16));
      const patched: AdminGateRecord = {
        ...existing,
        builderSalt,
        builderHash: await hashSecret(builderSalt, DEFAULT_BUILDER_PASSWORD),
        updatedAt: new Date().toISOString(),
      };
      await set(GATE_KEY, patched);
      return patched;
    }
    return existing;
  }

  const passwordSalt = hex(randomBytes(16));
  const phantomSalt = hex(randomBytes(16));
  const builderSalt = hex(randomBytes(16));
  const record: AdminGateRecord = {
    passwordSalt,
    passwordHash: await hashSecret(passwordSalt, DEFAULT_ADMIN_PASSWORD),
    phantomSalt,
    phantomHash: await hashSecret(phantomSalt, DEFAULT_PHANTOM_PIN),
    builderSalt,
    builderHash: await hashSecret(builderSalt, DEFAULT_BUILDER_PASSWORD),
    updatedAt: new Date().toISOString(),
  };
  await set(GATE_KEY, record);
  return record;
}

/** True only for the exact, non-empty password this device stores a hash of. */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (!password) return false;
  const gate = await loadGate();
  return (await hashSecret(gate.passwordSalt, password)) === gate.passwordHash;
}

/** True only for the exact, non-empty builder password this device stores. */
export async function verifyBuilderPassword(password: string): Promise<boolean> {
  if (!password) return false;
  const gate = await loadGate();
  return (await hashSecret(gate.builderSalt, password)) === gate.builderHash;
}

/** True only for the exact, non-empty phantom PIN this device stores. */
async function verifyPhantomPin(gate: AdminGateRecord, phantomPin: string): Promise<boolean> {
  if (!phantomPin) return false;
  return (await hashSecret(gate.phantomSalt, phantomPin)) === gate.phantomHash;
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

export function isBuilderGateUnlocked(): boolean {
  try {
    return sessionStorage.getItem(BUILDER_UNLOCKED_FLAG) === '1';
  } catch {
    return false;
  }
}

export function markBuilderGateUnlocked(): void {
  try {
    sessionStorage.setItem(BUILDER_UNLOCKED_FLAG, '1');
  } catch {
    // Storage may be unavailable; the in-memory state still gates this tab.
  }
}

export function lockBuilderGate(): void {
  try {
    sessionStorage.removeItem(BUILDER_UNLOCKED_FLAG);
  } catch {
    // Nothing meaningful to do; see markBuilderGateUnlocked.
  }
}

export type AdminPasswordChangeResult =
  | { ok: true }
  | { ok: false; error: 'wrong-password' | 'wrong-phantom-pin' | 'invalid-new-password' };

/**
 * Change the console password. Requires the current password AND the phantom
 * PIN. Only the console password's own salt and hash are rotated — the
 * phantom PIN and the builder password keep working completely unchanged,
 * because they live under their own independent salts.
 */
export async function changeAdminPassword(
  currentPassword: string,
  nextPassword: string,
  phantomPin: string,
): Promise<AdminPasswordChangeResult> {
  if (nextPassword.trim().length < MIN_ADMIN_PASSWORD_LENGTH)
    return { ok: false, error: 'invalid-new-password' };
  const gate = await loadGate();
  if ((await hashSecret(gate.passwordSalt, currentPassword)) !== gate.passwordHash)
    return { ok: false, error: 'wrong-password' };
  if (!(await verifyPhantomPin(gate, phantomPin))) return { ok: false, error: 'wrong-phantom-pin' };
  const passwordSalt = hex(randomBytes(16));
  const record: AdminGateRecord = {
    ...gate,
    passwordSalt,
    passwordHash: await hashSecret(passwordSalt, nextPassword),
    updatedAt: new Date().toISOString(),
  };
  await set(GATE_KEY, record);
  return { ok: true };
}

/**
 * Change the exam builder's password. Authorised by the CURRENT builder
 * password plus the phantom PIN — the same two-secret rule as the console
 * password. Only the builder's own salt and hash are rotated: the console
 * password and the phantom PIN keep working unchanged.
 */
export async function changeBuilderPassword(
  currentBuilderPassword: string,
  nextBuilderPassword: string,
  phantomPin: string,
): Promise<AdminPasswordChangeResult> {
  if (nextBuilderPassword.trim().length < MIN_ADMIN_PASSWORD_LENGTH)
    return { ok: false, error: 'invalid-new-password' };
  const gate = await loadGate();
  if ((await hashSecret(gate.builderSalt, currentBuilderPassword)) !== gate.builderHash)
    return { ok: false, error: 'wrong-password' };
  if (!(await verifyPhantomPin(gate, phantomPin))) return { ok: false, error: 'wrong-phantom-pin' };
  const builderSalt = hex(randomBytes(16));
  const record: AdminGateRecord = {
    ...gate,
    builderSalt,
    builderHash: await hashSecret(builderSalt, nextBuilderPassword),
    updatedAt: new Date().toISOString(),
  };
  await set(GATE_KEY, record);
  return { ok: true };
}
