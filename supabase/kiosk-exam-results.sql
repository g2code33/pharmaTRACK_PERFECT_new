-- ============================================================================
-- PharmaTRACK kiosk exam results — all-time cloud log
--
-- Run after authentication.sql and security-rls.sql.
--
-- Scope, deliberately narrow: taking a kiosk exam and logging in to the
-- kiosk stay fully OFFLINE and require no account at all — this table never
-- backs that. It exists only so the administrator (who DOES have a
-- PharmaTRACK account, and occasionally has internet) can keep one durable,
-- all-time record of "which student, which exam, which score, when" that
-- is readable from anywhere, not just from a device that was on the exam
-- LAN at the time. Nothing else about an exam (questions, answers, security
-- events, LAN session state) is ever sent here.
--
-- Every row belongs to the administrator account that pushed it (auth.uid()),
-- exactly like the other sync tables in this project — there is no shared
-- "admin role" concept, so an admin's cloud log is private to their own
-- account by construction, the same RLS pattern already used everywhere else
-- in this schema.
-- ============================================================================

create table if not exists public.pharmatrack_kiosk_exam_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Stable per-result identifier (the local examination result id) so
  -- re-syncing the same result twice updates it in place instead of
  -- duplicating it.
  result_key text not null,
  student_first_name text not null,
  student_level text not null,
  exam_title text not null,
  score_percentage numeric not null check (score_percentage >= 0 and score_percentage <= 100),
  submitted_at timestamptz not null,
  device_label text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, result_key)
);

alter table public.pharmatrack_kiosk_exam_results enable row level security;

-- Explicit policies as a second boundary even though direct table access is
-- revoked below and the browser only ever calls the RPCs further down.
drop policy if exists "Kiosk exam results are readable by their owner" on public.pharmatrack_kiosk_exam_results;
drop policy if exists "Kiosk exam results are insertable by their owner" on public.pharmatrack_kiosk_exam_results;
drop policy if exists "Kiosk exam results are updateable by their owner" on public.pharmatrack_kiosk_exam_results;
drop policy if exists "Kiosk exam results are deletable by their owner" on public.pharmatrack_kiosk_exam_results;

create policy "Kiosk exam results are readable by their owner"
  on public.pharmatrack_kiosk_exam_results for select
  using (auth.uid() = user_id);

create policy "Kiosk exam results are insertable by their owner"
  on public.pharmatrack_kiosk_exam_results for insert
  with check (auth.uid() = user_id);

create policy "Kiosk exam results are updateable by their owner"
  on public.pharmatrack_kiosk_exam_results for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Kiosk exam results are deletable by their owner"
  on public.pharmatrack_kiosk_exam_results for delete
  using (auth.uid() = user_id);

revoke all on public.pharmatrack_kiosk_exam_results from anon, authenticated;

create index if not exists pharmatrack_kiosk_exam_results_user_submitted_idx
  on public.pharmatrack_kiosk_exam_results (user_id, submitted_at desc);

-- Upsert one result. SECURITY DEFINER so the function (not the browser) sets
-- user_id, always from the caller's own authenticated identity — a caller
-- can never write a row under anyone else's account.
create or replace function public.push_kiosk_exam_result(
  p_result_key text,
  p_student_first_name text,
  p_student_level text,
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
  result public.pharmatrack_kiosk_exam_results;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.pharmatrack_kiosk_exam_results (
    user_id, result_key, student_first_name, student_level,
    exam_title, score_percentage, submitted_at, device_label
  )
  values (
    auth.uid(), p_result_key, p_student_first_name, p_student_level,
    p_exam_title, p_score_percentage, p_submitted_at, p_device_label
  )
  on conflict (user_id, result_key) do update set
    student_first_name = excluded.student_first_name,
    student_level = excluded.student_level,
    exam_title = excluded.exam_title,
    score_percentage = excluded.score_percentage,
    submitted_at = excluded.submitted_at,
    device_label = excluded.device_label,
    updated_at = timezone('utc', now())
  returning * into result;

  return result;
end;
$$;

-- All of this admin's all-time kiosk results, newest first.
create or replace function public.list_kiosk_exam_results()
returns setof public.pharmatrack_kiosk_exam_results
language sql
security definer
set search_path = public
as $$
  select *
  from public.pharmatrack_kiosk_exam_results
  where user_id = auth.uid()
  order by submitted_at desc;
$$;

revoke all on function public.push_kiosk_exam_result(text, text, text, text, numeric, timestamptz, text) from public;
revoke all on function public.list_kiosk_exam_results() from public;
grant execute on function public.push_kiosk_exam_result(text, text, text, text, numeric, timestamptz, text) to authenticated;
grant execute on function public.list_kiosk_exam_results() to authenticated;
