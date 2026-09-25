import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wrangler = readFileSync('wrangler.toml', 'utf8');
const worker = readFileSync('cloudflare/worker/src/index.ts', 'utf8');
const storageSql = readFileSync('supabase/cloudflare-storage.sql', 'utf8');
const serviceWorker = readFileSync('public/sw.js', 'utf8');
const client = readFileSync('src/cloudflare/storageClient.ts', 'utf8');

describe('Cloudflare deployment contract', () => {
  it('defines isolated local, staging, and production static/R2 environments', () => {
    expect(wrangler).toContain('[assets]');
    expect(wrangler).toContain('not_found_handling = "single-page-application"');
    expect(wrangler).toContain('[[r2_buckets]]');
    expect(wrangler).toContain('[env.staging]');
    expect(wrangler).toContain('[[env.staging.r2_buckets]]');
    expect(wrangler).toContain('[env.production]');
    expect(wrangler).toContain('[[env.production.r2_buckets]]');
    expect(wrangler).toContain('[[env.production.ratelimits]]');
    expect(wrangler).not.toContain('SUPABASE_ANON_KEY =');
  });

  it('keeps private API operations authenticated and CORS exact-origin only', () => {
    expect(worker).toContain("Authorization");
    expect(worker).toContain('/auth/v1/user');
    expect(worker).toContain('origin_not_allowed');
    expect(worker).toContain('RATE_LIMITER');
    expect(worker).not.toContain("Access-Control-Allow-Origin', '*'");
    expect(worker).not.toContain('R2_ACCESS_KEY_ID');
    expect(worker).not.toContain('R2_SECRET_ACCESS_KEY');
    expect(worker).not.toContain('service_role');
  });

  it('stores only account-scoped metadata in Supabase and keeps bytes in R2', () => {
    expect(storageSql).toContain('create table if not exists public.storage_objects');
    expect(storageSql).toContain('references auth.users(id) on delete cascade');
    expect(storageSql).toContain('alter table public.storage_objects enable row level security');
    expect(storageSql).toContain('auth.uid() = account_id');
    expect(worker).toContain('R2_OBJECTS.put');
    expect(worker).toContain('storage_objects');
    expect(worker).toContain('object_key');
  });

  it('does not let the PWA service worker cache authenticated or API responses', () => {
    expect(serviceWorker).toContain("request.headers.has('authorization')");
    expect(serviceWorker).toMatch(/api\|auth\|rest\|functions\|supabase\|pharmaexam/);
    expect(serviceWorker).not.toContain("caches.open('pharmatrack-private");
  });

  it('uses a relative Worker API by default and never asks the browser for R2 credentials', () => {
    expect(client).toContain("const base = (import.meta.env.VITE_CLOUDFLARE_API_BASE_URL || '')");
    expect(client).toContain("'/api/v1/objects'");
    expect(client).toContain('Authorization');
    expect(client).not.toContain('R2_ACCESS_KEY');
    expect(client).not.toContain('R2_SECRET');
  });
});
