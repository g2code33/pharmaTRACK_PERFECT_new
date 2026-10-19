-- ============================================================================
-- PharmaTRACK kiosk roster — admin-referenced student accounts
--
-- Run after authentication.sql and security-rls.sql, and after
-- kiosk-exam-results.sql (not required, but keeps all kiosk cloud tables
-- together).
--
-- What this is for: an administrator can turn their account into the
-- reference point for kiosk student accounts, so the SAME student login
-- works from whichever device they sit at, as long as the administrator
-- has logins switched on — not a fixed "admin PC", any device the
-- administrator is signed into. Taking the exam itself keeps using the
-- existing local/offline examination engine unchanged; this table only
-- decides WHO is allowed to start.
--
-- Security model:
--   - A student device is never signed into Supabase. It only ever knows a
--     short join code the administrator shares out loud/on screen. Every
--     student-facing RPC below is SECURITY DEFINER, narrowly scoped to
--     exactly one operation, granted to `anon`, and never exposes another
--     admin's data, a password hash, or any row outside what the specific
--     call needs.
--   - Password generation happens on the CLIENT (the exact same
--     already-tested "random, but exhaust every single-letter RX30 slot
--     before any two-letter slot" algorithm already used for the fully
--     offline kiosk). The server's only job is to atomically claim the
--     chosen slot (a UNIQUE constraint rejects a race instead of silently
--     double-issuing a password) and store a salted hash of it — the
--     plaintext password is returned once, to show the student, and never
--     stored.
--   - Direct table access is revoked for everyone; every path goes through
--     the functions below, each with its own auth.uid() check.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.pharmatrack_kiosk_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  join_code text not null unique,
  login_enabled boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.pharmatrack_kiosk_roster_students (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.pharmatrack_kiosk_admins(user_id) on delete cascade,
  first_name text not null,
  first_name_key text not null, -- lower(trim(first_name)), for case-insensitive lookups/uniqueness
  level text not null,
  password_slot integer not null,
  password_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  last_authenticated_at timestamptz,
  unique (admin_user_id, first_name_key, level),
  unique (admin_user_id, password_slot)
);

alter table public.pharmatrack_kiosk_admins enable row level security;
alter table public.pharmatrack_kiosk_roster_students enable row level security;

drop policy if exists "Kiosk admin profile is readable by its owner" on public.pharmatrack_kiosk_admins;
drop policy if exists "Kiosk admin profile is insertable by its owner" on public.pharmatrack_kiosk_admins;
drop policy if exists "Kiosk admin profile is updateable by its owner" on public.pharmatrack_kiosk_admins;

create policy "Kiosk admin profile is readable by its owner"
  on public.pharmatrack_kiosk_admins for select
  using (auth.uid() = user_id);

create policy "Kiosk admin profile is insertable by its owner"
  on public.pharmatrack_kiosk_admins for insert
  with check (auth.uid() = user_id);

create policy "Kiosk admin profile is updateable by its owner"
  on public.pharmatrack_kiosk_admins for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Kiosk roster is readable by the owning admin" on public.pharmatrack_kiosk_roster_students;
drop policy if exists "Kiosk roster is insertable by the owning admin" on public.pharmatrack_kiosk_roster_students;
drop policy if exists "Kiosk roster is updateable by the owning admin" on public.pharmatrack_kiosk_roster_students;
drop policy if exists "Kiosk roster is deletable by the owning admin" on public.pharmatrack_kiosk_roster_students;

create policy "Kiosk roster is readable by the owning admin"
  on public.pharmatrack_kiosk_roster_students for select
  using (auth.uid() = admin_user_id);

create policy "Kiosk roster is insertable by the owning admin"
  on public.pharmatrack_kiosk_roster_students for insert
  with check (auth.uid() = admin_user_id);

create policy "Kiosk roster is updateable by the owning admin"
  on public.pharmatrack_kiosk_roster_students for update
  using (auth.uid() = admin_user_id)
  with check (auth.uid() = admin_user_id);

create policy "Kiosk roster is deletable by the owning admin"
  on public.pharmatrack_kiosk_roster_students for delete
  using (auth.uid() = admin_user_id);

revoke all on public.pharmatrack_kiosk_admins from anon, authenticated;
revoke all on public.pharmatrack_kiosk_roster_students from anon, authenticated;

create index if not exists pharmatrack_kiosk_roster_admin_idx
  on public.pharmatrack_kiosk_roster_students (admin_user_id);

-- ----------------------------------------------------------------------------
-- Admin-only functions (require a signed-in PharmaTrack account)
-- ----------------------------------------------------------------------------

create or replace function public.generate_kiosk_join_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I ambiguity
  code text := '';
  i int;
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end;
$$;

-- Creates this admin's kiosk profile on first use and always returns it.
create or replace function public.ensure_kiosk_admin_profile()
returns public.pharmatrack_kiosk_admins
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.pharmatrack_kiosk_admins;
  candidate text;
  attempt int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into result from public.pharmatrack_kiosk_admins where user_id = auth.uid();
  if found then
    return result;
  end if;

  loop
    candidate := public.generate_kiosk_join_code();
    begin
      insert into public.pharmatrack_kiosk_admins (user_id, join_code)
      values (auth.uid(), candidate)
      returning * into result;
      return result;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 10 then
        raise exception 'Could not allocate a kiosk join code.';
      end if;
    end;
  end loop;
end;
$$;

create or replace function public.set_kiosk_login_enabled(p_enabled boolean)
returns public.pharmatrack_kiosk_admins
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.pharmatrack_kiosk_admins;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  perform public.ensure_kiosk_admin_profile();
  update public.pharmatrack_kiosk_admins
  set login_enabled = p_enabled, updated_at = timezone('utc', now())
  where user_id = auth.uid()
  returning * into result;
  return result;
end;
$$;

create or replace function public.regenerate_kiosk_join_code()
returns public.pharmatrack_kiosk_admins
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.pharmatrack_kiosk_admins;
  candidate text;
  attempt int := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  perform public.ensure_kiosk_admin_profile();
  loop
    candidate := public.generate_kiosk_join_code();
    begin
      update public.pharmatrack_kiosk_admins
      set join_code = candidate, updated_at = timezone('utc', now())
      where user_id = auth.uid()
      returning * into result;
      return result;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 10 then
        raise exception 'Could not allocate a kiosk join code.';
      end if;
    end;
  end loop;
end;
$$;

create or replace function public.list_kiosk_roster_students()
returns setof public.pharmatrack_kiosk_roster_students
language sql
security definer
set search_path = public
as $$
  select * from public.pharmatrack_kiosk_roster_students
  where admin_user_id = auth.uid()
  order by created_at desc;
$$;

-- Admin-triggered password reset for one of their own roster students. The
-- CALLER (the admin's own browser) still picks the new slot — it already
-- has list_kiosk_roster_students()'s full issued-slot list to compute one
-- with the shared, tested algorithm.
create or replace function public.admin_reset_kiosk_student_password(
  p_student_id uuid,
  p_new_slot integer,
  p_new_password_hash_input text
)
returns public.pharmatrack_kiosk_roster_students
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.pharmatrack_kiosk_roster_students;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  update public.pharmatrack_kiosk_roster_students
  set password_slot = p_new_slot,
      password_hash = crypt(p_new_password_hash_input, gen_salt('bf'))
  where id = p_student_id and admin_user_id = auth.uid()
  returning * into result;
  if not found then
    raise exception 'That student could not be found in your roster.';
  end if;
  return result;
end;
$$;

-- ----------------------------------------------------------------------------
-- Anonymous, student-facing functions (no Supabase account; only a join code)
-- ----------------------------------------------------------------------------

-- Whether a join code is live right now, and (if registering) whether this
-- name/level is free and which password slots are already issued. One round
-- trip covers everything the kiosk screen needs before it shows a password.
create or replace function public.kiosk_registration_context(
  p_join_code text,
  p_first_name text,
  p_level text
)
returns table (found boolean, login_enabled boolean, name_taken boolean, issued_slots integer[])
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_row public.pharmatrack_kiosk_admins;
  taken boolean;
  slots integer[];
begin
  select * into admin_row from public.pharmatrack_kiosk_admins where join_code = upper(trim(p_join_code));
  if not found then
    return query select false, false, false, array[]::integer[];
    return;
  end if;

  select exists(
    select 1 from public.pharmatrack_kiosk_roster_students
    where admin_user_id = admin_row.user_id
      and first_name_key = lower(trim(p_first_name))
      and level = p_level
  ) into taken;

  select coalesce(array_agg(password_slot), array[]::integer[])
  into slots
  from public.pharmatrack_kiosk_roster_students
  where admin_user_id = admin_row.user_id;

  return query select true, admin_row.login_enabled, taken, slots;
end;
$$;

-- Registers a new kiosk student under this admin. p_password_slot/p_password
-- are chosen by the client with the existing tested algorithm; the UNIQUE
-- constraint on (admin_user_id, password_slot) makes a concurrent double
-- issue impossible — a race loses here, not silently, and the client is
-- expected to retry from kiosk_registration_context() when that happens.
create or replace function public.kiosk_register_student(
  p_join_code text,
  p_first_name text,
  p_level text,
  p_password_slot integer,
  p_password text
)
returns table (student_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_row public.pharmatrack_kiosk_admins;
  new_id uuid;
begin
  select * into admin_row from public.pharmatrack_kiosk_admins where join_code = upper(trim(p_join_code));
  if not found then
    raise exception 'That admin join code was not recognized.';
  end if;
  if not admin_row.login_enabled then
    raise exception 'Kiosk logins are not currently open. Ask the administrator to enable them.';
  end if;

  insert into public.pharmatrack_kiosk_roster_students (
    admin_user_id, first_name, first_name_key, level, password_slot, password_hash
  )
  values (
    admin_row.user_id, trim(p_first_name), lower(trim(p_first_name)), p_level,
    p_password_slot, crypt(p_password, gen_salt('bf'))
  )
  returning id into new_id;

  return query select new_id;
end;
$$;

-- Verifies a kiosk student's credentials. Raises on any failure so the
-- client never learns WHICH part (name vs. password) was wrong.
create or replace function public.kiosk_authenticate_student(
  p_join_code text,
  p_first_name text,
  p_level text,
  p_password text
)
returns table (student_id uuid, first_name text, level text)
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_row public.pharmatrack_kiosk_admins;
  student_row public.pharmatrack_kiosk_roster_students;
begin
  select * into admin_row from public.pharmatrack_kiosk_admins where join_code = upper(trim(p_join_code));
  if not found then
    raise exception 'First name, level, or RX30 Kiosk password is incorrect.';
  end if;
  if not admin_row.login_enabled then
    raise exception 'Kiosk logins are not currently open. Ask the administrator to enable them.';
  end if;

  select * into student_row
  from public.pharmatrack_kiosk_roster_students
  where admin_user_id = admin_row.user_id
    and first_name_key = lower(trim(p_first_name))
    and level = p_level;

  if not found or student_row.password_hash <> crypt(p_password, student_row.password_hash) then
    raise exception 'First name, level, or RX30 Kiosk password is incorrect.';
  end if;

  update public.pharmatrack_kiosk_roster_students
  set last_authenticated_at = timezone('utc', now())
  where id = student_row.id;

  return query select student_row.id, student_row.first_name, student_row.level;
end;
$$;

revoke all on function public.ensure_kiosk_admin_profile() from public;
revoke all on function public.set_kiosk_login_enabled(boolean) from public;
revoke all on function public.regenerate_kiosk_join_code() from public;
revoke all on function public.list_kiosk_roster_students() from public;
revoke all on function public.admin_reset_kiosk_student_password(uuid, integer, text) from public;
revoke all on function public.kiosk_registration_context(text, text, text) from public;
revoke all on function public.kiosk_register_student(text, text, text, integer, text) from public;
revoke all on function public.kiosk_authenticate_student(text, text, text, text) from public;

grant execute on function public.ensure_kiosk_admin_profile() to authenticated;
grant execute on function public.set_kiosk_login_enabled(boolean) to authenticated;
grant execute on function public.regenerate_kiosk_join_code() to authenticated;
grant execute on function public.list_kiosk_roster_students() to authenticated;
grant execute on function public.admin_reset_kiosk_student_password(uuid, integer, text) to authenticated;

-- These three are the only functions a kiosk device (never signed in) ever
-- calls, which is why they are granted to anon as well as authenticated.
grant execute on function public.kiosk_registration_context(text, text, text) to anon, authenticated;
grant execute on function public.kiosk_register_student(text, text, text, integer, text) to anon, authenticated;
grant execute on function public.kiosk_authenticate_student(text, text, text, text) to anon, authenticated;
