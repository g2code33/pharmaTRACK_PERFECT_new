import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord, Env } from '../../cloudflare/worker/src/index';
import { worker } from '../../cloudflare/worker/src/index';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EVIL_ORIGIN = 'https://evil.example';

class FakeR2 {
  objects = new Map<string, { bytes: Uint8Array; contentType: string; etag: string }>();
  put = vi.fn(async (key: string, value: BodyInit, options?: { httpMetadata?: { contentType?: string } }) => {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, {
      bytes,
      contentType: options?.httpMetadata?.contentType || 'application/octet-stream',
      etag: `"${key.length}-${bytes.length}"`,
    });
    return {};
  });
  get = vi.fn(async (key: string) => {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      body: item.bytes,
      httpEtag: item.etag,
      httpMetadata: { contentType: item.contentType },
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', item.contentType);
      },
    };
  });
  delete = vi.fn(async (key: string) => { this.objects.delete(key); });
  createMultipartUpload = vi.fn();
  resumeMultipartUpload = vi.fn();
}

function makeEnvironment(r2: FakeR2, records: Map<string, AssetRecord>): Env {
  const auth = (request: Request): Response => {
    const token = request.headers.get('Authorization');
    if (token === 'Bearer valid-user-token') {
      return Response.json({ id: USER_ID });
    }
    return new Response(JSON.stringify({ error: 'invalid token' }), { status: 401 });
  };

  const metadata = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/auth/v1/user')) return auth(request);

    if (url.pathname.endsWith('/rest/v1/storage_objects')) {
      if (request.method === 'POST') {
        const record = await request.json() as AssetRecord;
        records.set(record.id, record);
        return new Response(null, { status: 201 });
      }
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      const record = id ? records.get(id) : undefined;
      if (request.method === 'GET') return Response.json(record ? [record] : []);
      if (request.method === 'PATCH' && record) {
        Object.assign(record, await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === 'DELETE' && record) {
        records.delete(record.id);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };

  return {
    ASSETS: { fetch: async () => new Response('static app') },
    R2_OBJECTS: r2 as unknown as Env['R2_OBJECTS'],
    SUPABASE_URL: 'https://supabase.example.test',
    SUPABASE_ANON_KEY: 'publishable-test-key',
    CORS_ORIGINS: 'http://localhost:5173',
    ENVIRONMENT: 'test',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    // The Worker deliberately uses the platform fetch for Supabase and never
    // exposes this function to browser code.
    __fetch: metadata,
  } as Env & { __fetch: typeof metadata };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.example.test${path}`, {
    ...init,
    headers: new Headers({ Origin: 'http://localhost:5173', ...(init.headers || {}) }),
  });
}

const pdf = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\nPharmaTRACK')]);

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const environment = (globalThis as typeof globalThis & { __cloudflareTestEnv?: Env & { __fetch: (request: Request) => Promise<Response> } }).__cloudflareTestEnv;
    return environment!.__fetch(new Request(input, init));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cloudflare Worker storage boundary', () => {
  it('serves a health check without exposing storage or auth data', async () => {
    const environment = makeEnvironment(new FakeR2(), new Map());
    (globalThis as typeof globalThis & { __cloudflareTestEnv?: unknown }).__cloudflareTestEnv = environment;
    const response = await worker.fetch(request('/api/healthz'), environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'pharmatrack-web' });
  });

  it('rejects missing authentication before touching R2', async () => {
    const r2 = new FakeR2();
    const environment = makeEnvironment(r2, new Map());
    (globalThis as typeof globalThis & { __cloudflareTestEnv?: unknown }).__cloudflareTestEnv = environment;
    const response = await worker.fetch(request('/api/v1/objects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-PharmaTrack-File-Name': 'notes.pdf' },
      body: pdf,
    }), environment);
    expect(response.status).toBe(401);
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('rejects an origin outside the explicit CORS allowlist', async () => {
    const environment = makeEnvironment(new FakeR2(), new Map());
    (globalThis as typeof globalThis & { __cloudflareTestEnv?: unknown }).__cloudflareTestEnv = environment;
    const response = await worker.fetch(new Request('https://worker.example.test/api/v1/objects', {
      method: 'OPTIONS',
      headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    }), environment);
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rejects invalid file signatures and never writes the R2 object', async () => {
    const r2 = new FakeR2();
    const records = new Map<string, AssetRecord>();
    const environment = makeEnvironment(r2, records);
    (globalThis as typeof globalThis & { __cloudflareTestEnv?: unknown }).__cloudflareTestEnv = environment;
    const response = await worker.fetch(request('/api/v1/objects', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-user-token',
        'Content-Type': 'application/pdf',
        'X-PharmaTrack-File-Name': 'not-really-a-pdf.pdf',
      },
      body: new TextEncoder().encode('plain text'),
    }), environment);
    expect(response.status).toBe(415);
    expect((await response.json() as { error: string }).error).toBe('invalid_file_signature');
    expect(r2.put).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });

  it('authenticates, uploads to R2, records metadata, and retrieves the private object', async () => {
    const r2 = new FakeR2();
    const records = new Map<string, AssetRecord>();
    const environment = makeEnvironment(r2, records);
    (globalThis as typeof globalThis & { __cloudflareTestEnv?: unknown }).__cloudflareTestEnv = environment;

    const upload = await worker.fetch(request('/api/v1/objects', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-user-token',
        'Content-Type': 'application/pdf',
        'X-PharmaTrack-File-Name': 'semester-notes.pdf',
        'Content-Length': String(pdf.byteLength),
      },
      body: pdf,
    }), environment);
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { object: AssetRecord };
    expect(uploaded.object.account_id).toBeUndefined();
    expect(uploaded.object.object_key).toBeUndefined();
    expect(uploaded.object.asset_kind).toBe('pdf');
    expect(r2.put).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(1);

    const object = await worker.fetch(request(`/api/v1/objects/${uploaded.object.id}`, {
      headers: { Authorization: 'Bearer valid-user-token' },
    }), environment);
    expect(object.status).toBe(200);
    expect(object.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(pdf);

    const metadata = await worker.fetch(request(`/api/v1/objects/${uploaded.object.id}/metadata`, {
      headers: { Authorization: 'Bearer valid-user-token' },
    }), environment);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ object: { id: uploaded.object.id, size_bytes: pdf.byteLength } });
  });

  it('rate-limits authenticated storage operations', async () => {
    const environment = makeEnvironment(new FakeR2(), new Map());
    environment.RATE_LIMITER = { limit: async () => ({ success: false }) };
    (globalThis as typeof globalThis & { __cloudflareTestEnv?: unknown }).__cloudflareTestEnv = environment;
    const response = await worker.fetch(request('/api/v1/objects', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-user-token',
        'Content-Type': 'application/pdf',
        'X-PharmaTrack-File-Name': 'notes.pdf',
      },
      body: pdf,
    }), environment);
    expect(response.status).toBe(429);
  });
});
