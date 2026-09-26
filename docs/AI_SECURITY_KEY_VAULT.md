# PharmaTRACK Secure Account AI / API Key Vault

Threat Model, Key Lifecycle, and Multi-Device Synchronization Architecture

---

## 1. Goal and Core Principles

PharmaTRACK allows students and clinicians to configure external or local AI providers (e.g. NVIDIA, OpenAI, Google Gemini, Anthropic, Groq, OpenRouter, Mistral, and custom OpenAI-compatible endpoints) on one device (Device A) and have that configuration and credential securely accessible on another authorized device (Device B) after logging in, without manually re-entering secrets.

### Non-Negotiable Security Rules

1. **Zero Raw Secret Exposure**: Provider API keys, access tokens, and passwords must never be stored in plaintext in:
   - `localStorage`
   - Normal unencrypted IndexedDB tables
   - Exposed Supabase tables or normal application JSON state
   - Supabase `auth.users.user_metadata` or JWT claims
   - URLs, request paths, query parameters, or search strings
   - Console logs, analytics payloads, crash telemetry, or audit trails
   - Git commits, repository source files, or frontend production bundles
2. **Server-Side Zero Knowledge**: Neither Supabase database administrators nor backend services have access to plaintext provider API keys. All credentials stored remotely are authenticated AES-GCM ciphertexts whose decryption keys exist only transiently in client device memory.
3. **No Secret Inversion**: UI components never handle raw API keys beyond initial entry. React state and component props only ever receive non-secret status metadata (`hasKey`, `maskedSuffix`, `updatedAt`, `syncStatus`).

---

## 2. Threat Model

| Threat Scenario                                | Threat Actor / Vector                                                  | Mitigation in PharmaTRACK                                                                                                                                                                                                 |
| :--------------------------------------------- | :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Physical device theft / inspection**         | Local attacker inspects browser storage (`localStorage`, IndexedDB).   | Credentials in IndexedDB are device-encrypted with Web Crypto AES-GCM-256. Non-secret settings in `localStorage` have all credentials stripped.                                                                           |
| **Database compromise / SQL injection**        | Attacker accesses Supabase database rows.                              | The `pharmatrack_ai_secrets` table stores only AES-GCM-256 ciphertext envelopes with user-specific authenticated additional data (AAD) and random IVs. The server holds neither the vault key nor the account password.   |
| **Network interception / Proxy logging**       | Corporate/campus network proxy logs URLs and HTTP headers.             | Keys are never sent in URLs/query parameters (even for Gemini, an authorization header is forced). Endpoints and URLs are scrubbed of key parameters before persistence.                                                  |
| **Cross-user / Multi-tenant access**           | Malicious authenticated user queries another user's encrypted secrets. | Row-Level Security (RLS) and SECURITY DEFINER RPCs strictly enforce `auth.uid() = user_id`. Envelope AAD binds each ciphertext to `user_id:provider_id`, preventing ciphertext substitution across accounts or providers. |
| **Memory scraping / Stale cache**              | Attacker dumps browser memory after logout.                            | On logout, `lockAccountAI()` drops the derived `CryptoKey` and active session; `AIManager.clearCredentialCache()` immediately clears all plaintext credentials in memory.                                                 |
| **Unintended re-upload after remote deletion** | Device A reconnects after Device B removed a key.                      | Optimistic version checks and serverVersion tombstone recognition ensure Device A purges the local credential rather than resurrecting it.                                                                                |

---

## 3. Cryptographic Architecture

PharmaTRACK separates device-local persistence from multi-device account recovery:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI CREDENTIAL VAULT                             │
└────────────────────────────────────────────────────────────────────────┘
                                    │
         ┌──────────────────────────┴──────────────────────────┐
         ▼                                                     ▼
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│        DEVICE ENCRYPTION        │   │   ACCOUNT-RECOVERABLE ENCRYPT   │
├─────────────────────────────────┤   ├─────────────────────────────────┤
│ • Protects secrets at rest on   │   │ • Allows secure multi-device    │
│   this single device (offline). │   │   recovery on Device B.         │
│ • AES-GCM-256 with device key   │   │ • Key derived from account      │
│   held in Web Crypto / secure   │   │   password + account salt via   │
│   storage helper.               │   │   PBKDF2-SHA-256 (310,000 iter).│
│ • Survives page refresh and     │   │ • Transient CryptoKey in memory │
│   offline study sessions.       │   │   only; never persisted to disk.│
│ • Local IndexedDB:              │   │ • Remote Supabase envelope:     │
│   pharmatrack_ai_credentials    │   │   pharmatrack_ai_secrets        │
└─────────────────────────────────┘   └─────────────────────────────────┘
```

### Account Vault Key Derivation (PBKDF2-SHA-256)

- **Algorithm**: `PBKDF2` with `SHA-256`
- **Iterations**: `310,000` (OWASP recommended baseline for password-based key derivation)
- **Salt**: 16 cryptographically random bytes generated via `crypto.getRandomValues()`, stored per-user on the server (`vaultSalt`).
- **Target Key**: Non-extractable `AES-GCM` 256-bit `CryptoKey` with usages `['encrypt', 'decrypt']`.

### Secret Envelope Format

```json
{
  "version": 1,
  "algorithm": "AES-GCM-256",
  "iv": "<base64 12-byte random IV>",
  "ciphertext": "<base64 AES-GCM-256 ciphertext>",
  "aad": "<user_id>:<provider_id>"
}
```

- Authenticated Additional Data (`aad`) cryptographically binds the envelope to both the specific authenticated user and the specific provider. Attempting to replay an envelope under a different account or provider fails authentication tag verification.

---

## 4. Key Lifecycle

### Phase 1: Entry & Local Save (Device A)

1. User enters API key in UI (`AISettingsPanel`).
2. UI calls `ai.saveProvider({ ...provider, apiKey })`.
3. `saveCredentials(providerId, { apiKey })`:
   - Strips leading/trailing whitespace.
   - Encrypts local store with AES-GCM device key.
   - Updates local metadata: `hasKey: true`, `maskedSuffix: ••••<last4>`, `updatedAt: <ISO>`, `localVersion: N+1`, `syncStatus: 'pending'`.
   - Records audit event: `'provider configured'` (or `'provider updated'`).
   - Notifies `AIManager` via `onCredentialsChanged` to reload cache.
   - Queues secret sync via `queueSecretSync`.

### Phase 2: Remote Synchronization (Device A → Cloud)

1. `writeSecret` verifies active account session and vault `CryptoKey`.
2. Encrypts payload with vault key and AAD `userId:providerId`.
3. Calls RPC `pharmatrack_ai_upsert_secret(deviceId, deviceToken, providerId, type, baseVersion, envelope, localVersion)`.
4. Supabase validates session, verifies `p_base_version = secret_version` (optimistic concurrency), stores envelope, and returns `accepted: true, secretVersion: V`.
5. Local metadata updated: `serverVersion: V`, `syncStatus: 'synced'`.

### Phase 3: Logout & Lock (Device A)

1. User logs out.
2. `lockAccountAI()` executes:
   - Active session token, device credentials, and derived `CryptoKey` are purged from memory.
   - Queue promises are reset.
   - `aiManager.clearCredentialCache()` drops cached API keys.
   - UI status transitions to `'signed_out'`.

### Phase 4: Restoration on Device B

1. User logs into Device B with their account credentials.
2. `unlockAccountAI(userId, password)`:
   - Registers Device B (`pharmatrack_ai_register_device`).
   - Retrieves `vaultSalt` from server.
   - Derives identical `CryptoKey` using PBKDF2-SHA-256.
   - Fetches encrypted secret rows (`pharmatrack_ai_get_secrets`).
   - Decrypts each envelope with vault key and verified AAD.
   - Persists decrypted credentials to Device B's local device-encrypted vault.
   - Metadata populated: `hasKey: true`, `accountConfigured: true`, `maskedSuffix: ••••<last4>`, `serverVersion: V`, `syncStatus: 'synced'`.
   - Notifies `AIManager` on Device B.
3. AI requests on Device B execute successfully using the recovered key without user re-entry.

### Phase 5: Key Replacement (Device A → Device B)

1. On Device A, user replaces key.
2. Local version increments, new envelope encrypted with vault key, pushed with `p_base_version = V`.
3. Server updates `secret_version = V+1`.
4. When Device B synchronizes:
   - Remote version `V+1 > local serverVersion V`.
   - Device B decrypts new envelope and calls `replaceCredentialsFromAccount`.
   - Local vault updated; `AIManager` clears credential cache and picks up the new key.
   - Masked suffix reflects the new key.

### Phase 6: Key Revocation / Removal (Device B → Device A)

1. On Device B, user clicks "Remove key".
2. Device B removes credential locally (`deleteCredentialsLocal`), updates metadata to `hasKey: false`, records audit `'provider removed'`, and queues deletion.
3. Server executes `pharmatrack_ai_delete_secret`: row is removed from `pharmatrack_ai_secrets`.
4. When Device A synchronizes:
   - Device A detects `remote` is absent for this provider, while local `serverVersion` was set and not pending.
   - Device A recognizes remote deletion: calls `deleteCredentialsLocal(providerId)`.
   - Device A clears `AIManager` credential cache.
   - Credential is no longer usable on Device A; requests requiring an API key fail.

### Phase 7: Device Revocation & Account Deletion

- **Device Revocation**: Calling `revokeAccountDevice(targetDeviceId)` invalidates the device token in `pharmatrack_ai_devices`. Any subsequent request from that device receives `AI device session is revoked or invalid` and transitions to `'revoked'`.
- **Account Deletion**: Calling `deleteAccountAIData()` deletes all user devices, configurations, and encrypted secrets from the database. Local stores are purged via `clearAllCredentials()`.

---

## 5. Provider Manager Credential Resolution Flow

```text
UI (Settings, Chat, Practice)
      │
      ▼
AIManager (central orchestrator)
      │
      ▼
CredentialResolver (`resolve(providerId)`)
      │
      ▼
Secure Storage Vault (AES-GCM device store / transient memory cache)
      │
      ▼
ProviderAdapter (`complete()` / `stream()` / `probe()`)
      │
      ▼
AI Service Provider (NVIDIA, Gemini, OpenAI, Anthropic, Groq, etc.)
```

1. UI components call high-level methods on `AIManager` (`generate()`, `stream()`, `testConnection()`).
2. UI passes **no** API keys or secret credentials.
3. `AIManager` resolves the credentials internally via its `CredentialResolver`.
4. If a key is required and missing or locked, `AIManager` returns a typed `AIEngineError({ category: 'API_KEY_REQUIRED' })` with clear remediation advice.
5. The adapter attaches credentials solely to authorized HTTP headers (or local runtime config).

---

## 6. Safe Audit Trail

Audit records capture system actions without ever logging secret material:

| Permitted Action          | Safe Metadata Recorded                             | Prohibited Data                              |
| :------------------------ | :------------------------------------------------- | :------------------------------------------- |
| `provider configured`     | `providerId`, `maskedSuffix`, `timestamp`          | Raw API key, request bodies                  |
| `provider updated`        | `providerId`, `maskedSuffix`, `timestamp`          | Raw API key, diffs of secrets                |
| `provider removed`        | `providerId`, `timestamp`                          | Any secret or previous key                   |
| `provider test succeeded` | `providerId`, `model`, `latencyMs`, `timestamp`    | Raw API key, full model outputs              |
| `provider test failed`    | `providerId`, `model`, `errorSummary`, `timestamp` | Raw API key, network error dumps with tokens |
