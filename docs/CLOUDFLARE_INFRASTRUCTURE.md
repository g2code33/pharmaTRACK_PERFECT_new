# PharmaTRACK Cloudflare Web, API, and Storage Foundation

This repository now has a Cloudflare Worker + Static Assets + R2 boundary. It is deliberately additive: it does not migrate the existing academic workspace out of IndexedDB/local storage and it does not replace Supabase.

## Responsibility split

| System | Responsibility |
| --- | --- |
| Supabase | Authentication, `auth.users.id`, account-owned relational data, RLS, sync metadata, and the `storage_objects` metadata table |
| Cloudflare Worker | Same-origin PWA/API entry point, Supabase bearer verification, authorization boundary, validation, rate limiting, and R2 operations |
| Cloudflare Static Assets | Vite production output and the public PWA shell |
| Cloudflare R2 | Large PDF, PPTX, DOCX, image, `.pharmaexam`, backup, and other binary objects |
| Device | IndexedDB, offline workspace, cached materials, encrypted examination state, and pending synchronization |

The Worker generates object IDs and keys in the form:

```text
objects/<supabase-user-uuid>/<server-generated-uuid>.<validated-extension>
```

Original filenames never become object paths. R2 bytes are private and metadata is stored in Supabase. The browser receives only a public metadata projection and a bearer-protected Worker URL; it never receives R2 credentials or arbitrary object paths.

## Files

- `wrangler.toml` — local, staging, and production Worker/Assets/R2 environments.
- `cloudflare/worker/src/index.ts` — Worker API and Static Assets boundary.
- `src/cloudflare/storageClient.ts` — browser client using relative `/api/v1` URLs and Supabase sessions.
- `supabase/cloudflare-storage.sql` — account-owned R2 metadata table and RLS policies.
- `scripts/cloudflare-smoke.mjs` — real deployment smoke test.
- `.github/workflows/cloudflare.yml` — manual deployment workflow.

The existing PWA service worker remains public-shell-only. It refuses to cache requests with `Authorization` and excludes `/api`, auth, Supabase, and examination data paths. Private R2 responses use `Cache-Control: private, no-store`.

## One-time Supabase setup

Run the existing migrations first, then the new metadata migration:

```text
supabase/security-rls.sql
supabase/authentication.sql
supabase/cloudflare-storage.sql
```

`cloudflare-storage.sql` stores metadata only. It does not move existing local records or upload existing materials automatically. Existing academic material remains device-local until a future, explicit sync/import feature chooses to upload it.

## Cloudflare setup

Authenticate Wrangler from a Cloudflare-connected environment, not from chat:

```bash
npx wrangler login
npx wrangler r2 bucket create pharmatrack-objects-staging
npx wrangler r2 bucket create pharmatrack-objects-production
```

Local development needs a local publishable Supabase key in the ignored `.dev.vars` file:

```dotenv
SUPABASE_ANON_KEY=your-publishable-supabase-key
```

For deployed environments, set the Worker secret through Wrangler or the Cloudflare dashboard. This is a publishable Supabase key, not a service-role key, but it is still kept out of source control:

```bash
printf '%s' "$VITE_SUPABASE_ANON_KEY" | npx wrangler secret put SUPABASE_ANON_KEY --env staging
printf '%s' "$VITE_SUPABASE_ANON_KEY" | npx wrangler secret put SUPABASE_ANON_KEY --env production
```

Before staging or production deployment, replace the explicit placeholder `CORS_ORIGINS` values in `wrangler.toml` with the exact web origin(s). Do not use `*`, a path wildcard, or an origin that is not controlled by PharmaTRACK. If the PWA and Worker are same-origin, one exact origin is sufficient.

The R2 bucket names and Worker names are intentionally environment-specific. The production configuration currently uses `workers_dev = true` so it can be smoke-tested without inventing a DNS zone. Attach a controlled custom domain/route after the production hostname is known, then set that exact hostname in `CORS_ORIGINS`.

## Local Worker/API test

Build the static assets and start the local Worker:

```bash
npm run cf:dev
```

That runs Wrangler's local R2 emulator and serves the Vite output through the Worker. A health check does not prove authentication or R2 authorization; use the smoke test with a short-lived Supabase test-user access token:

```bash
CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8787 \
CLOUDFLARE_TEST_ACCESS_TOKEN='short-lived-token' \
CLOUDFLARE_TEST_ORIGIN=http://localhost:5173 \
npm run cf:smoke
```

The smoke test verifies:

- public health endpoint;
- missing-token rejection;
- invalid file signature rejection;
- authenticated R2 upload;
- Supabase metadata creation;
- private metadata and binary retrieval;
- private deletion and post-delete 404;
- no public object key/account ID in the browser response;
- no-store caching for private object bytes.

## Deployment

After the Supabase metadata migration, R2 buckets, exact CORS origins, and Worker secret are configured:

```bash
npm run cf:deploy:staging
npm run cf:deploy:production
```

The GitHub workflow is manual by design. It requires Cloudflare credentials in GitHub/Arena integration and a short-lived test-user token if the post-deploy smoke step is enabled. The repository does not contain Cloudflare API tokens, R2 access keys, service-role keys, or test-user tokens.

## API surface

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/healthz` | no | Deployment health only |
| POST | `/api/v1/objects` | Supabase bearer | Validated direct upload for files up to 100 MiB |
| GET/HEAD | `/api/v1/objects/:id` | Supabase bearer | Account-authorized private retrieval |
| GET | `/api/v1/objects/:id/metadata` | Supabase bearer | Account-authorized metadata |
| DELETE | `/api/v1/objects/:id` | Supabase bearer | Account-authorized deletion |
| POST | `/api/v1/uploads` | Supabase bearer | Start an R2 multipart upload |
| PUT | `/api/v1/uploads/:id/parts/:number` | Supabase bearer | Upload a multipart part |
| POST | `/api/v1/uploads/:id/complete` | Supabase bearer | Complete a multipart upload |
| DELETE | `/api/v1/uploads/:id/abort` | Supabase bearer | Abort a multipart upload |

Supported direct types are PDF, PPTX, DOCX, PNG/JPEG/WEBP/GIF, `.pharmaexam`/ZIP, and JSON backups. Filename extension, content type, size, and magic bytes are checked. The Worker also applies an optional Cloudflare Rate Limit binding per account and route.

## Deployment status

The source-level foundation and local Worker contract tests are included. A production deployment is **not claimed by this repository change until Cloudflare authentication, bucket creation, the exact web origins, the Supabase metadata migration, and a real `scripts/cloudflare-smoke.mjs` run have succeeded**. Those steps require access to the target Cloudflare account and a real test-user token; they are intentionally not fabricated in code or committed to Git.
