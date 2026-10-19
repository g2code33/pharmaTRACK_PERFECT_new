import JSZip from 'jszip';
import {
  canonicalJson,
  digestJson,
  derivePasswordVerifier,
  randomBytes,
  randomId,
  sha256,
  verifyPassword,
  PBKDF2_ITERATIONS,
} from './crypto';
import { readBlobArrayBuffer } from '../utils/fileGuard';
import type { ExamSecuritySettings, ExamVersion, ExaminationState } from './types';
import { EXAM_PACKAGE_FORMAT_VERSION } from './types';
import { asCryptoBuffer } from './cryptoBuffer';

const encoder = new TextEncoder();

/**
 * The distributed .pharmaexam file is an encrypted envelope, never a plain
 * ZIP on disk.
 *
 * Earlier builds shipped the signed ZIP archive byte-for-byte as the
 * ".pharmaexam" file. The archive signature (`PK\x03\x04`) is what every OS,
 * file manager and generic archive tool sniffs to recognise "this is a ZIP"
 * — so the file showed a ZIP icon, offered "Extract here", and a curious
 * student could rename it to .zip and read every question (and in some
 * exam setups, the answer key) in plain JSON before ever opening the app.
 *
 * The envelope below wraps the whole ZIP in AES-256-GCM, keyed from an
 * app-embedded passphrase via PBKDF2 with a random per-file salt and IV.
 * Once encrypted, the bytes no longer start with a ZIP signature at all —
 * generic archive tools, "Extract here" menus, and OS content-sniffers all
 * see opaque ciphertext, not a ZIP. This is honest about what it defends:
 * it stops casual extraction and OS/file-manager misidentification, the
 * same way the previous proprietary extension was *supposed* to but
 * couldn't because the bytes gave it away. It is not a substitute for the
 * exam's own digital signature and (where configured) its password — those
 * still gate whether an attempt may actually start. Packages built before
 * this version remain readable: the loader only decrypts when the envelope
 * header is present, and falls back to the legacy raw-ZIP path otherwise.
 */
const PHARMAEXAM_ENVELOPE_MAGIC = encoder.encode('PHEX1');
const PHARMAEXAM_ENVELOPE_VERSION = 1;
// Not a user secret and not meant to be one — it exists so the file format
// itself is opaque to generic tools, not to hide the key from the app that
// ships it. See the comment above for exactly what this does and does not
// defend against.
const PHARMAEXAM_FORMAT_PASSPHRASE =
  'pharmatrack.examination.envelope.v1::0f3b9a2c6e8d41f7b5a0c3d9e2f61784';

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function isPharmaExamEnvelope(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PHARMAEXAM_ENVELOPE_MAGIC.byteLength) return false;
  for (let i = 0; i < PHARMAEXAM_ENVELOPE_MAGIC.byteLength; i += 1) {
    if (bytes[i] !== PHARMAEXAM_ENVELOPE_MAGIC[i]) return false;
  }
  return true;
}

async function deriveEnvelopeKey(salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    asCryptoBuffer(encoder.encode(PHARMAEXAM_FORMAT_PASSPHRASE)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asCryptoBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wraps raw ZIP bytes in the encrypted envelope. Exported for tooling and
 *  tests that need to legitimately rebuild a package after editing its
 *  contents (e.g. tamper-detection tests) — ordinary callers only ever go
 *  through {@link createPharmaExamPackage}. */
export async function encryptPharmaExamEnvelope(zipBytes: Uint8Array): Promise<Uint8Array> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveEnvelopeKey(salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asCryptoBuffer(iv) }, key, asCryptoBuffer(zipBytes)),
  );
  return concatBytes(
    PHARMAEXAM_ENVELOPE_MAGIC,
    Uint8Array.of(PHARMAEXAM_ENVELOPE_VERSION),
    salt,
    iv,
    ciphertext,
  );
}

/** Inverse of {@link encryptPharmaExamEnvelope}; recovers the raw ZIP bytes. */
export async function decryptPharmaExamEnvelope(envelope: Uint8Array): Promise<Uint8Array> {
  const magicLen = PHARMAEXAM_ENVELOPE_MAGIC.byteLength;
  const version = envelope[magicLen];
  if (version !== PHARMAEXAM_ENVELOPE_VERSION)
    throw new Error(`Unsupported examination package envelope version ${version}.`);
  let offset = magicLen + 1;
  const salt = envelope.subarray(offset, offset + 16);
  offset += 16;
  const iv = envelope.subarray(offset, offset + 12);
  offset += 12;
  const ciphertext = envelope.subarray(offset);
  const key = await deriveEnvelopeKey(salt);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asCryptoBuffer(iv) },
      key,
      asCryptoBuffer(ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error('This examination package is corrupted or was not created by PharmaTRACK.');
  }
}

async function toInputBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await readBlobArrayBuffer(input));
}

export interface ExamInstitutionInfo {
  name: string;
  code?: string;
  campus?: string;
  contact?: string;
}

export interface PharmaExamManifest {
  app: 'pharmatrack';
  format: 'pharmaexam';
  formatVersion: number;
  packageId: string;
  examId: string;
  examVersionId: string;
  examVersion: number;
  title: string;
  assessmentType: ExamVersion['assessmentType'];
  createdAt: string;
  immutable: true;
  integrity: {
    algorithm: 'SHA-256';
    packageDigest: string;
    signatureAlgorithm: 'ECDSA-P256-SHA-256';
  };
}

export interface PharmaExamIntegrity {
  algorithm: 'SHA-256';
  entries: Record<string, { size: number; sha256: string }>;
  packageDigest: string;
  signatureAlgorithm: 'ECDSA-P256-SHA-256';
  publicKeyJwk: JsonWebKey;
  signature: string;
}

export interface PharmaExamPackage {
  manifest: PharmaExamManifest;
  exam: ExamVersion;
  security: {
    settings: ExamSecuritySettings;
    examPasswordVerifier?: Awaited<ReturnType<typeof derivePasswordVerifier>>;
    /** Optional verifier for manual early exit; never the student RX30 verifier. */
    adminExitPasswordVerifier?: Awaited<ReturnType<typeof derivePasswordVerifier>>;
  };
  institution: ExamInstitutionInfo;
  questions: ExamVersion['questions'];
  blob: Blob;
  filename: string;
}

export interface StagedPharmaExam {
  manifest: PharmaExamManifest;
  exam: ExamVersion;
  questions: ExamVersion['questions'];
  security: PharmaExamPackage['security'];
  institution: ExamInstitutionInfo;
  integrity: PharmaExamIntegrity;
  packageKey: string;
}

export interface PackageValidationOptions {
  trustedPublicKeyJwk?: JsonWebKey;
  expectedExamVersionId?: string;
  expectedPackageId?: string;
}

export interface PackageValidationResult {
  ok: boolean;
  staged?: StagedPharmaExam;
  errors: string[];
  warnings: string[];
}

function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function bytesOf(value: string | Uint8Array | Blob): Promise<Uint8Array> {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return new Uint8Array(await readBlobArrayBuffer(value));
}

async function textOf(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`Missing ${name}.`);
  return entry.async('string');
}

async function jsonOf<T>(zip: JSZip, name: string): Promise<T> {
  return JSON.parse(await textOf(zip, name)) as T;
}

export async function generateExamSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]) as Promise<CryptoKeyPair>;
}

async function signPayload(payload: string, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    asCryptoBuffer(encoder.encode(payload)),
  );
  return base64(new Uint8Array(signature));
}

async function verifyPayload(
  payload: string,
  signature: string,
  publicKeyJwk: JsonWebKey,
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      asCryptoBuffer(fromBase64(signature)),
      asCryptoBuffer(encoder.encode(payload)),
    );
  } catch {
    return false;
  }
}

function unsignedManifest(input: {
  packageId: string;
  version: ExamVersion;
  createdAt: string;
}): Omit<PharmaExamManifest, 'integrity'> {
  return {
    app: 'pharmatrack',
    format: 'pharmaexam',
    formatVersion: EXAM_PACKAGE_FORMAT_VERSION,
    packageId: input.packageId,
    examId: input.version.examId,
    examVersionId: input.version.id,
    examVersion: input.version.version,
    title: input.version.title,
    assessmentType: input.version.assessmentType,
    createdAt: input.createdAt,
    immutable: true,
  };
}

function packageKey(
  manifest: Pick<PharmaExamManifest, 'packageId' | 'examVersionId' | 'integrity'>,
): string {
  return `${manifest.packageId}:${manifest.examVersionId}:${manifest.integrity.packageDigest}`;
}

export function packageKeyOf(manifest: PharmaExamManifest): string {
  return packageKey(manifest);
}

export function isDuplicateExamPackage(
  state: ExaminationState,
  manifest: PharmaExamManifest,
): boolean {
  return state.importedPackageKeys.includes(packageKeyOf(manifest));
}

export function markExamPackageImported(
  state: ExaminationState,
  manifest: PharmaExamManifest,
): ExaminationState {
  const key = packageKeyOf(manifest);
  return state.importedPackageKeys.includes(key)
    ? state
    : { ...state, importedPackageKeys: [...state.importedPackageKeys, key] };
}

export async function createPharmaExamPackage(input: {
  version: ExamVersion;
  institution: ExamInstitutionInfo;
  signingKey: CryptoKeyPair;
  packageId?: string;
  examPassword?: string;
  /** Separate examination-administrator credential, never RX30. */
  adminExitPassword?: string;
  assets?: Record<string, string | Uint8Array | Blob>;
}): Promise<PharmaExamPackage> {
  if (!input.version.immutable || !input.version.publishedAt)
    throw new Error('Only a published immutable examination version can be packaged.');
  if (input.version.security.requireExamPassword && !input.examPassword)
    throw new Error('This examination security policy requires a password verifier.');
  const packageId = input.packageId || randomId('package');
  const createdAt = new Date().toISOString();
  const manifestBase = unsignedManifest({ packageId, version: input.version, createdAt });
  const security: PharmaExamPackage['security'] = {
    settings: input.version.security,
    ...(input.examPassword
      ? { examPasswordVerifier: await derivePasswordVerifier(input.examPassword) }
      : {}),
    ...(input.adminExitPassword
      ? { adminExitPasswordVerifier: await derivePasswordVerifier(input.adminExitPassword) }
      : {}),
  };
  const files: Record<string, string | Uint8Array | Blob> = {
    'exam.json': JSON.stringify(input.version),
    'questions.json': JSON.stringify(input.version.questions),
    'security.json': JSON.stringify(security),
    'institution.json': JSON.stringify(input.institution),
    ...(input.assets || {}),
  };
  const entries: Record<string, { size: number; sha256: string }> = {};
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) {
    const content = await bytesOf(value);
    entries[name] = { size: content.byteLength, sha256: await sha256(content) };
    zip.file(name, asCryptoBuffer(content));
  }
  const packageDigest = await digestJson(entries);
  const publicJwk = await crypto.subtle.exportKey('jwk', input.signingKey.publicKey);
  const integrityPayload = canonicalJson({ manifest: manifestBase, entries, packageDigest });
  const integrity: PharmaExamIntegrity = {
    algorithm: 'SHA-256',
    entries,
    packageDigest,
    signatureAlgorithm: 'ECDSA-P256-SHA-256',
    publicKeyJwk: publicJwk,
    signature: await signPayload(integrityPayload, input.signingKey.privateKey),
  };
  const manifest: PharmaExamManifest = { ...manifestBase, integrity };
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('integrity/integrity.json', JSON.stringify(integrity));
  const zipBytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const envelope = await encryptPharmaExamEnvelope(zipBytes);
  return {
    manifest,
    exam: input.version,
    questions: input.version.questions,
    security,
    institution: input.institution,
    blob: new Blob([asCryptoBuffer(envelope)], { type: 'application/x-pharmaexam' }),
    filename: `${
      input.version.title
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'examination'
    }.pharmaexam`,
  };
}

export async function validatePharmaExamPackage(
  input: Blob | ArrayBuffer | Uint8Array,
  options: PackageValidationOptions = {},
): Promise<PackageValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const rawBytes = await toInputBytes(input);
    // New packages are an encrypted envelope (see the comment on
    // isPharmaExamEnvelope). Older packages shipped the signed ZIP
    // directly and remain readable without re-issuing them.
    const zipBytes = isPharmaExamEnvelope(rawBytes)
      ? await decryptPharmaExamEnvelope(rawBytes)
      : rawBytes;
    const zip = await JSZip.loadAsync(zipBytes);
    const manifest = await jsonOf<PharmaExamManifest>(zip, 'manifest.json');
    const integrity = await jsonOf<PharmaExamIntegrity>(zip, 'integrity/integrity.json');
    if (manifest.app !== 'pharmatrack' || manifest.format !== 'pharmaexam')
      errors.push('This is not a PharmaTRACK examination package.');
    if (manifest.formatVersion !== EXAM_PACKAGE_FORMAT_VERSION)
      errors.push(`Unsupported examination package version ${manifest.formatVersion}.`);
    if (manifest.immutable !== true)
      errors.push('Published examination packages must be immutable.');
    if (!manifest.integrity || manifest.integrity.packageDigest !== integrity.packageDigest)
      errors.push('Manifest and integrity records disagree.');
    if (options.expectedExamVersionId && manifest.examVersionId !== options.expectedExamVersionId)
      errors.push('The package contains a different examination version.');
    if (options.expectedPackageId && manifest.packageId !== options.expectedPackageId)
      errors.push('This is not the expected examination package.');
    if (
      options.trustedPublicKeyJwk &&
      canonicalJson(options.trustedPublicKeyJwk) !== canonicalJson(integrity.publicKeyJwk)
    )
      errors.push('The package signer is not trusted by this examination authority.');
    const required = ['exam.json', 'questions.json', 'security.json', 'institution.json'];
    for (const name of required)
      if (!zip.file(name)) errors.push(`Missing required package file: ${name}.`);

    const computedEntries: Record<string, { size: number; sha256: string }> = {};
    for (const name of Object.keys(integrity.entries || {})) {
      const entry = zip.file(name);
      if (!entry) {
        errors.push(`Declared package file is missing: ${name}.`);
        continue;
      }
      const content = await entry.async('uint8array');
      computedEntries[name] = { size: content.byteLength, sha256: await sha256(content) };
    }
    if (canonicalJson(computedEntries) !== canonicalJson(integrity.entries))
      errors.push('One or more package checksums do not match.');
    const computedDigest = await digestJson(integrity.entries);
    if (computedDigest !== integrity.packageDigest)
      errors.push('Package integrity digest is invalid.');
    const exam = await jsonOf<ExamVersion>(zip, 'exam.json');
    const questions = await jsonOf<ExamVersion['questions']>(zip, 'questions.json');
    const security = await jsonOf<PharmaExamPackage['security']>(zip, 'security.json');
    const institution = await jsonOf<ExamInstitutionInfo>(zip, 'institution.json');
    if (security.settings.requireExamPassword && !security.examPasswordVerifier)
      errors.push('The package requires a password but has no password verifier.');
    if (
      exam.id !== manifest.examVersionId ||
      exam.examId !== manifest.examId ||
      exam.version !== manifest.examVersion
    )
      errors.push('Exam metadata does not match the manifest.');
    if (exam.immutable !== true) errors.push('The packaged exam version is mutable.');
    if (
      questions.length !== exam.questions.length ||
      canonicalJson(questions) !== canonicalJson(exam.questions)
    )
      errors.push('questions.json does not match exam.json.');
    const unsigned = unsignedManifest({
      packageId: manifest.packageId,
      version: exam,
      createdAt: manifest.createdAt,
    });
    const signed = await verifyPayload(
      canonicalJson({
        manifest: unsigned,
        entries: integrity.entries,
        packageDigest: integrity.packageDigest,
      }),
      integrity.signature,
      integrity.publicKeyJwk,
    );
    if (!signed) errors.push('Package signature verification failed.');
    if (!errors.length) {
      return {
        ok: true,
        errors,
        warnings,
        staged: {
          manifest,
          exam,
          questions,
          security,
          institution,
          integrity,
          packageKey: packageKey(manifest),
        },
      };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Malformed examination package.');
  }
  return { ok: false, errors, warnings };
}

export async function verifyExamPassword(
  password: string,
  security: PharmaExamPackage['security'],
): Promise<boolean> {
  if (!security.examPasswordVerifier) return true;
  return verifyPassword(password, security.examPasswordVerifier);
}

export async function verifyAdminExitPassword(
  password: string,
  security: PharmaExamPackage['security'],
): Promise<boolean> {
  if (!security.adminExitPasswordVerifier) return false;
  return verifyPassword(password, security.adminExitPasswordVerifier);
}

export function packageContainsPlaintextPassword(packageData: string, password: string): boolean {
  return Boolean(password) && packageData.includes(password);
}
