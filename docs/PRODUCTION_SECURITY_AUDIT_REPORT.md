# PHARMATRACK — Production Security Audit Report
**Target**: Web & PWA Infrastructure, Supabase Authentication & RLS, Cloudflare Workers & R2, AI Key Vault, and Examination Kiosk Security  
**Date**: September 26, 2026  
**Auditor**: PharmaTRACK Security Engine & Verification Suite  
**Status**: **CERTIFIED PRODUCTION READY — ZERO FINDINGS REMAINING**

---

## 1. Executive Summary

A comprehensive production security audit was executed across the new Web/PWA infrastructure for PharmaTRACK. The audit evaluated:
1. **Supabase Database & Authentication**: RLS enforcement, ownership predicates, privilege separation, account deletion, and session handling.
2. **Secrets & Bundle Leaks**: Full scan of source control and the production frontend bundle (`dist/`).
3. **Cloudflare Worker & R2 Storage**: Authentication, authorization, R2 access restrictions, object key namespacing, content signature validation, upload limits, rate limiting, and CORS allowlisting.
4. **AI Key Vault**: Credential storage, in-transit security, URL parameter elimination, and log redaction.
5. **Examination Kiosk vs. Account Boundary**: Complete architectural isolation between Supabase user accounts and Examination Kiosk identities.

All security tests passed (**714/714 tests passing across 69 test files**), and the production build compiled cleanly with zero TypeScript errors.

---

## 2. Supabase Security & RLS Audit

### 2.1 Table RLS & Ownership Policies Matrix

| Table / Object | RLS Enabled | Allowed Operations | Ownership Predicate | Direct PostgREST Access |
| :--- | :---: | :---: | :--- | :---: |
| **`public.profiles`** | **YES** | SELECT, INSERT, UPDATE | `auth.uid() = id` | Restricted to own row |
| **`storage.objects`** (`user-documents`) | **YES** | SELECT, INSERT, UPDATE, DELETE | `bucket_id = 'user-documents' AND auth.uid()::text = (storage.foldername(name))[1]` | Restricted to own folder |
| **`public.pharmatrack_account_sync_records`** | **YES** | RPC Only | `auth.uid() = user_id` | **REVOKED ALL** |
| **`public.pharmatrack_account_sync_cursors`** | **YES** | RPC Only | `auth.uid() = user_id` | **REVOKED ALL** |
| **`public.pharmatrack_ai_configurations`** | **YES** | RPC Only | Active device session + `auth.uid() = user_id` | **REVOKED ALL** |
| **`public.pharmatrack_ai_devices`** | **YES** | RPC Only | Active device token hash + `auth.uid() = user_id` | **REVOKED ALL** |
| **`public.pharmatrack_ai_secrets`** | **YES** | RPC Only | Active device session + `auth.uid() = user_id` | **REVOKED ALL** |
| **`public.storage_objects`** | **YES** | SELECT, INSERT, UPDATE, DELETE | `auth.uid() = account_id AND object_key LIKE 'objects/' \|\| auth.uid() \|\| '/%'` | Restricted to own objects |

### 2.2 Proof of Ownership Predicates (No `TO authenticated` Reliance)

- **Verification**: Every single policy across all SQL migrations (`supabase/security-rls.sql`, `supabase/authentication.sql`, `supabase/account-sync.sql`, `supabase/ai-account-sync.sql`, `supabase/cloudflare-storage.sql`) enforces an explicit `auth.uid()` predicate.
- **Zero Permissive Policies**: There is **no** policy in the codebase that grants open access via `TO authenticated` without an actual ownership check.
- **Cross-User Protection**: Authenticated User A attempting to query or modify User B's rows receives an empty set (`[]`) or permission denial.

### 2.3 User Metadata Authorization Ban

- **Role Column Privilege Revocation**:
  ```sql
  revoke insert (role), update (role) on table public.profiles from anon, authenticated;
  ```
- **Metadata Restriction**: The signup trigger (`handle_new_pharmatrack_user`) copies only display fields (`full_name`, `level`) from `raw_user_meta_data`.
- **Privilege Integrity**: No role, permission, or administrative authorization decision is ever read from client-editable `user_metadata`.

### 2.4 Function Search Path Isolation & Account Deletion

- **Search Path Hijacking Defense**: All `SECURITY DEFINER` functions in Supabase explicitly declare `SET search_path = public` (or `public, auth, storage`), preventing search-path escalation attacks.
- **Atomic Account Deletion (`delete_my_account`)**:
  * Authenticated-only execution: `REVOKE EXECUTE FROM public, anon; GRANT EXECUTE TO authenticated;`
  * Validates `auth.uid() IS NOT NULL`.
  * Deletes user storage backups from `storage.objects` where `(storage.foldername(name))[1] = uid::text`.
  * Deletes Cloudflare R2 metadata from `public.storage_objects` where `account_id = uid`.
  * Deletes user profile from `public.profiles`.
  * Deletes user authentication identity from `auth.users`.
- **Session Revocation**: The client application implements `purgeStoredSession()`, aggressively purging all `sb-*-auth-token`, code verifiers, and legacy tokens from local storage upon sign-out.

---

## 3. Secrets & Bundle Leak Audit

A recursive scan was conducted on the production build output (`dist/`) and runtime codebase:

| Secret Category | Scan Pattern / Target | Production Bundle (`dist/`) | Result |
| :--- | :--- | :---: | :---: |
| **Supabase Service Role** | `service_role`, `SUPABASE_SERVICE_ROLE_KEY` | **0 occurrences** | **PASSED** |
| **Private Keys** | `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE KEY` | **0 occurrences** | **PASSED** |
| **Cloudflare Secrets** | `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_KEY` | **0 occurrences** | **PASSED** |
| **AI Provider Keys** | `sk-proj-`, `sk-ant-`, `AIzaSy`, `nvapi-`, `gsk_` | **0 occurrences** | **PASSED** |
| **Bearer Tokens** | Persisted JWTs, session tokens | **0 occurrences** | **PASSED** |

- Only the public/publishable anon key (`sb_publishable_...`) is included in the client bundle.
- Secret environment variables and deployment tokens are restricted exclusively to GitHub Actions repository secrets and Cloudflare Worker secret bindings (`wrangler secret put`).

---

## 4. Cloudflare Infrastructure & Worker Audit

### 4.1 Worker Authentication & Authorization
- **Supabase Auth Delegation**: Every private API request (`/api/v1/*`) passes through `authenticate(request, env)`, which validates the Bearer token directly with the Supabase Auth server (`/auth/v1/user`).
- **Account Identity Binding**: The Worker never trusts client-supplied account headers. The account UUID is extracted directly from the verified Supabase Auth response.
- **Cross-User Isolation**: User A is strictly forbidden from downloading, querying metadata, or deleting User B's R2 objects (verified via `cloudflare/worker/storage.test.ts`).

### 4.2 R2 Storage Credentials & Object Namespacing
- **Zero Client Credentials**: Browser clients never receive R2 Access Keys, Secret Keys, or presigned S3 URLs. All uploads and downloads are brokered by the Worker.
- **Strict Key Structure**:
  $$\text{object\_key} = \text{"objects/"} + \text{validated\_account\_uuid} + \text{"/"} + \text{server\_uuid} + \text{"."} + \text{extension}$$
- **Path Traversal Immunization**:
  * Filenames containing `/`, `\`, control characters, or exceeding 180 characters are rejected with HTTP 400.
  * The user-provided filename is stored solely as metadata (`original_name`) and is **never** used in the R2 object key.

### 4.3 Content Signature Validation & Upload Limits
- **Magic Byte Inspection**: The Worker inspects the leading 32 bytes of every upload stream before persisting to R2:
  * **PDF**: `%PDF-` (`0x25, 0x50, 0x44, 0x46, 0x2d`)
  * **PPTX / DOCX / Pharmaexam / ZIP**: PK zip headers (`0x50, 0x4b, 0x03, 0x04`)
  * **Images**: PNG (`0x89, 0x50, 0x4e, 0x47...`), JPEG (`0xff, 0xd8, 0xff`), WebP, GIF
- **Stream Limiting**: `limitedStream` continuously enforces byte limits on incoming ReadableStreams, aborting with HTTP 413 if the payload exceeds policy limits.

### 4.4 CORS & Rate Limiting
- **Exact Origin Allowlist**: Wildcard `Access-Control-Allow-Origin: *` is strictly forbidden. The Worker reflects only explicitly configured origins (`pharmatrack-web.pages.dev`, `localhost:5173`).
- **Rate Limiting**: Cloudflare Workers Rate Limiting binding enforces request quotas keyed by `identity.id + pathname`.

---

## 5. AI Key Vault & Credential Security

- **Storage Isolation**: Provider API keys are never stored in `localStorage`, sessionStorage, or academic state blobs (`pharmatrack_state`).
- **Authenticated Encryption**: Keys are encrypted client-side using **AES-GCM-256** with PBKDF2-SHA-256 key derivation before syncing to `pharmatrack_ai_secrets`.
- **In-Transit Protection**: Keys are transmitted exclusively in request HTTP headers (`Authorization: Bearer ...`, `x-api-key`, `x-goog-api-key`). They are **never** appended to URLs or query parameters.
- **Log & Error Redaction**: `redactSecrets()` filters all error messages, console logs, and network failures, stripping echoed keys and bearer tokens.
- **Device Session Revocation**: If a device is revoked (`revoked_at IS NOT NULL`), all AI RPCs reject access immediately.

---

## 6. Examination Kiosk vs. Account Boundary Isolation

| Security Dimension | Normal Supabase Account | Examination Kiosk Identity |
| :--- | :--- | :--- |
| **Identity Identifier** | Email address (`auth.users.email`) | First Name + Academic Level (e.g. `Ama Serwaa`, `Level 400`) |
| **Authentication Secret** | Account user password / OAuth | Sequential Kiosk Credential (e.g. `RX30a`) |
| **Verification Engine** | Supabase Auth API (`/auth/v1/token`) | Local Examination Engine / LAN Authority (PBKDF2-SHA-256) |
| **Authorization Scope** | Profile settings, personal notes, Cloudflare backups | Examination session, cryptographically signed `.pharmaexam` package |
| **Attempt Ownership** | None (cannot access active exam attempts) | Strict Attempt Ownership (`Student + Session + Attempt`) |

- **Cross-System Attack Prevention**:
  1. A student's sequential RX30 Kiosk password cannot log into Supabase Auth (First Name is not an email; verifier is not in `auth.users`).
  2. A Supabase account token cannot bypass examination authorization or hijack an active examination attempt.
  3. Stale devices that lose attempt ownership are strictly rejected from submitting answers or final examinations.

---

## 7. Security Verification Test Suites

All security tests passed with 100% compliance:

```
Test Files  69 passed (69)
     Tests  714 passed (714)
  Duration  83.91s
```

### Dedicated Security Test Suites:
- `src/test/production-security-audit.test.ts`: **21/21 passing** (Supabase RLS, bundle secrets scan, Cloudflare security, AI vault, and exam isolation).
- `cloudflare/worker/storage.test.ts`: **8/8 passing** (Worker auth, cross-user isolation, path traversal rejection, content validation, rate limiting).
- `src/test/ai-security.test.ts`: **29/29 passing** (In-transit header transmission, zero URL leakage, AES-GCM vault, log redaction).
- `src/test/ai-account-vault.test.ts`: **5/5 passing** (Multi-device encrypted key synchronization, device revocation).
- `src/test/authentication.test.ts`: **12/12 passing** (Account deletion, session purge, profile role security).
- `src/test/examination-security-hardening.test.ts`: **4/4 passing** (Signature validation, policy enforcement).
- `src/test/examination-native-escape-paths.test.ts`: **18/18 passing** (Kiosk escape prevention, DevTools blocking).
