import { supabase } from '../utils/supabase';

export type CloudAssetKind = 'pdf' | 'pptx' | 'docx' | 'image' | 'pharmaexam' | 'backup';

export interface CloudObjectMetadata {
  id: string;
  original_name: string;
  asset_kind: CloudAssetKind;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  status: 'uploading' | 'ready';
  created_at: string;
  updated_at: string;
}

export interface CloudObjectResponse {
  object: CloudObjectMetadata;
}

/**
 * Same-origin by default: in production the Worker serves both the PWA and
 * /api/v1. A public override is useful only for a separately hosted staging
 * shell; it never contains a storage credential.
 */
function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_CLOUDFLARE_API_BASE_URL || '').replace(/\/$/, '');
  return `${base}${path}`;
}

async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error('Sign in before using Cloudflare storage.');
  }
  return data.session.access_token;
}

async function readError(response: Response): Promise<Error> {
  try {
    const value = await response.json() as { message?: string };
    return new Error(value.message || `Cloudflare storage request failed (${response.status}).`);
  } catch {
    return new Error(`Cloudflare storage request failed (${response.status}).`);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers });
  if (!response.ok) throw await readError(response);
  return response;
}

/**
 * Uploads a binary through the Worker. The browser never signs or addresses an
 * R2 object directly; the Worker chooses the account-scoped object key and
 * records metadata in Supabase.
 */
export async function uploadCloudObject(
  file: Blob,
  fileName: string,
  assetKind?: CloudAssetKind,
  sha256?: string,
): Promise<CloudObjectMetadata> {
  const headers = new Headers({
    'Content-Type': file.type || 'application/octet-stream',
    'X-PharmaTrack-File-Name': fileName,
  });
  if (assetKind) headers.set('X-PharmaTrack-Asset-Type', assetKind);
  if (sha256) headers.set('X-PharmaTrack-SHA256', sha256);
  const response = await request('/api/v1/objects', { method: 'POST', headers, body: file });
  const payload = await response.json() as CloudObjectResponse;
  return payload.object;
}

export async function getCloudObjectMetadata(objectId: string): Promise<CloudObjectMetadata> {
  const response = await request(`/api/v1/objects/${encodeURIComponent(objectId)}/metadata`);
  const payload = await response.json() as CloudObjectResponse;
  return payload.object;
}

export async function downloadCloudObject(objectId: string): Promise<Response> {
  return request(`/api/v1/objects/${encodeURIComponent(objectId)}`);
}

export async function deleteCloudObject(objectId: string): Promise<void> {
  await request(`/api/v1/objects/${encodeURIComponent(objectId)}`, { method: 'DELETE' });
}

export function cloudflareStorageConfigured(): boolean {
  return typeof fetch === 'function';
}
