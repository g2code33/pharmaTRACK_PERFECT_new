#!/usr/bin/env node

/**
 * Production/staging smoke test. It intentionally requires a real Supabase
 * access token: a health check alone cannot prove authentication, R2 upload,
 * metadata authorization, or private retrieval.
 *
 * Usage:
 *   CLOUDFLARE_API_BASE_URL=https://... \
 *   CLOUDFLARE_TEST_ACCESS_TOKEN='short-lived-test-user-token' \
 *   node scripts/cloudflare-smoke.mjs
 *
 * The token is read from the environment only and is never printed.
 */

const base = (process.env.CLOUDFLARE_API_BASE_URL || '').replace(/\/$/, '');
const token = process.env.CLOUDFLARE_TEST_ACCESS_TOKEN;
const origin = process.env.CLOUDFLARE_TEST_ORIGIN || 'http://localhost:5173';

if (!base || !token) {
  console.error('Set CLOUDFLARE_API_BASE_URL and CLOUDFLARE_TEST_ACCESS_TOKEN before running the smoke test.');
  process.exit(2);
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const body = await response.text();
    throw new Error(`${label}: expected ${expected}, received ${response.status}: ${body.slice(0, 500)}`);
  }
}

const health = await fetch(`${base}/api/healthz`, { headers: { Origin: origin } });
await expectStatus(health, 200, 'health check');

const unauthorized = await fetch(`${base}/api/v1/objects`, {
  method: 'POST',
  headers: {
    Origin: origin,
    'Content-Type': 'application/pdf',
    'X-PharmaTrack-File-Name': 'unauthorized.pdf',
  },
  body: '%PDF-1.7\nunauthorized',
});
await expectStatus(unauthorized, 401, 'unauthorized upload rejection');

const invalid = await fetch(`${base}/api/v1/objects`, {
  method: 'POST',
  headers: {
    Origin: origin,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/pdf',
    'X-PharmaTrack-File-Name': 'invalid.pdf',
  },
  body: 'not a PDF',
});
await expectStatus(invalid, 415, 'invalid file rejection');

const bytes = new TextEncoder().encode('%PDF-1.7\nPharmaTRACK Cloudflare smoke test');
const upload = await fetch(`${base}/api/v1/objects`, {
  method: 'POST',
  headers: {
    Origin: origin,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/pdf',
    'Content-Length': String(bytes.byteLength),
    'X-PharmaTrack-File-Name': 'cloudflare-smoke.pdf',
  },
  body: bytes,
});
await expectStatus(upload, 201, 'authenticated R2 upload');
const uploadBody = await upload.json();
const objectId = uploadBody?.object?.id;
if (!objectId || uploadBody.object.account_id || uploadBody.object.object_key) {
  throw new Error('Upload response did not return a safe public metadata shape.');
}

const metadata = await fetch(`${base}/api/v1/objects/${encodeURIComponent(objectId)}/metadata`, {
  headers: { Origin: origin, Authorization: `Bearer ${token}` },
});
await expectStatus(metadata, 200, 'metadata retrieval');

const download = await fetch(`${base}/api/v1/objects/${encodeURIComponent(objectId)}`, {
  headers: { Origin: origin, Authorization: `Bearer ${token}` },
});
await expectStatus(download, 200, 'private R2 retrieval');
const downloaded = new Uint8Array(await download.arrayBuffer());
if (new TextDecoder().decode(downloaded) !== new TextDecoder().decode(bytes)) {
  throw new Error('Retrieved bytes did not match uploaded bytes.');
}
if (download.headers.get('Cache-Control') !== 'private, no-store') {
  throw new Error('Private object response is missing no-store cache protection.');
}

const deleted = await fetch(`${base}/api/v1/objects/${encodeURIComponent(objectId)}`, {
  method: 'DELETE',
  headers: { Origin: origin, Authorization: `Bearer ${token}` },
});
await expectStatus(deleted, 204, 'private R2 deletion');

const gone = await fetch(`${base}/api/v1/objects/${encodeURIComponent(objectId)}`, {
  headers: { Origin: origin, Authorization: `Bearer ${token}` },
});
await expectStatus(gone, 404, 'deleted object rejection');

console.log('Cloudflare smoke test passed: health, auth rejection, invalid file rejection, R2 upload, metadata, retrieval, and deletion.');
