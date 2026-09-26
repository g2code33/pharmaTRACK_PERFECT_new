-- ============================================================================
-- PharmaTRACK normal account synchronization
--
-- Run after authentication.sql and security-rls.sql. This migration is for
-- account-owned configuration only. It is deliberately NOT a mirror of the
-- local AppState: courses, slides, notes, quizzes, downloaded files, LAN/
-- examination state, and encrypted offline examination state have no record
-- type here and must stay under their existing local/examination authority.
--
-- The browser calls only the SECURITY DEFINER RPCs below. Every table still
-- has explicit auth.uid()-based RLS policies as a second server-side boundary.
-- No policy uses user-editable auth metadata.
-- ============================================================================

create table if not exists public.pharmatrack_account_sync_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id text not null,
  record_type text not null check (
    record_type in (
      'profile_preferences',
      'application_settings',
      'ai_profile_selection',
      'permitted_data'
    )
  ),
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by_device_id text,
  deleted_at timestamptz,
  unique (user_id, record_id)
);

create table if not exists public.pharmatrack_account_sync_cursors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_pull_at timestamptz,
  last_push_at timestamptz,
  last_device_id text,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.pharmatrack_account_sync_records enable row level security;
alter table public.pharmatrack_account_sync_cursors enable row level security;

-- These policies are intentionally explicit even though direct table access is
-- revoked below. They protect the tables if a future migration grants a safe
-- read path, and make cross-user access impossible at the database layer.
drop policy if exists "Account sync records are readable by their owner" on public.pharmatrack_account_sync_records;
drop policy if exists "Account sync records are insertable by their owner" on public.pharmatrack_account_sync_records;
drop policy if exists "Account sync records are updateable by their owner" on public.pharmatrack_account_sync_records;
drop policy if exists "Account sync records are deletable by their owner" on public.pharmatrack_account_sync_records;

create policy "Account sync records are readable by their owner"
  on public.pharmatrack_account_sync_records for select
  using (auth.uid() = user_id);

create policy "Account sync records are insertable by their owner"
  on public.pharmatrack_account_sync_records for insert
  with check (auth.uid() = user_id);

create policy "Account sync records are updateable by their owner"
  on public.pharmatrack_account_sync_records for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Account sync records are deletable by their owner"
  on public.pharmatrack_account_sync_records for delete
  using (auth.uid() = user_id);

drop policy if exists "Account sync cursors are readable by their owner" on public.pharmatrack_account_sync_cursors;
drop policy if exists "Account sync cursors are insertable by their owner" on public.pharmatrack_account_sync_cursors;
drop policy if exists "Account sync cursors are updateable by their owner" on public.pharmatrack_account_sync_cursors;
drop policy if exists "Account sync cursors are deletable by their owner" on public.pharmatrack_account_sync_cursors;

create policy "Account sync cursors are readable by their owner"
  on public.pharmatrack_account_sync_cursors for select
  using (auth.uid() = user_id);

create policy "Account sync cursors are insertable by their owner"
  on public.pharmatrack_account_sync_cursors for insert
  with check (auth.uid() = user_id);

create policy "Account sync cursors are updateable by their owner"
  on public.pharmatrack_account_sync_cursors for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Account sync cursors are deletable by their owner"
  on public.pharmatrack_account_sync_cursors for delete
  using (auth.uid() = user_id);

revoke all on table public.pharmatrack_account_sync_records from anon, authenticated;
revoke all on table public.pharmatrack_account_sync_cursors from anon, authenticated;

-- The trigger is the database-side allowlist. A malicious client cannot turn
-- this table into a general-purpose dump of the local examination workspace by
-- calling the RPC with a different JSON shape.
create or replace function public.pharmatrack_validate_account_sync_payload()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  unexpected text;
begin
  if jsonb_typeof(new.payload) <> 'object' then
    raise exception 'Account sync payload must be a JSON object';
  end if;

  if new.record_type = 'profile_preferences' then
    select key into unexpected from jsonb_object_keys(new.payload) as key
      where key not in ('fullName', 'university', 'level', 'program', 'semester') limit 1;
  elsif new.record_type = 'application_settings' then
    select key into unexpected from jsonb_object_keys(new.payload) as key
      where key not in ('theme', 'compactMode', 'notificationsEnabled', 'language') limit 1;
  elsif new.record_type = 'ai_profile_selection' then
    select key into unexpected from jsonb_object_keys(new.payload) as key
      where key not in ('activeProfileId') limit 1;
  elsif new.record_type = 'permitted_data' then
    if new.payload ->> 'kind' <> 'study_preferences'
       or jsonb_typeof(new.payload -> 'values') <> 'object' then
      raise exception 'Unsupported permitted account data';
    end if;
    select key into unexpected from jsonb_object_keys(new.payload) as key
      where key not in ('kind', 'values') limit 1;
    if unexpected is null then
      select key into unexpected from jsonb_object_keys(new.payload -> 'values') as key
        where key not in ('dailyGoalMinutes', 'preferredStudyDays', 'remindersEnabled') limit 1;
    end if;
  end if;

  if unexpected is not null then
    raise exception 'Account sync payload contains a field that is not permitted: %', unexpected;
  end if;
  return new;
end;
$$;

drop trigger if exists pharmatrack_validate_account_sync_payload on public.pharmatrack_account_sync_records;
create trigger pharmatrack_validate_account_sync_payload
before insert or update on public.pharmatrack_account_sync_records
for each row execute function public.pharmatrack_validate_account_sync_payload();

create or replace function public.pharmatrack_account_sync_record_json(
  p_row public.pharmatrack_account_sync_records
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'recordId', p_row.record_id,
    'recordType', p_row.record_type,
    'payload', case when p_row.deleted_at is null then p_row.payload else null end,
    'version', p_row.version,
    'updatedAt', p_row.updated_at,
    'updatedByDeviceId', p_row.updated_by_device_id,
    'deletedAt', p_row.deleted_at
  );
$$;

-- Pull has no user argument: auth.uid() is the owner. That prevents callers
-- from asking for another user's rows by changing a request parameter.
revoke all on function public.pharmatrack_validate_account_sync_payload() from public, anon, authenticated;
revoke all on function public.pharmatrack_account_sync_record_json(public.pharmatrack_account_sync_records) from public, anon, authenticated;

create or replace function public.pharmatrack_account_sync_pull()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null then raise exception 'An authenticated account is required'; end if;

  select coalesce(jsonb_agg(public.pharmatrack_account_sync_record_json(r) order by r.record_id), '[]'::jsonb)
    into result
    from public.pharmatrack_account_sync_records r
   where r.user_id = uid;

  insert into public.pharmatrack_account_sync_cursors (user_id, last_pull_at, updated_at)
  values (uid, timezone('utc', now()), timezone('utc', now()))
  on conflict (user_id) do update
    set last_pull_at = excluded.last_pull_at,
        updated_at = excluded.updated_at;
  return result;
end;
$$;

revoke all on function public.pharmatrack_account_sync_pull() from public, anon;
grant execute on function public.pharmatrack_account_sync_pull() to authenticated;

-- Optimistic concurrency: the base version must exactly match. Both an older
-- and an impossible future version are rejected rather than overwriting data.
create or replace function public.pharmatrack_account_sync_push(
  p_record_id text,
  p_record_type text,
  p_payload jsonb,
  p_base_version bigint,
  p_deleted boolean default false,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  row public.pharmatrack_account_sync_records;
  written public.pharmatrack_account_sync_records;
  deleted_at_value timestamptz := case when p_deleted then timezone('utc', now()) else null end;
begin
  if uid is null then raise exception 'An authenticated account is required'; end if;
  if p_record_id is null or length(trim(p_record_id)) = 0 or length(p_record_id) > 160 then
    raise exception 'A stable account record ID is required';
  end if;
  if p_record_type not in ('profile_preferences', 'application_settings', 'ai_profile_selection', 'permitted_data') then
    raise exception 'This account record type is not permitted';
  end if;
  if p_base_version is null or p_base_version < 0 then raise exception 'Invalid base version'; end if;
  if p_deleted and p_record_type = 'profile_preferences' then
    raise exception 'The account profile cannot be deleted as a sync record';
  end if;

  select * into row
    from public.pharmatrack_account_sync_records r
   where r.user_id = uid and r.record_id = p_record_id
   for update;

  if row.id is not null and (p_base_version < row.version or p_base_version > row.version) then
    return jsonb_build_object(
      'accepted', false,
      'conflict', true,
      'record', public.pharmatrack_account_sync_record_json(row)
    );
  end if;
  if row.id is null and p_base_version <> 0 then
    return jsonb_build_object('accepted', false, 'conflict', true, 'record', null);
  end if;

  if row.id is null then
    insert into public.pharmatrack_account_sync_records
      (user_id, record_id, record_type, payload, version, updated_at, updated_by_device_id, deleted_at)
    values
      (uid, p_record_id, p_record_type, case when p_deleted then '{}'::jsonb else p_payload end,
       1, timezone('utc', now()), p_device_id, deleted_at_value)
    returning * into written;
  else
    update public.pharmatrack_account_sync_records
       set record_type = p_record_type,
           payload = case when p_deleted then '{}'::jsonb else p_payload end,
           version = row.version + 1,
           updated_at = timezone('utc', now()),
           updated_by_device_id = p_device_id,
           deleted_at = deleted_at_value
     where id = row.id
     returning * into written;
  end if;

  -- The relational profile remains available to existing profile readers, but
  -- this RPC is the only normal sync write path. It is still keyed by auth.uid.
  if p_record_type = 'profile_preferences' and not p_deleted then
    update public.profiles
       set full_name = case when p_payload ? 'fullName' then nullif(trim(coalesce(p_payload ->> 'fullName', '')), '') else full_name end,
           university = case when p_payload ? 'university' then nullif(trim(coalesce(p_payload ->> 'university', '')), '') else university end,
           level = case when p_payload ? 'level' then nullif(trim(coalesce(p_payload ->> 'level', '')), '') else level end,
           program = case when p_payload ? 'program' then nullif(trim(coalesce(p_payload ->> 'program', '')), '') else program end,
           semester = case when p_payload ? 'semester' then nullif(trim(coalesce(p_payload ->> 'semester', '')), '') else semester end,
           updated_at = timezone('utc', now())
     where id = uid;
  end if;

  insert into public.pharmatrack_account_sync_cursors (user_id, last_push_at, last_device_id, updated_at)
  values (uid, timezone('utc', now()), p_device_id, timezone('utc', now()))
  on conflict (user_id) do update
    set last_push_at = excluded.last_push_at,
        last_device_id = excluded.last_device_id,
        updated_at = excluded.updated_at;

  return jsonb_build_object('accepted', true, 'conflict', false, 'record', public.pharmatrack_account_sync_record_json(written));
end;
$$;

revoke all on function public.pharmatrack_account_sync_push(text, text, jsonb, bigint, boolean, text) from public, anon;
grant execute on function public.pharmatrack_account_sync_push(text, text, jsonb, bigint, boolean, text) to authenticated;

-- Verification helpers (run while authenticated in the SQL editor):
-- select relname, relrowsecurity from pg_class where relname in
--   ('pharmatrack_account_sync_records', 'pharmatrack_account_sync_cursors');
-- select policyname, cmd, qual, with_check from pg_policies
--   where tablename in ('pharmatrack_account_sync_records', 'pharmatrack_account_sync_cursors');
