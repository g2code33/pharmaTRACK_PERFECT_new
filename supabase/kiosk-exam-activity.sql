-- ============================================================================
-- PharmaTRACK kiosk exam activity — direct-from-kiosk live status + results
--
-- Run after authentication.sql, security-rls.sql, kiosk-admin-roster.sql,
-- and kiosk-exam-results.sql.
--
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------------
-- Before this file, the only way a result ever reached the cloud was:
--   kiosk device --(same LAN)--> admin's device --(push_kiosk_exam_result,
--   requires the ADMIN's own signed-in session)--> cloud
-- If the student's device was never on the same LAN as the admin's device
-- (e.g. a phone on mobile data, using the hosted web app), step one never
-- happens, so the admin's device has nothing to relay — the Examination
-- Control Center shows "No active session" the whole time, and no score
-- ever appears anywhere, even though the student completed the exam.
--
-- This file adds a SECOND, independent path that the kiosk device itself
-- can use directly, with no LAN and no admin device involved at all,
-- using exactly the same anonymous/join-code-scoped pattern already
-- established by kiosk-admin-roster.sql (kiosk_register_student etc.):
--   - kiosk_heartbeat_attempt   — "this student is on question X of Y, as of
--     now" — polled by the kiosk every few seconds while an exam is open.
--   - kiosk_submit_exam_result  — "this student finished with this score, at
--     this time" — called once, right when the kiosk finalizes a submission.
-- The administrator's Examination Control Center polls
-- list_kiosk_live_attempts()/list_kiosk_exam_results() straight from the
-- cloud, so it now reflects reality over the internet, not only over LAN.
--
-- Security model is the same as kiosk-admin-roster.sql: a kiosk device is
-- never signed into Supabase, so every student-facing function here is
-- SECURITY DEFINER, resolves the owning admin strictly from the join code,
-- and re-validates that the given student id actually belongs to that
-- admin's own roster before touching any row — a join code alone can never
-- be used to write a result or heartbeat under an arbitrary/forged identity.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Group results by exam file: a stable key shared by every attempt/version
--    of the same exam file, independent of who relayed the result in.
-- ----------------------------------------------------------------------------
alter table public.pharmatrack_kiosk_exam_results
  add column if not exists exam_key text not null default '';

create index if not exists pharmatrack_kiosk_exam_results_exam_key_idx
  on public.pharmatrack_kiosk_exam_results (user_id, exam_key);

-- ----------------------------------------------------------------------------
-- 2. Live in-progress attempts, reported directly by the kiosk device.
--    Short-lived by design: a heartbeat lapsing for a few minutes (device
--    closed, network dropped, exam finished) age the row out of
--    list_kiosk_live_attempts() automatically — no cron/cleanup job needed.
-- ----------------------------------------------------------------------------
create table if not exists public.pharmatrack_kiosk_live_attempts (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.pharmatrack_kiosk_admins(user_id) on delete cascade,
  student_id uuid not null,
  student_first_name text not null,
  student_level text not null,
  exam_key text not null,
  exam_title text not null,
  current_question integer not null default 1,
  total_questions integer not null default 0,
  started_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  device_label text,
  unique (admin_user_id, student_id, exam_key)
);

alter table public.pharmatrack_kiosk_live_attempts enable row level security;

drop policy if exists "Kiosk live attempts are readable by the owning admin" on public.pharmatrack_kiosk_live_attempts;

create policy "Kiosk live attempts are readable by the owning admin"
  on public.pharmatrack_kiosk_live_attempts for select
  using (auth.uid() = admin_user_id);

-- No insert/update/delete policies: every write goes through the
-- SECURITY DEFINER functions below, never directly from a client.
revoke all on public.pharmatrack_kiosk_live_attempts from anon, authenticated;

create index if not exists pharmatrack_kiosk_live_attempts_admin_idx
  on public.pharmatrack_kiosk_live_attempts (admin_user_id, last_seen_at desc);

-- ----------------------------------------------------------------------------
-- Shared helper: resolve + validate a (join code, student id) pair without
-- trusting anything else the caller sends about who that student is.
-- ----------------------------------------------------------------------------
create or replace function public._kiosk_resolve_roster_student(
  p_join_code text,
  p_student_id uuid
)
returns table (admin_user_id uuid, first_name text, level text)
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
    raise exception 'That admin join code was not recognized.';
  end if;

  select * into student_row
  from public.pharmatrack_kiosk_roster_students as roster
  where roster.id = p_student_id and roster.admin_user_id = admin_row.user_id;
  if not found then
    raise exception 'That student is not registered under this administrator.';
  end if;

  return query select admin_row.user_id, student_row.first_name, student_row.level;
end;
$$;

revoke all on function public._kiosk_resolve_roster_student(text, uuid) from public;

-- ----------------------------------------------------------------------------
-- 3. Anonymous, student-facing functions (no Supabase account; only a join
--    code + the student id issued at kiosk login/registration time).
-- ----------------------------------------------------------------------------

-- Called periodically (every few seconds) while a kiosk exam is open so the
-- administrator can see live progress over the internet, not only on LAN.
create or replace function public.kiosk_heartbeat_attempt(
  p_join_code text,
  p_student_id uuid,
  p_exam_key text,
  p_exam_title text,
  p_current_question integer,
  p_total_questions integer,
  p_device_label text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved record;
begin
  select * into resolved from public._kiosk_resolve_roster_student(p_join_code, p_student_id);

  insert into public.pharmatrack_kiosk_live_attempts (
    admin_user_id, student_id, student_first_name, student_level,
    exam_key, exam_title, current_question, total_questions, device_label
  )
  values (
    resolved.admin_user_id, p_student_id, resolved.first_name, resolved.level,
    coalesce(p_exam_key, ''), coalesce(p_exam_title, 'Examination'),
    greatest(coalesce(p_current_question, 1), 1), greatest(coalesce(p_total_questions, 0), 0),
    p_device_label
  )
  on conflict (admin_user_id, student_id, exam_key) do update set
    student_first_name = excluded.student_first_name,
    student_level = excluded.student_level,
    exam_title = excluded.exam_title,
    current_question = excluded.current_question,
    total_questions = excluded.total_questions,
    device_label = excluded.device_label,
    last_seen_at = timezone('utc', now());
end;
$$;

-- Called once an attempt is no longer "in progress" (submitted, or the
-- student abandoned/restarted) so it drops off the live panel immediately
-- instead of waiting for the heartbeat to go stale.
create or replace function public.kiosk_clear_attempt_progress(
  p_join_code text,
  p_student_id uuid,
  p_exam_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved record;
begin
  select * into resolved from public._kiosk_resolve_roster_student(p_join_code, p_student_id);
  delete from public.pharmatrack_kiosk_live_attempts
  where admin_user_id = resolved.admin_user_id
    and student_id = p_student_id
    and exam_key = coalesce(p_exam_key, '');
end;
$$;

-- Pushes one final score straight from the kiosk device to the cloud,
-- independent of any LAN authority connection to the admin's device. Upsert
-- key is deterministic (student + exam file), so a retried/duplicate submit
-- updates the same row instead of creating a second one.
create or replace function public.kiosk_submit_exam_result(
  p_join_code text,
  p_student_id uuid,
  p_exam_key text,
  p_exam_title text,
  p_score_percentage numeric,
  p_submitted_at timestamptz,
  p_device_label text default null
)
returns public.pharmatrack_kiosk_exam_results
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved record;
  result public.pharmatrack_kiosk_exam_results;
  computed_key text := coalesce(p_exam_key, '');
begin
  select * into resolved from public._kiosk_resolve_roster_student(p_join_code, p_student_id);

  insert into public.pharmatrack_kiosk_exam_results (
    user_id, result_key, student_first_name, student_level,
    exam_title, exam_key, score_percentage, submitted_at, device_label
  )
  values (
    resolved.admin_user_id, p_student_id::text || ':' || computed_key, resolved.first_name, resolved.level,
    coalesce(p_exam_title, 'Examination'), computed_key, p_score_percentage, p_submitted_at, p_device_label
  )
  on conflict (user_id, result_key) do update set
    student_first_name = excluded.student_first_name,
    student_level = excluded.student_level,
    exam_title = excluded.exam_title,
    exam_key = excluded.exam_key,
    score_percentage = excluded.score_percentage,
    submitted_at = excluded.submitted_at,
    device_label = excluded.device_label,
    updated_at = timezone('utc', now())
  returning * into result;

  delete from public.pharmatrack_kiosk_live_attempts
  where admin_user_id = resolved.admin_user_id
    and student_id = p_student_id
    and exam_key = computed_key;

  return result;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Admin-only read of live attempts (requires a signed-in PharmaTrack
--    account, exactly like list_kiosk_exam_results()).
-- ----------------------------------------------------------------------------
create or replace function public.list_kiosk_live_attempts()
returns setof public.pharmatrack_kiosk_live_attempts
language sql
security definer
set search_path = public
as $$
  select *
  from public.pharmatrack_kiosk_live_attempts
  where admin_user_id = auth.uid()
    and last_seen_at > timezone('utc', now()) - interval '3 minutes'
  order by started_at asc;
$$;

revoke all on function public.kiosk_heartbeat_attempt(text, uuid, text, text, integer, integer, text) from public;
revoke all on function public.kiosk_clear_attempt_progress(text, uuid, text) from public;
revoke all on function public.kiosk_submit_exam_result(text, uuid, text, text, numeric, timestamptz, text) from public;
revoke all on function public.list_kiosk_live_attempts() from public;

grant execute on function public.kiosk_heartbeat_attempt(text, uuid, text, text, integer, integer, text) to anon, authenticated;
grant execute on function public.kiosk_clear_attempt_progress(text, uuid, text) to anon, authenticated;
grant execute on function public.kiosk_submit_exam_result(text, uuid, text, text, numeric, timestamptz, text) to anon, authenticated;
grant execute on function public.list_kiosk_live_attempts() to authenticated;
