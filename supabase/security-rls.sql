-- ============================================================================
--  PharmaTRACK — Row Level Security (RLS)
-- ============================================================================
--  WHY THIS MATTERS
--  The anon key is shipped inside the desktop app, so anyone who installs
--  PharmaTRACK has it. That key is only safe when RLS is switched on.
--  Without RLS, any signed-in user can read, edit or delete EVERY other
--  student's profile and cloud backups.
--
--  RLS makes Postgres enforce "you can only touch your own rows", server-side.
--
--  HOW TO RUN (2 minutes, no coding):
--   1. Go to  https://supabase.com/dashboard
--   2. Open your project  ->  SQL Editor  ->  New query
--   3. Paste this entire file
--   4. Click  RUN
--   5. Look for "Success. No rows returned"
--
--  Safe to run more than once.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. PROFILES TABLE
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Drop first so re-running never errors with "policy already exists".
drop policy if exists "Users can view their own profile"   on public.profiles;
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;

-- The app reads its own row:  .from('profiles').select('*').eq('id', userId)
create policy "Users can view their own profile"
  on public.profiles for select
  using ( auth.uid() = id );

-- Sign-up inserts a row:  .from('profiles').insert([{ id: data.user.id, ... }])
create policy "Users can insert their own profile"
  on public.profiles for insert
  with check ( auth.uid() = id );

-- Profile page saves:  .from('profiles').upsert({ id: user.id, full_name })
create policy "Users can update their own profile"
  on public.profiles for update
  using ( auth.uid() = id )
  with check ( auth.uid() = id );

-- NOTE: no DELETE policy on purpose. Nothing in the app deletes profiles,
-- so leaving it out means nobody can, not even by accident.


-- ----------------------------------------------------------------------------
-- 2. USER-DOCUMENTS STORAGE BUCKET  (cloud backup in Settings)
-- ----------------------------------------------------------------------------
-- Settings.tsx uploads to:  `${user.id}/pharmatrack_backup.json`
-- so the first folder of every path is the owner's user id. These policies
-- compare that folder against the logged-in user.

-- Make sure the bucket exists and is PRIVATE (public = readable by anyone).
insert into storage.buckets (id, name, public)
values ('user-documents', 'user-documents', false)
on conflict (id) do update set public = false;

drop policy if exists "Users can read their own documents"   on storage.objects;
drop policy if exists "Users can upload their own documents" on storage.objects;
drop policy if exists "Users can update their own documents" on storage.objects;
drop policy if exists "Users can delete their own documents" on storage.objects;

create policy "Users can read their own documents"
  on storage.objects for select
  using ( bucket_id = 'user-documents' and auth.uid()::text = (storage.foldername(name))[1] );

create policy "Users can upload their own documents"
  on storage.objects for insert
  with check ( bucket_id = 'user-documents' and auth.uid()::text = (storage.foldername(name))[1] );

-- upsert:true on re-upload needs UPDATE as well as INSERT.
create policy "Users can update their own documents"
  on storage.objects for update
  using ( bucket_id = 'user-documents' and auth.uid()::text = (storage.foldername(name))[1] )
  with check ( bucket_id = 'user-documents' and auth.uid()::text = (storage.foldername(name))[1] );

create policy "Users can delete their own documents"
  on storage.objects for delete
  using ( bucket_id = 'user-documents' and auth.uid()::text = (storage.foldername(name))[1] );


-- ----------------------------------------------------------------------------
-- 3. VERIFY IT WORKED
-- ----------------------------------------------------------------------------
-- rowsecurity must be TRUE for profiles.
select tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public' and tablename = 'profiles';

-- Expect 3 profile policies + 4 storage policies.
select schemaname, tablename, policyname
from pg_policies
where (schemaname = 'public'  and tablename = 'profiles')
   or (schemaname = 'storage' and tablename = 'objects')
order by tablename, policyname;
