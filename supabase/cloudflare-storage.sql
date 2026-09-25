-- PharmaTRACK Cloudflare R2 metadata
--
-- Run after security-rls.sql and authentication.sql. Binary bytes stay in
-- Cloudflare R2; this table contains only account-owned metadata and the
-- server-generated R2 key needed to reconcile the two systems.
--
-- The browser never receives R2 credentials and cannot choose object_key. The
-- Cloudflare Worker inserts/updates rows with the caller's Supabase bearer
-- token, so these policies remain the final authorization boundary.

create table if not exists public.storage_objects (
  id uuid primary key,
  account_id uuid not null references auth.users(id) on delete cascade,
  object_key text not null unique,
  original_name text not null check (char_length(original_name) between 1 and 180),
  asset_kind text not null check (asset_kind in ('pdf', 'pptx', 'docx', 'image', 'pharmaexam', 'backup')),
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  sha256 text,
  status text not null default 'uploading' check (status in ('uploading', 'ready')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint storage_objects_key_owner check (object_key like ('objects/' || account_id::text || '/%'))
);

create index if not exists storage_objects_account_created_idx
  on public.storage_objects (account_id, created_at desc);

alter table public.storage_objects enable row level security;

revoke all on table public.storage_objects from anon;
grant select, insert, update, delete on table public.storage_objects to authenticated;

drop policy if exists "Users can view their own Cloudflare object metadata" on public.storage_objects;
drop policy if exists "Users can create their own Cloudflare object metadata" on public.storage_objects;
drop policy if exists "Users can update their own Cloudflare object metadata" on public.storage_objects;
drop policy if exists "Users can delete their own Cloudflare object metadata" on public.storage_objects;

create policy "Users can view their own Cloudflare object metadata"
  on public.storage_objects for select
  using (auth.uid() = account_id);

create policy "Users can create their own Cloudflare object metadata"
  on public.storage_objects for insert
  with check (
    auth.uid() = account_id
    and object_key like ('objects/' || auth.uid()::text || '/%')
  );

create policy "Users can update their own Cloudflare object metadata"
  on public.storage_objects for update
  using (auth.uid() = account_id)
  with check (
    auth.uid() = account_id
    and object_key like ('objects/' || auth.uid()::text || '/%')
  );

create policy "Users can delete their own Cloudflare object metadata"
  on public.storage_objects for delete
  using (auth.uid() = account_id);

-- The Worker is the only intended writer of object_key and status. The RLS
-- policies above are still useful if a future client feature calls PostgREST;
-- no public storage secret is needed by the browser.
