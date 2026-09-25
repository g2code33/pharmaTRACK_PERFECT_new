# PharmaTRACK Cloudflare Web, API, and Storage Foundation

This repository now has a Cloudflare Pages PWA + Worker API + R2 boundary. The Pages projects provide the public `pages.dev` website; the Worker projects provide the authenticated API and private R2 boundary. The Worker also retains a Static Assets binding for local development and direct Worker fallback. It is deliberately additive: it does not migrate the existing academic workspace out of IndexedDB/local storage and it does not replace Supabase.

## Responsibility split

| System | Responsibility |
| --- | --- |
| Supabase | Authentication, `auth.users.id`, account-owned relational data, RLS, sync metadata, and the `storage_objects` metadata table |
| Cloudflare Worker API | Supabase bearer verification, authorization boundary, validation, rate limiting, and R2 operations |
| Cloudflare Pages | Vite production output and the public `pages.dev` PWA shell |
| Worker Static Assets binding | Local development and direct Worker fallback; it is not the canonical public website |
| Cloudflare R2 | Large PDF, PPTX, DOCX, image, `.pharmaexam`, backup, and other binary objects |
| Device | IndexedDB, offline workspace, cached materials, encrypted examination state, and pending synchronization |

The Worker generates object IDs and keys in the form:

```text
objects/<supabase-user-uuid>/<server-generated-uuid>.<validated-extension>
```

Original filenames never become object paths. R2 bytes are private and metadata is stored in Supabase. The browser receives only a public metadata projection and a bearer-protected Worker URL; it never receives R2 credentials or arbitrary object paths.

## Files

- `wrangler.toml` — local, staging, and production Worker API/Assets/R2 environments.
- `cloudflare/worker/src/index.ts` — Worker API and Static Assets fallback boundary.
- `src/cloudflare/storageClient.ts` — browser client using a build-time Worker API origin and Supabase sessions.
- `supabase/cloudflare-storage.sql` — account-owned R2 metadata table and RLS policies.
- `scripts/cloudflare-smoke.mjs` — real deployment smoke test against the Worker API.
- `.github/workflows/cloudflare.yml` — automatic Pages + Worker deployment workflow.

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
npx wrangler pages project create pharmatrack-web --production-branch main
npx wrangler pages project create pharmatrack-web-staging --production-branch main
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

The canonical website origins are `https://pharmatrack-web.pages.dev` for production and `https://pharmatrack-web-staging.pages.dev` for staging. These exact Pages origins are already the staging/production `CORS_ORIGINS` values in `wrangler.toml`. Do not use `*`, a path wildcard, or an origin that is not controlled by PharmaTRACK.

The API Worker origins are separate: `https://pharmatrack-api-production.g2code331.workers.dev` and `https://pharmatrack-api-staging.g2code331.workers.dev`. The Pages build receives the appropriate API origin through `VITE_CLOUDFLARE_API_BASE_URL`; browser storage requests therefore go to the Worker API even though the website itself is served from `pages.dev`.

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

After the Supabase metadata migration, Pages projects, R2 buckets, exact CORS origins, Worker secret, and build-time API origins are configured:

```bash
npm run build
npx wrangler deploy --env staging --config wrangler.toml
npx wrangler pages deploy dist --project-name pharmatrack-web-staging --branch main

npm run build
npx wrangler deploy --env production --config wrangler.toml
npx wrangler pages deploy dist --project-name pharmatrack-web --branch main
```

The GitHub workflow automatically deploys the production Worker API and the `pharmatrack-web.pages.dev` Pages site on every push to `main` after the full test suite, Worker typecheck, and PWA build pass. It runs the authenticated smoke test against the Worker API for those production deployments when the configured smoke variables and short-lived test-user token are available; an expired or missing short-lived token does not block the build/deploy. Manual `workflow_dispatch` runs remain available for explicitly selecting staging or production, and a manual run that requests smoke testing requires all smoke inputs. The workflow requires Cloudflare credentials in the GitHub/Arena environment. The repository does not contain Cloudflare API tokens, R2 access keys, service-role keys, or test-user tokens.

Configure the GitHub `production` Environment before enabling automatic main deployments:

- Required secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`.
- Optional smoke-test secret: `CLOUDFLARE_TEST_ACCESS_TOKEN`.
- Required variables: `CLOUDFLARE_PAGES_PROJECT` and `CLOUDFLARE_API_BASE_URL`.
- Optional smoke-test variable: `CLOUDFLARE_TEST_ORIGIN`.

For the `production` Environment use:

```text
CLOUDFLARE_PAGES_PROJECT=pharmatrack-web
CLOUDFLARE_API_BASE_URL=https://pharmatrack-api-production.g2code331.workers.dev
CLOUDFLARE_TEST_ORIGIN=https://pharmatrack-web.pages.dev
```

For the `staging` Environment use:

```text
CLOUDFLARE_PAGES_PROJECT=pharmatrack-web-staging
CLOUDFLARE_API_BASE_URL=https://pharmatrack-api-staging.g2code331.workers.dev
CLOUDFLARE_TEST_ORIGIN=https://pharmatrack-web-staging.pages.dev
```

When all smoke-test values are present, every main push also runs the authenticated smoke test against the Worker API. Without them, the Pages and Worker deployment still run and the workflow reports that smoke testing was skipped. The production environment should use required reviewers if the repository wants an approval gate; otherwise every successful push to `main` deploys automatically.

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
