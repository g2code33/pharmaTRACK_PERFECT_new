# Normal account synchronization

PharmaTRACK has two different persistence authorities:

- **Normal account sync** (`src/account/sync.ts`) is for a small allowlisted set
  of account-owned settings. It is keyed only by the authenticated
  `auth.users.id`.
- **The local/examination stores** remain the authority for the academic
  workspace, downloaded material, temporary UI/cache data, encrypted offline
  examination state, and LAN/high-availability examination sessions.

The normal sync layer never serializes `AppState`, scans IndexedDB, uploads
files, or moves examination records into Supabase.

## Records that may sync

| Record ID           | Type                   | Contents                                         |
| ------------------- | ---------------------- | ------------------------------------------------ |
| `profile`           | `profile_preferences`  | name, university, level, program, semester       |
| application-defined | `application_settings` | theme, compact mode, notifications, language     |
| application-defined | `ai_profile_selection` | selected AI profile ID                           |
| application-defined | `permitted_data`       | only the versioned `study_preferences` allowlist |

Provider configuration and encrypted provider credentials continue to use the
existing AI account-sync contract. Credentials are never included in a normal
account payload.

Adding another record requires updating the TypeScript payload allowlist, the
SQL trigger allowlist, and tests. In particular, course, topic, slide, note,
quiz, question, timetable, clinical case, file, answer, attempt, and
examination fields are not permitted record types.

## Offline and conflict behavior

1. `queueAccountRecord` writes the sanitized value to a user-namespaced
   IndexedDB queue before attempting the network.
2. The queue records the stable record ID, base server version, device ID,
   timestamp, and retry count.
3. Recovery pulls the authenticated user's records, then pushes only changes
   whose base version still matches.
4. A newer remote version creates a visible `conflict` state. The local and
   remote values are both retained; neither is silently overwritten.
5. `resolveAccountSyncConflict(userId, recordId, 'remote')` keeps the newer
   remote value. The `'local'` choice retries the local value against the
   remote version and still receives a server-side conflict if another device
   changes it first.
6. Logout ends the active sync session but leaves the user-namespaced pending
   queue so the same user can continue offline and restore it after login.
   Another authenticated user cannot read that queue. Account deletion clears
   the local queue after the authenticated deletion RPC succeeds; the foreign
   key cascade removes the server rows.

An expired or revoked authenticated session is reported as `revoked`; local
settings remain available, but no remote read or write is accepted until the
user signs in again.

## Supabase deployment

Run `supabase/account-sync.sql` after `authentication.sql` and
`security-rls.sql` in the target Supabase project. The migration creates:

- `pharmatrack_account_sync_records`, with ownership RLS and optimistic
  versions;
- `pharmatrack_account_sync_cursors`, with ownership RLS for pull/push
  metadata;
- `pharmatrack_account_sync_pull()` and
  `pharmatrack_account_sync_push(...)`, which derive ownership from
  `auth.uid()` and never accept a user ID from the browser.

Direct table access is revoked from `anon` and `authenticated`; the RPCs are
the narrow browser boundary. The policies remain explicit, including both
`USING (auth.uid() = user_id)` and `WITH CHECK (auth.uid() = user_id)` on
updates. Apply and verify the migration in the real Supabase project before
claiming production synchronization.
