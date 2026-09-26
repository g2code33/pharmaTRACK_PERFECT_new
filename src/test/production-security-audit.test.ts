import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

import { ExaminationRepository } from '../examination/service';
import { AIManager, defaultSettings, redactSecrets } from '../ai';
import { saveCredentials, clearAllCredentials, loadAllCredentials } from '../ai/credentials';
import { purgeStoredSession } from '../utils/supabase';

// Load all Supabase SQL files & Cloudflare configs
const securityRlsSql = readFileSync('supabase/security-rls.sql', 'utf8');
const authSql = readFileSync('supabase/authentication.sql', 'utf8');
const accountSyncSql = readFileSync('supabase/account-sync.sql', 'utf8');
const aiSyncSql = readFileSync('supabase/ai-account-sync.sql', 'utf8');
const cloudflareStorageSql = readFileSync('supabase/cloudflare-storage.sql', 'utf8');
const workerCode = readFileSync('cloudflare/worker/src/index.ts', 'utf8');
const wranglerConfig = readFileSync('wrangler.toml', 'utf8');
const allSqlFiles = [securityRlsSql, authSql, accountSyncSql, aiSyncSql, cloudflareStorageSql];

// Helper to recursively collect files from a directory
function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

describe('PHARMATRACK — PRODUCTION SECURITY AUDIT', () => {
  beforeEach(() => {
    idbStore.clear();
    localStorage.clear();
    void clearAllCredentials();
  });

  /* ======================================================================== */
  /* 1. SUPABASE SECURITY & RLS AUDIT                                         */
  /* ======================================================================== */
  describe('1. Supabase Security & RLS Policy Enforcement', () => {
    it('enforces Row Level Security (RLS) on all exposed application tables', () => {
      // Must enable RLS on every table
      expect(securityRlsSql).toContain('alter table public.profiles enable row level security;');
      expect(accountSyncSql).toContain('alter table public.pharmatrack_account_sync_records enable row level security;');
      expect(accountSyncSql).toContain('alter table public.pharmatrack_account_sync_cursors enable row level security;');
      expect(aiSyncSql).toContain('alter table public.pharmatrack_ai_configurations enable row level security;');
      expect(aiSyncSql).toContain('alter table public.pharmatrack_ai_devices enable row level security;');
      expect(aiSyncSql).toContain('alter table public.pharmatrack_ai_secrets enable row level security;');
      expect(cloudflareStorageSql).toContain('alter table public.storage_objects enable row level security;');
    });

    it('uses actual ownership predicates in all policies and NEVER relies on TO authenticated alone', () => {
      for (const sql of allSqlFiles) {
        // Find all policy declarations
        const policyMatches = sql.match(/create\s+policy\s+"[^"]+"\s+on\s+[^\n]+/gi) || [];
        for (const policyLine of policyMatches) {
          // If policy targets a table, verify it doesn't do "TO authenticated" without a using/with check predicate
          expect(policyLine).not.toMatch(/to\s+authenticated\s*;\s*$/i);
        }

        // Verify that any "TO authenticated" usage is accompanied by auth.uid() ownership check
        const toAuthLines = sql.split('\n').filter((l) => /to\s+authenticated/i.test(l) && /create\s+policy/i.test(l));
        for (const line of toAuthLines) {
          expect(line).toMatch(/auth\.uid\(\)/);
        }
      }

      // Profiles ownership predicate
      expect(securityRlsSql).toContain('auth.uid() = id');
      // Storage objects ownership predicate
      expect(securityRlsSql).toContain('auth.uid()::text = (storage.foldername(name))[1]');
      // Account sync records ownership predicate
      expect(accountSyncSql).toContain('auth.uid() = user_id');
      // Cloudflare storage metadata ownership predicate
      expect(cloudflareStorageSql).toContain('auth.uid() = account_id');
      expect(cloudflareStorageSql).toContain("object_key like ('objects/' || auth.uid()::text || '/%')");
    });

    it('strictly forbids user-editable user_metadata for role or authorization decisions', () => {
      // Role column cannot be inserted or updated by users
      expect(authSql).toContain('revoke insert (role), update (role) on table public.profiles from anon, authenticated;');
      expect(authSql).toContain("role in ('student', 'staff', 'admin')");

      // Verify trigger only copies display fields (full_name, level), never role or privileges
      expect(authSql).toContain("new.raw_user_meta_data ->> 'full_name'");
      expect(authSql).toContain("new.raw_user_meta_data ->> 'level'");
      expect(authSql).not.toContain("new.raw_user_meta_data ->> 'role'");
      expect(authSql).not.toContain("new.raw_user_meta_data ->> 'is_admin'");
    });

    it('defines atomic and authenticated account deletion that purges user data across all storage and auth tables', () => {
      expect(authSql).toContain('create or replace function public.delete_my_account()');
      expect(authSql).toContain('security definer set search_path = public, auth, storage');
      expect(authSql).toContain('revoke execute on function public.delete_my_account() from public, anon;');
      expect(authSql).toContain('grant execute on function public.delete_my_account() to authenticated;');

      // Verifies cleanup of storage objects, Cloudflare metadata, profiles, and auth.users
      expect(authSql).toContain("bucket_id = 'user-documents'");
      expect(authSql).toContain('delete from public.profiles where id = uid;');
      expect(authSql).toContain('delete from auth.users where id = uid;');
      expect(authSql).toContain('storage_objects');
    });

    it('sets explicit search_path on all SECURITY DEFINER functions to prevent search path hijacking', () => {
      for (const sql of allSqlFiles) {
        const functionBlocks = sql.split(/create\s+or\s+replace\s+function/gi).slice(1);
        for (const block of functionBlocks) {
          if (/security\s+definer/i.test(block)) {
            expect(block).toMatch(/set\s+search_path\s*=\s*[a-zA-Z0-9_,\s]+/i);
          }
        }
      }
    });

    it('implements complete local session revocation in client auth utilities', () => {
      localStorage.setItem('sb-test-auth-token', 'mock-session-token');
      localStorage.setItem('sb-test-auth-token-code-verifier', 'mock-verifier');
      localStorage.setItem('supabase.auth.token', 'legacy-token');

      purgeStoredSession();

      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect(localStorage.getItem('sb-test-auth-token-code-verifier')).toBeNull();
      expect(localStorage.getItem('supabase.auth.token')).toBeNull();
    });
  });

  /* ======================================================================== */
  /* 2. SECRETS SCAN: REPOSITORY & FRONTEND BUNDLE                            */
  /* ======================================================================== */
  describe('2. Secrets Leak Prevention in Production Bundle & Source Code', () => {
    it('verifies that the dist/ production bundle contains zero service_role keys or secrets', () => {
      let distFiles = collectFiles('dist');
      if (distFiles.length === 0) {
        execSync('npx vite build --mode production', { stdio: 'ignore' });
        distFiles = collectFiles('dist');
      }
      expect(distFiles.length).toBeGreaterThan(0);

      for (const file of distFiles) {
        if (!file.endsWith('.js') && !file.endsWith('.html') && !file.endsWith('.css')) continue;
        const content = readFileSync(file, 'utf8');

        // Check for service_role keys
        expect(content).not.toContain('service_role');
        expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY');

        // Check for private keys
        expect(content).not.toContain('BEGIN PRIVATE KEY');
        expect(content).not.toContain('BEGIN RSA PRIVATE KEY');

        // Check for Cloudflare R2 / AWS S3 secret keys
        expect(content).not.toContain('R2_SECRET_ACCESS_KEY');
        expect(content).not.toContain('AWS_SECRET_ACCESS_KEY');
      }
    });

    it('verifies that no raw AI provider API keys are hardcoded in application source code or bundles', () => {
      const srcFiles = collectFiles('src').filter((f) => !f.includes('/test/'));
      let distFiles = collectFiles('dist');
      if (distFiles.length === 0) {
        execSync('npx vite build --mode production', { stdio: 'ignore' });
        distFiles = collectFiles('dist');
      }
      const allRuntimeFiles = [...srcFiles, ...distFiles];

      for (const file of allRuntimeFiles) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.js')) continue;
        const content = readFileSync(file, 'utf8');

        // Check regex patterns for real OpenAI, Gemini, Anthropic, Nvidia, Groq keys
        expect(content).not.toMatch(/sk-proj-[A-Za-z0-9_-]{30,}/);
        expect(content).not.toMatch(/sk-ant-api03-[A-Za-z0-9_-]{30,}/);
        expect(content).not.toMatch(/AIzaSy[A-Za-z0-9_-]{33}/);
        expect(content).not.toMatch(/nvapi-[A-Za-z0-9_-]{30,}/);
        expect(content).not.toMatch(/gsk_[A-Za-z0-9_-]{30,}/);
      }
    });
  });

  /* ======================================================================== */
  /* 3. CLOUDFLARE WORKER & R2 SECURITY AUDIT                                 */
  /* ======================================================================== */
  describe('3. Cloudflare Worker & R2 Storage Security', () => {
    it('verifies Worker authentication validates Supabase access tokens and rejects untrusted account IDs', () => {
      expect(workerCode).toContain('export async function authenticate(');
      expect(workerCode).toContain('/auth/v1/user');
      expect(workerCode).toContain("headers.get('Authorization')");
      expect(workerCode).toContain('Bearer');
      expect(workerCode).toContain('validUuid(id)');
      expect(workerCode).toContain('invalid_identity');
      expect(workerCode).toContain('invalid_token');
    });

    it('enforces secure object namespacing and prevents path traversal', () => {
      expect(workerCode).toContain('function accountKey(accountId: string, objectId: string, extension: string): string');
      expect(workerCode).toContain('objects/${accountId}/${objectId}.${extension}');
      expect(workerCode).toContain('validUuid(accountId)');
      expect(workerCode).toContain('OBJECT_ID.test(objectId)');
      expect(workerCode).toContain('function safeFileName(value: string | null): string');
      expect(workerCode).toContain('hasControlCharacter(value)');
      expect(workerCode).toContain('/[\\\\/]/.test(value)'); // Blocks / and \
    });

    it('enforces file signature (magic bytes) validation before persisting into R2', () => {
      expect(workerCode).toContain('function validateMagic(policy: AssetPolicy, prefix: Uint8Array): void');
      expect(workerCode).toContain('0x25, 0x50, 0x44, 0x46, 0x2d'); // %PDF-
      expect(workerCode).toContain('0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a'); // PNG
      expect(workerCode).toContain('0xff, 0xd8, 0xff'); // JPG
      expect(workerCode).toContain('0x47, 0x49, 0x46, 0x38'); // GIF
      expect(workerCode).toContain('0x52, 0x49, 0x46, 0x46'); // WEBP
      expect(workerCode).toContain('invalid_file_signature');
    });

    it('enforces upload limits and stream truncation protection', () => {
      expect(workerCode).toContain('function limitedStream(');
      expect(workerCode).toContain('file_too_large');
      expect(workerCode).toContain('maxBytes');
      expect(workerCode).toContain('MAX_MULTIPART_PART_BYTES');
    });

    it('enforces strict CORS with exact-origin allowlist and never permits wildcard *', () => {
      expect(workerCode).toContain('function allowedOrigins(env: Env): Set<string>');
      expect(workerCode).toContain('function originIsAllowed(request: Request, env: Env): boolean');
      expect(workerCode).toContain('origin_not_allowed');
      expect(workerCode).not.toContain("Access-Control-Allow-Origin', '*'");
      expect(workerCode).toContain("Vary: 'Origin'");
    });

    it('isolates environments and enforces rate limiting in wrangler configuration', () => {
      expect(wranglerConfig).toContain('[env.staging]');
      expect(wranglerConfig).toContain('[env.production]');
      expect(wranglerConfig).toContain('pharmatrack-objects-staging');
      expect(wranglerConfig).toContain('pharmatrack-objects-production');
      expect(wranglerConfig).toContain('RATE_LIMITER');
    });

    it('never grants browser clients unrestricted R2 credentials or storage keys', () => {
      expect(workerCode).not.toContain('R2_ACCESS_KEY_ID');
      expect(workerCode).not.toContain('R2_SECRET_ACCESS_KEY');
      expect(workerCode).not.toContain('AWS_SECRET_ACCESS_KEY');
    });
  });

  /* ======================================================================== */
  /* 4. AI KEY VAULT & CREDENTIAL LEAK PROTECTION                             */
  /* ======================================================================== */
  describe('4. AI Key Vault Security & Redaction', () => {
    const TEST_KEY = 'nvapi-security-audit-test-key-012345';

    it('verifies that provider credentials are never placed in URLs or query parameters', async () => {
      const capturedUrls: string[] = [];
      vi.stubGlobal('fetch', async (url: string | URL) => {
        capturedUrls.push(String(url));
        return Response.json({ choices: [{ message: { content: 'Safe pharmacology response' } }] });
      });

      const settings = defaultSettings();
      settings.providers = settings.providers.map((p) =>
        p.id === 'nvidia' ? { ...p, enabled: true, model: 'meta/llama-3.1-70b-instruct' } : p,
      );

      const manager = new AIManager({
        loadSettings: () => settings,
        saveSettings: (next) => next,
        loadCreds: async () => ({ nvidia: { apiKey: TEST_KEY } }),
      });

      await manager.generate({ messages: [{ role: 'user', content: 'What is bioavailability?' }], providerId: 'nvidia' });

      expect(capturedUrls.length).toBeGreaterThan(0);
      for (const url of capturedUrls) {
        expect(url).not.toContain(TEST_KEY);
        expect(url).not.toContain(encodeURIComponent(TEST_KEY));
        expect(url).not.toContain('apiKey');
        expect(url).not.toContain('api_key');
      }

      vi.unstubAllGlobals();
    });

    it('redacts provider keys and authorization tokens from logs and error messages', () => {
      const dirtyLog = `Fetch failed with Bearer ${TEST_KEY} and key=${TEST_KEY}`;
      const cleaned = redactSecrets(dirtyLog, [TEST_KEY]);

      expect(cleaned).not.toContain(TEST_KEY);
      expect(cleaned).toContain('[redacted]');
    });

    it('stores credentials in encrypted AES-GCM envelope in IndexedDB', async () => {
      await saveCredentials('nvidia', { apiKey: TEST_KEY });

      const storedRaw = idbStore.get('pharmatrack_ai_credentials') as Record<string, unknown>;
      expect(storedRaw).toBeDefined();

      const jsonStr = JSON.stringify(storedRaw);
      expect(jsonStr).not.toContain(TEST_KEY); // Raw secret is never in storage
      expect(jsonStr).toContain('AES-GCM-256');

      const loaded = await loadAllCredentials();
      expect(loaded.nvidia?.apiKey).toBe(TEST_KEY);
    });
  });

  /* ======================================================================== */
  /* 5. EXAMINATION VS NORMAL ACCOUNT AUTH BOUNDARY                           */
  /* ======================================================================== */
  describe('5. Examination vs Normal Account Authentication Separation', () => {
    const mockQuestion = {
      id: 'q-security-1',
      courseId: 'pharma-sec',
      topicId: 'sec',
      questionText: 'Security verification question',
      questionType: 'mcq' as const,
      marksAllocation: 2,
      difficulty: 'easy' as const,
      probability: 'high' as const,
      modelAnswer: 'A',
      correctAnswer: 'A',
      tags: ['sec'],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: '2026-09-26T00:00:00.000Z',
      options: ['A', 'B', 'C', 'D'],
      correctOption: 0,
    };

    it('verifies that normal Supabase account credentials cannot bypass examination kiosk authorization', async () => {
      const repository = await ExaminationRepository.open();
      const exam = await repository.createExam('Pharmacology Security Exam');
      await repository.createVersion(exam.id, [mockQuestion], {
        title: 'Pharmacology Security Exam',
        assessmentType: 'KIOSK_EXAM',
        availability: { durationMinutes: 60 },
        security: { kioskMode: true, requireExamPassword: true },
      });

      // An attacker attempts to authenticate with a Supabase email and account password
      await expect(
        repository.authenticateStudent('student@university.edu', 'Level 400', 'SupabaseUserPassword123!'),
      ).rejects.toThrow('First name, level, or RX30 Kiosk password is incorrect.');

      // Even if attacker tries with their Supabase user UUID as first name
      const arbitraryAccountId = '88888888-8888-4888-8888-888888888888';
      await expect(
        repository.authenticateStudent(arbitraryAccountId, 'Level 400', 'SupabaseUserPassword123!'),
      ).rejects.toThrow('First name, level, or RX30 Kiosk password is incorrect.');
    });

    it('verifies that examination Kiosk credentials (RX30) cannot be used as normal account credentials', async () => {
      const repository = await ExaminationRepository.open();
      const { student, password: kioskPassword } = await repository.registerStudent('Esi Mensah', 'Level 400');

      // The sequential kiosk password (e.g. RX30a) is strictly for local kiosk and LAN authority PBKDF2 verification
      expect(kioskPassword).toMatch(/^RX30/);
      expect(student.kioskPasswordVerifier).toBeDefined();
      expect(student.kioskPasswordVerifier.algorithm).toBe('PBKDF2-SHA-256');

      // Student name is plain first name, not an email address, which is rejected by Supabase Auth
      expect(student.firstName).toBe('Esi Mensah');
      expect(student.firstName).not.toContain('@');
    });

    it('prevents another device from hijacking an active attempt without valid authentication', async () => {
      const repository = await ExaminationRepository.open();
      const exam = await repository.createExam('Tamper Prevention Exam');
      const version = await repository.createVersion(exam.id, [mockQuestion], {
        title: 'Tamper Prevention Exam',
        assessmentType: 'KIOSK_EXAM',
        availability: { durationMinutes: 60 },
      });
      const published = await repository.publishVersion(exam.id, version.id);
      const session = await repository.createSession(exam.id, published.id, 'lan-server', 'http://192.168.1.1:8787');

      const { student } = await repository.registerStudent('Kofi Atta', 'Level 300');
      const legitDevice = await repository.createDeviceSession({
        deviceId: 'legit-dev',
        role: 'STUDENT',
        studentId: student.id,
        sessionId: session.id,
        platform: 'native-pc',
        capabilities: ['encrypted-local-state'],
      });
      const { attempt } = await repository.createAttempt(session.id, student.id, legitDevice.id);

      // Attacker device session
      const attackerDevice = await repository.createDeviceSession({
        deviceId: 'attacker-dev',
        role: 'STUDENT',
        studentId: 'some-other-student',
        sessionId: session.id,
        platform: 'web',
        capabilities: ['encrypted-local-state'],
      });

      // Attacker attempts to record an answer on Kofi's attempt
      await expect(
        repository.recordAnswer(attempt.id, {
          questionId: 'q-1',
          answer: 'Hacked answer',
          selectedOption: 0,
          deviceSessionId: attackerDevice.id,
          isFinal: false,
        }),
      ).rejects.toThrow('This device session no longer owns the active attempt.');
    });
  });
});
