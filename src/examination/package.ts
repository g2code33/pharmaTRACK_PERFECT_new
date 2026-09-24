import JSZip from 'jszip';
import {
  canonicalJson,
  digestJson,
  derivePasswordVerifier,
  randomId,
  sha256,
  verifyPassword,
} from './crypto';
import { readBlobArrayBuffer } from '../utils/fileGuard';
import type { ExamSecuritySettings, ExamVersion, ExaminationState } from './types';
import { EXAM_PACKAGE_FORMAT_VERSION } from './types';

const encoder = new TextEncoder();

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

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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
    arrayBuffer(encoder.encode(payload)),
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
      arrayBuffer(fromBase64(signature)),
      arrayBuffer(encoder.encode(payload)),
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
    zip.file(name, arrayBuffer(content));
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
  return {
    manifest,
    exam: input.version,
    questions: input.version.questions,
    security,
    institution: input.institution,
    blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }),
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
    const zip = await JSZip.loadAsync(input);
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

export function packageContainsPlaintextPassword(packageData: string, password: string): boolean {
  return Boolean(password) && packageData.includes(password);
}
