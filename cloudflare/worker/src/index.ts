import type { R2Bucket, R2MultipartUpload, R2UploadedPart } from '@cloudflare/workers-types';

const API_PREFIX = '/api/v1';
const MAX_METADATA_BODY = 16 * 1024;
const MAX_MULTIPART_PART_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID = UUID;

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  R2_OBJECTS: R2Bucket;
  SUPABASE_URL: string;
  /** Publishable Supabase key. It is never returned to the browser by this Worker. */
  SUPABASE_ANON_KEY: string;
  CORS_ORIGINS: string;
  ENVIRONMENT?: 'local' | 'staging' | 'production' | string;
  RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

interface Identity {
  id: string;
}

interface AssetPolicy {
  kind: AssetKind;
  extension: string;
  maxBytes: number;
  contentTypes: string[];
}

export type AssetKind = 'pdf' | 'pptx' | 'docx' | 'image' | 'pharmaexam' | 'backup';

export interface AssetRecord {
  id: string;
  account_id: string;
  object_key: string;
  original_name: string;
  asset_kind: AssetKind;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  status: 'uploading' | 'ready';
  created_at: string;
  updated_at: string;
}

const POLICIES: Record<string, AssetPolicy> = {
  pdf: { kind: 'pdf', extension: 'pdf', maxBytes: 100 * 1024 * 1024, contentTypes: ['application/pdf'] },
  pptx: {
    kind: 'pptx',
    extension: 'pptx',
    maxBytes: 100 * 1024 * 1024,
    contentTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  },
  docx: {
    kind: 'docx',
    extension: 'docx',
    maxBytes: 100 * 1024 * 1024,
    contentTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  png: { kind: 'image', extension: 'png', maxBytes: 15 * 1024 * 1024, contentTypes: ['image/png'] },
  jpg: { kind: 'image', extension: 'jpg', maxBytes: 15 * 1024 * 1024, contentTypes: ['image/jpeg'] },
  jpeg: { kind: 'image', extension: 'jpeg', maxBytes: 15 * 1024 * 1024, contentTypes: ['image/jpeg'] },
  webp: { kind: 'image', extension: 'webp', maxBytes: 15 * 1024 * 1024, contentTypes: ['image/webp'] },
  gif: { kind: 'image', extension: 'gif', maxBytes: 15 * 1024 * 1024, contentTypes: ['image/gif'] },
  pharmaexam: {
    kind: 'pharmaexam',
    extension: 'pharmaexam',
    maxBytes: 100 * 1024 * 1024,
    contentTypes: ['application/zip', 'application/octet-stream', 'application/vnd.pharmatrack.pharmaexam'],
  },
  zip: { kind: 'backup', extension: 'zip', maxBytes: 100 * 1024 * 1024, contentTypes: ['application/zip'] },
  json: { kind: 'backup', extension: 'json', maxBytes: 100 * 1024 * 1024, contentTypes: ['application/json'] },
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'request_failed') {
    super(message);
  }
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.CORS_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function originIsAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  return !origin || allowedOrigins(env).has(origin);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-PharmaTrack-File-Name, X-PharmaTrack-Asset-Type, X-PharmaTrack-SHA256, X-R2-Upload-Id',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function json(request: Request, env: Env, body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(request: Request, env: Env, error: unknown): Response {
  const normalized = error instanceof HttpError
    ? error
    : new HttpError(500, 'The storage operation could not be completed.', 'internal_error');
  if (!(error instanceof HttpError)) console.error('Cloudflare storage API error:', error);
  return json(request, env, { error: normalized.code, message: normalized.message }, normalized.status);
}

function bearerToken(request: Request): string {
  const value = request.headers.get('Authorization') || '';
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw new HttpError(401, 'A Supabase access token is required.', 'missing_token');
  return match[1];
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Auth is intentionally delegated to Supabase Auth. The Worker never receives
 * a service-role key and never trusts an account ID supplied by the browser.
 * /auth/v1/user validates both legacy HMAC and newer asymmetric Supabase JWTs.
 */
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  const token = bearerToken(request);
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new HttpError(503, 'Authentication verification is not configured.', 'auth_not_configured');
  }

  let response: Response;
  try {
    response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new HttpError(503, 'Authentication verification is temporarily unavailable.', 'auth_unavailable');
  }
  if (!response.ok) throw new HttpError(401, 'The Supabase session is invalid or expired.', 'invalid_token');

  const payload = await response.json() as { id?: unknown; user?: { id?: unknown } };
  const id = validUuid(payload.id) ? payload.id : payload.user?.id;
  if (!validUuid(id)) throw new HttpError(401, 'Supabase did not return a valid account identity.', 'invalid_identity');
  return { id };
}

async function enforceRateLimit(request: Request, env: Env, identity: Identity): Promise<void> {
  if (!env.RATE_LIMITER) return;
  const path = new URL(request.url).pathname;
  const result = await env.RATE_LIMITER.limit({ key: `${identity.id}:${path}` });
  if (!result.success) throw new HttpError(429, 'Too many storage requests. Try again shortly.', 'rate_limited');
}

function accountKey(accountId: string, objectId: string, extension: string): string {
  // Both components are server-validated UUIDs. The original filename never
  // becomes part of an R2 key, so traversal and arbitrary prefixes are absent.
  if (!validUuid(accountId) || !OBJECT_ID.test(objectId)) throw new HttpError(400, 'Invalid object identity.', 'invalid_object_id');
  return `objects/${accountId}/${objectId}.${extension}`;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function safeFileName(value: string | null): string {
  if (!value || value.length > 180 || hasControlCharacter(value) || /[\\/]/.test(value)) {
    throw new HttpError(400, 'A safe filename without path separators is required.', 'invalid_filename');
  }
  if (!/^[^"']+\.[a-z0-9]{1,12}$/i.test(value)) {
    throw new HttpError(400, 'The filename must include a supported extension.', 'invalid_filename');
  }
  return value;
}

function policyFor(name: string, contentType: string, requestedKind?: string): AssetPolicy {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const policy = POLICIES[extension];
  if (!policy || !policy.contentTypes.includes(contentType)) {
    throw new HttpError(415, 'The filename and content type are not an allowed academic file.', 'invalid_file_type');
  }
  if (requestedKind && requestedKind !== policy.kind) {
    throw new HttpError(415, 'The declared asset kind does not match the filename.', 'invalid_asset_kind');
  }
  return policy;
}

function contentType(request: Request): string {
  const value = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!value) throw new HttpError(415, 'Content-Type is required.', 'missing_content_type');
  return value;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

async function prefixOf(stream: ReadableStream<Uint8Array>, limit = 32): Promise<Uint8Array> {
  const reader = stream.getReader();
  let result = new Uint8Array();
  try {
    while (result.byteLength < limit) {
      const next = await reader.read();
      if (next.done) break;
      result = concatBytes(result, next.value).slice(0, limit);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return result;
}

function startsWithBytes(value: Uint8Array, expected: number[]): boolean {
  return expected.every((byte, index) => value[index] === byte);
}

function isZip(value: Uint8Array): boolean {
  return startsWithBytes(value, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(value, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(value, [0x50, 0x4b, 0x07, 0x08]);
}

function validateMagic(policy: AssetPolicy, prefix: Uint8Array): void {
  const valid = policy.kind === 'pdf'
    ? startsWithBytes(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])
    : policy.kind === 'pptx' || policy.kind === 'docx' || policy.kind === 'pharmaexam' || policy.extension === 'zip'
      ? isZip(prefix)
      : policy.extension === 'png'
        ? startsWithBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : policy.extension === 'jpg' || policy.extension === 'jpeg'
          ? startsWithBytes(prefix, [0xff, 0xd8, 0xff])
          : policy.extension === 'gif'
            ? startsWithBytes(prefix, [0x47, 0x49, 0x46, 0x38])
            : policy.extension === 'webp'
              ? startsWithBytes(prefix, [0x52, 0x49, 0x46, 0x46]) &&
                startsWithBytes(prefix.slice(8), [0x57, 0x45, 0x42, 0x50])
              : policy.extension === 'json' && (prefix[0] === 0x7b || prefix[0] === 0x5b);
  if (!valid) throw new HttpError(415, 'The file signature does not match its declared type.', 'invalid_file_signature');
}

function limitedStream(body: ReadableStream<Uint8Array>, maxBytes: number): { stream: ReadableStream<Uint8Array>; getSize: () => number } {
  let size = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        controller.error(new HttpError(413, 'The file is larger than the allowed limit.', 'file_too_large'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return { stream: body.pipeThrough(limiter), getSize: () => size };
}

function requestLength(request: Request): number | null {
  const value = request.headers.get('Content-Length');
  if (!value) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new HttpError(400, 'Invalid Content-Length.', 'invalid_content_length');
  return number;
}

function metadataHeaders(env: Env, token: string, extra?: HeadersInit): Headers {
  const headers = new Headers({
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

function supabaseRestUrl(env: Env, table: string): string {
  return `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`;
}

async function readRecord(request: Request, env: Env, token: string, accountId: string, objectId: string): Promise<AssetRecord | null> {
  const url = new URL(supabaseRestUrl(env, 'storage_objects'));
  url.searchParams.set('select', 'id,account_id,object_key,original_name,asset_kind,content_type,size_bytes,sha256,status,created_at,updated_at');
  url.searchParams.set('id', `eq.${objectId}`);
  url.searchParams.set('account_id', `eq.${accountId}`);
  const response = await fetch(url, { headers: metadataHeaders(env, token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new HttpError(503, 'Storage metadata is temporarily unavailable.', 'metadata_unavailable');
  const rows = await response.json() as AssetRecord[];
  return rows[0] || null;
}

async function insertRecord(env: Env, token: string, record: AssetRecord): Promise<void> {
  const response = await fetch(supabaseRestUrl(env, 'storage_objects'), {
    method: 'POST',
    headers: metadataHeaders(env, token, { Prefer: 'return=minimal' }),
    body: JSON.stringify(record),
  });
  if (!response.ok) throw new HttpError(503, 'Storage metadata could not be saved.', 'metadata_write_failed');
}

async function patchRecord(env: Env, token: string, accountId: string, objectId: string, patch: Partial<AssetRecord>): Promise<void> {
  const url = new URL(supabaseRestUrl(env, 'storage_objects'));
  url.searchParams.set('id', `eq.${objectId}`);
  url.searchParams.set('account_id', `eq.${accountId}`);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: metadataHeaders(env, token, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new HttpError(503, 'Storage metadata could not be updated.', 'metadata_write_failed');
}

async function deleteRecord(env: Env, token: string, accountId: string, objectId: string): Promise<void> {
  const url = new URL(supabaseRestUrl(env, 'storage_objects'));
  url.searchParams.set('id', `eq.${objectId}`);
  url.searchParams.set('account_id', `eq.${accountId}`);
  const response = await fetch(url, {
    method: 'DELETE',
    headers: metadataHeaders(env, token, { Prefer: 'return=minimal' }),
  });
  if (!response.ok) throw new HttpError(503, 'Storage metadata could not be deleted.', 'metadata_delete_failed');
}

function publicRecord(record: AssetRecord): Omit<AssetRecord, 'object_key' | 'account_id'> {
  const { object_key: _objectKey, account_id: _accountId, ...safe } = record;
  return safe;
}

function objectIdFromPath(path: string, segment: number): string {
  const id = path.split('/')[segment] || '';
  if (!OBJECT_ID.test(id)) throw new HttpError(400, 'The object ID is invalid.', 'invalid_object_id');
  return id;
}

async function uploadObject(request: Request, env: Env, identity: Identity, token: string): Promise<Response> {
  const fileName = safeFileName(request.headers.get('X-PharmaTrack-File-Name'));
  const type = contentType(request);
  const policy = policyFor(fileName, type, request.headers.get('X-PharmaTrack-Asset-Type') || undefined);
  const declaredSize = requestLength(request);
  if (declaredSize !== null && (declaredSize <= 0 || declaredSize > policy.maxBytes)) {
    throw new HttpError(413, 'The file is larger than the allowed limit.', 'file_too_large');
  }
  if (!request.body) throw new HttpError(400, 'A file body is required.', 'missing_body');

  const [inspectionBody, uploadBody] = request.body.tee();
  validateMagic(policy, await prefixOf(inspectionBody));
  const limited = limitedStream(uploadBody, policy.maxBytes);
  const objectId = crypto.randomUUID();
  const key = accountKey(identity.id, objectId, policy.extension);
  try {
    await env.R2_OBJECTS.put(key, limited.stream, {
      httpMetadata: { contentType: type, cacheControl: 'private, no-store' },
      customMetadata: { accountId: identity.id, objectId, assetKind: policy.kind, originalName: fileName },
    });
    const size = limited.getSize();
    if (size <= 0) throw new HttpError(400, 'The file body is empty.', 'empty_file');
    const record: AssetRecord = {
      id: objectId,
      account_id: identity.id,
      object_key: key,
      original_name: fileName,
      asset_kind: policy.kind,
      content_type: type,
      size_bytes: size,
      sha256: request.headers.get('X-PharmaTrack-SHA256'),
      status: 'ready',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await insertRecord(env, token, record);
    return json(request, env, { object: publicRecord(record) }, 201);
  } catch (error) {
    await env.R2_OBJECTS.delete(key).catch(() => undefined);
    throw error;
  }
}

async function getObject(request: Request, env: Env, identity: Identity, token: string, objectId: string): Promise<Response> {
  const record = await readRecord(request, env, token, identity.id, objectId);
  if (!record || record.status !== 'ready') throw new HttpError(404, 'Object not found.', 'not_found');
  const object = await env.R2_OBJECTS.get(record.object_key);
  if (!object) throw new HttpError(404, 'Object not found.', 'not_found');
  const headers = corsHeaders(request, env);
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Disposition', 'inline');
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

async function getMetadata(request: Request, env: Env, identity: Identity, token: string, objectId: string): Promise<Response> {
  const record = await readRecord(request, env, token, identity.id, objectId);
  if (!record) throw new HttpError(404, 'Object not found.', 'not_found');
  return json(request, env, { object: publicRecord(record) });
}

async function deleteObject(request: Request, env: Env, identity: Identity, token: string, objectId: string): Promise<Response> {
  const record = await readRecord(request, env, token, identity.id, objectId);
  if (!record) throw new HttpError(404, 'Object not found.', 'not_found');
  await env.R2_OBJECTS.delete(record.object_key);
  await deleteRecord(env, token, identity.id, objectId);
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = requestLength(request);
  if (length !== null && length > MAX_METADATA_BODY) throw new HttpError(413, 'Metadata request is too large.', 'metadata_too_large');
  const text = await request.text();
  if (text.length > MAX_METADATA_BODY) throw new HttpError(413, 'Metadata request is too large.', 'metadata_too_large');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'A JSON object is required.', 'invalid_json');
  }
}

function multipartPolicy(input: Record<string, unknown>): { name: string; type: string; policy: AssetPolicy; size: number; sha256: string | null } {
  const name = safeFileName(typeof input.name === 'string' ? input.name : null);
  const type = typeof input.contentType === 'string' ? input.contentType.toLowerCase() : '';
  const policy = policyFor(name, type, typeof input.assetKind === 'string' ? input.assetKind : undefined);
  const size = input.size;
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > policy.maxBytes) {
    throw new HttpError(413, 'The declared file size is outside the allowed limit.', 'file_too_large');
  }
  const sha256 = typeof input.sha256 === 'string' ? input.sha256 : null;
  return { name, type, policy, size: size as number, sha256 };
}

async function initiateMultipart(request: Request, env: Env, identity: Identity, token: string): Promise<Response> {
  const input = multipartPolicy(await readJson(request));
  const objectId = crypto.randomUUID();
  const key = accountKey(identity.id, objectId, input.policy.extension);
  const upload = await env.R2_OBJECTS.createMultipartUpload(key, {
    httpMetadata: { contentType: input.type, cacheControl: 'private, no-store' },
    customMetadata: { accountId: identity.id, objectId, assetKind: input.policy.kind, originalName: input.name },
  });
  const now = new Date().toISOString();
  const record: AssetRecord = {
    id: objectId,
    account_id: identity.id,
    object_key: key,
    original_name: input.name,
    asset_kind: input.policy.kind,
    content_type: input.type,
    size_bytes: input.size,
    sha256: input.sha256,
    status: 'uploading',
    created_at: now,
    updated_at: now,
  };
  try {
    await insertRecord(env, token, record);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  return json(request, env, { object: publicRecord(record), uploadId: upload.uploadId }, 201);
}

async function multipartPart(request: Request, env: Env, identity: Identity, token: string, objectId: string, partNumber: number): Promise<Response> {
  const record = await readRecord(request, env, token, identity.id, objectId);
  if (!record || record.status !== 'uploading') throw new HttpError(404, 'Multipart upload not found.', 'not_found');
  const uploadId = request.headers.get('X-R2-Upload-Id');
  if (!uploadId || uploadId.length > 512 || /[\r\n]/.test(uploadId)) throw new HttpError(400, 'R2 upload ID is required.', 'invalid_upload_id');
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new HttpError(400, 'Invalid multipart part number.', 'invalid_part');
  const length = requestLength(request);
  if (length !== null && (length <= 0 || length > MAX_MULTIPART_PART_BYTES)) throw new HttpError(413, 'The multipart part is too large.', 'part_too_large');
  if (!request.body) throw new HttpError(400, 'A multipart body is required.', 'missing_body');
  const upload = env.R2_OBJECTS.resumeMultipartUpload(record.object_key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return json(request, env, { partNumber, etag: part.etag });
}

async function completeMultipart(request: Request, env: Env, identity: Identity, token: string, objectId: string): Promise<Response> {
  const record = await readRecord(request, env, token, identity.id, objectId);
  if (!record || record.status !== 'uploading') throw new HttpError(404, 'Multipart upload not found.', 'not_found');
  const uploadId = request.headers.get('X-R2-Upload-Id');
  if (!uploadId || uploadId.length > 512 || /[\r\n]/.test(uploadId)) throw new HttpError(400, 'R2 upload ID is required.', 'invalid_upload_id');
  const input = await readJson(request);
  const rawParts = input.parts;
  if (!Array.isArray(rawParts) || rawParts.length === 0 || rawParts.length > 10000) throw new HttpError(400, 'A non-empty parts list is required.', 'invalid_parts');
  const parts = rawParts.map((part) => {
    if (!part || typeof part !== 'object') throw new HttpError(400, 'Invalid multipart part.', 'invalid_parts');
    const value = part as { partNumber?: unknown; etag?: unknown };
    if (!Number.isInteger(value.partNumber) || (value.partNumber as number) < 1 || (value.partNumber as number) > 10000 || typeof value.etag !== 'string' || !value.etag || value.etag.length > 256) {
      throw new HttpError(400, 'Invalid multipart part.', 'invalid_parts');
    }
    return { partNumber: value.partNumber as number, etag: value.etag } as R2UploadedPart;
  });
  if (new Set(parts.map((part) => part.partNumber)).size !== parts.length) throw new HttpError(400, 'Duplicate multipart parts are not allowed.', 'invalid_parts');
  const upload: R2MultipartUpload = env.R2_OBJECTS.resumeMultipartUpload(record.object_key, uploadId);
  await upload.complete(parts);
  await patchRecord(env, token, identity.id, objectId, { status: 'ready' });
  return json(request, env, { object: publicRecord({ ...record, status: 'ready' }) });
}

async function abortMultipart(request: Request, env: Env, identity: Identity, token: string, objectId: string): Promise<Response> {
  const record = await readRecord(request, env, token, identity.id, objectId);
  if (!record || record.status !== 'uploading') throw new HttpError(404, 'Multipart upload not found.', 'not_found');
  const uploadId = request.headers.get('X-R2-Upload-Id');
  if (!uploadId || uploadId.length > 512 || /[\r\n]/.test(uploadId)) throw new HttpError(400, 'R2 upload ID is required.', 'invalid_upload_id');
  await env.R2_OBJECTS.resumeMultipartUpload(record.object_key, uploadId).abort();
  await deleteRecord(env, token, identity.id, objectId);
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/healthz' && request.method === 'GET') {
    return json(request, env, { ok: true, service: 'pharmatrack-web', environment: env.ENVIRONMENT || 'unknown' });
  }
  if (!url.pathname.startsWith(API_PREFIX)) throw new HttpError(404, 'Not found.', 'not_found');
  if (!originIsAllowed(request, env)) throw new HttpError(403, 'This browser origin is not allowed.', 'origin_not_allowed');

  const identity = await authenticate(request, env);
  await enforceRateLimit(request, env, identity);
  const token = bearerToken(request);
  const path = url.pathname;

  if (path === `${API_PREFIX}/objects` && request.method === 'POST') return uploadObject(request, env, identity, token);
  if (path === `${API_PREFIX}/uploads` && request.method === 'POST') return initiateMultipart(request, env, identity, token);

  const objectMatch = path.match(new RegExp(`^${API_PREFIX}/objects/([^/]+)(?:/(metadata))?$`));
  if (objectMatch) {
    const objectId = objectIdFromPath(path, `${API_PREFIX}/objects/`.split('/').length - 1);
    if (objectMatch[2] === 'metadata' && request.method === 'GET') return getMetadata(request, env, identity, token, objectId);
    if ((request.method === 'GET' || request.method === 'HEAD')) return getObject(request, env, identity, token, objectId);
    if (request.method === 'DELETE') return deleteObject(request, env, identity, token, objectId);
  }

  const partMatch = path.match(new RegExp(`^${API_PREFIX}/uploads/([^/]+)/parts/(\\d+)$`));
  if (partMatch && request.method === 'PUT') {
    const objectId = partMatch[1];
    if (!OBJECT_ID.test(objectId)) throw new HttpError(400, 'The object ID is invalid.', 'invalid_object_id');
    return multipartPart(request, env, identity, token, objectId, Number(partMatch[2]));
  }
  const uploadMatch = path.match(new RegExp(`^${API_PREFIX}/uploads/([^/]+)/(complete|abort)$`));
  if (uploadMatch) {
    const objectId = uploadMatch[1];
    if (!OBJECT_ID.test(objectId)) throw new HttpError(400, 'The object ID is invalid.', 'invalid_object_id');
    if (uploadMatch[2] === 'complete' && request.method === 'POST') return completeMultipart(request, env, identity, token, objectId);
    if (uploadMatch[2] === 'abort' && request.method === 'DELETE') return abortMultipart(request, env, identity, token, objectId);
  }

  throw new HttpError(404, 'Not found.', 'not_found');
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'OPTIONS') {
      if (!originIsAllowed(request, env)) return errorResponse(request, env, new HttpError(403, 'This browser origin is not allowed.', 'origin_not_allowed'));
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    try {
      return await api(request, env);
    } catch (error) {
      return errorResponse(request, env, error);
    }
  }

  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const worker = { fetch: handle };
export default worker;
