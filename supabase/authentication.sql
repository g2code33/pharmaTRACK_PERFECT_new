-- ============================================================================
-- PharmaTRACK normal account authentication
--
-- Run after security-rls.sql in the Supabase SQL editor. The browser uses only
-- the public/publishable key and authenticated RLS. No service-role key belongs
-- in the PharmaTRACK bundle.
--
-- This account is intentionally separate from examination Kiosk identity:
-- normal accounts use auth.users.id; Kiosk uses First Name + Level + RX30 and
-- an examination/LAN session.
-- ============================================================================

-- Existing projects already have this profile shape. IF NOT EXISTS keeps this
-- migration safe for installations that created the columns earlier.
alter table public.profiles add column if not exists university text;
alter table public.profiles add column if not exists level text;
alter table public.profiles add column if not exists program text;
alter table public.profiles add column if not exists semester text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists created_at timestamptz not null default timezone('utc', now());
alter table public.profiles add column if not exists updated_at timestamptz not null default timezone('utc', now());

-- Formalize the profile identity as the Supabase auth UUID. NOT VALID keeps
-- this migration deployable for an older installation that may contain an
-- orphaned legacy profile, while enforcing the relationship for all new or
-- changed rows. The signup trigger and account deletion function then use the
-- same auth.users lifecycle.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and confrelid = 'auth.users'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_id_auth_users_fkey
      foreign key (id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

-- Roles are server-controlled. The client can edit profile display fields, but
-- cannot insert/update this column and no authorization decision in the app is
-- based on user-editable auth.raw_user_meta_data.
alter table public.profiles add column if not exists role text not null default 'student';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('student', 'staff', 'admin'));
revoke insert (role), update (role) on table public.profiles from anon, authenticated;

-- Email confirmation can mean signUp() returns a user without a session. A
-- SECURITY DEFINER trigger creates the profile without asking the unauthenticated
-- browser to bypass RLS. Only display fields are copied from metadata.
create or replace function public.handle_new_pharmatrack_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, level)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'level', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_pharmatrack on auth.users;
create trigger on_auth_user_created_pharmatrack
after insert on auth.users
for each row execute function public.handle_new_pharmatrack_user();

-- Account deletion is the one operation that cannot be implemented with the
-- browser auth client alone. This authenticated SECURITY DEFINER function is
-- the server-side boundary; it is not the Supabase admin API and needs no
-- service-role key in the frontend.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer set search_path = public, auth, storage
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'An authenticated account is required';
  end if;

  -- Storage objects do not cascade from auth.users. Remove only this user's
  -- private backup folder before deleting the auth row.
  delete from storage.objects
  where bucket_id = 'user-documents'
    and (storage.foldername(name))[1] = uid::text;

  -- Profile and AI/account tables referencing auth.users use ON DELETE CASCADE
  -- where present. Delete the identity last.
  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Useful verification queries:
-- select id, role from public.profiles limit 10;
-- select proname from pg_proc where proname = 'delete_my_account';
