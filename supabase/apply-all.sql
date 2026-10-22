-- Central Hub — consolidated schema, ALL phases in dependency order.
--
-- WHY THIS FILE EXISTS
--   The schema is split across six versioned migrations under
--   supabase/migrations/, which is the right shape for review and for
--   `supabase db push`. It is also painful to apply by hand: pasting six
--   files into the Supabase SQL Editor, in the right order, one at a time.
--   This file is the same set of statements, concatenated in the same order,
--   so the whole schema can be applied in a single paste.
--
--   Every statement here is idempotent, so this file is safe to run against a
--   project that already has some or all of the phases applied. It was
--   validated against PostgreSQL 18 with the Supabase roles emulated:
--     * on an empty database it builds all fifteen tables;
--     * on a database that already had phases 2, 3 and 4 applied it
--       re-applies them without error and without schema drift, then adds the
--       later phases;
--     * running it twice in a row changes nothing.
--
-- ORDER MATTERS
--   Phase 4 refuses to run while public.tasks is missing, and Phase 5 refuses
--   to run while public.observations is missing. The order below is
--   2 -> 3 -> 4 -> 5 -> 6 -> 7 and must not be changed.
--
-- HOW TO USE
--   1. Open the Supabase SQL Editor for your project.
--   2. Paste this whole file and run it.
--   3. If a step fails, fix the cause and run this file again — it is safe.
--   4. The last statement reloads PostgREST's schema cache, without which
--      column-scoped requests keep failing with PGRST204 / PGRST205 even
--      though the tables exist.
--
-- Source of truth: supabase/migrations/*.sql  (edit those, not this file).


-- ==========================================================================
-- ===== 20261020090000_work_logs_phase2.sql
-- ==========================================================================
-- Central Hub — Phase 2: work_logs schema completion + row-level security
-- Date: 2026-10-20
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- Context
--   The table public.work_logs already exists with:
--     id uuid primary key, user_id uuid, title text, notes text, created_at timestamptz
--   Row Level Security is already ENABLED on the table (verified against the live project:
--   an anon INSERT is rejected with 42501 "new row violates row-level security policy").
--
--   This migration
--     1. adds the columns the application needs,
--     2. adds constraints that protect data integrity,
--     3. replaces the (unknown/absent) policies with explicit, per-owner policies,
--     4. hardens grants so the anon role can never read or write the table.
--
-- Design rules honoured (MASTER_SPEC v2)
--   - Every record is owned by exactly one user; ownership is enforced in the DATABASE
--     via RLS, never only in the frontend.
--   - Durations use ONE unit everywhere: integer seconds.
--   - Event occurrence time (log_date) is stored SEPARATELY from ingestion time
--     (created_at), so late/out-of-order records are representable.
--   - Missing data is NULL, never 0.

begin;

-- ---------------------------------------------------------------------------
-- 0. Base table
-- ---------------------------------------------------------------------------
-- On the live project this table already exists (created by hand in the dashboard)
-- with the columns below, so the statement is a no-op there. It is included so the
-- schema can be bootstrapped from the repository on a fresh or staging database
-- instead of failing with "relation public.work_logs does not exist".
create table if not exists public.work_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  title      text,
  notes      text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.work_logs
  add column if not exists log_date         date,
  add column if not exists duration_seconds integer,
  add column if not exists display_name     text,
  add column if not exists updated_at       timestamptz default now();

comment on column public.work_logs.log_date is
  'Day the work was performed (user local date). Separate from created_at (ingestion time).';
comment on column public.work_logs.duration_seconds is
  'Canonical duration unit for the whole app: integer seconds. NULL means not recorded.';
comment on column public.work_logs.display_name is
  'Display name shown for the log owner. Ownership itself is always user_id; this is a label only.';

-- created_at is the ingestion timestamp; keep it server-assigned.
alter table public.work_logs
  alter column created_at set default now();

-- The client omits `id` from inserts (src/lib/logs.js), so the primary key needs
-- a server-side default. The live table's `id uuid` was created without one,
-- which makes every write fail with 23502 "null value in column id violates
-- not-null constraint" — nothing would ever persist.
alter table public.work_logs
  alter column id set default gen_random_uuid();

-- ---------------------------------------------------------------------------
-- 2. Integrity constraints
-- ---------------------------------------------------------------------------
-- Duration can never be negative.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'work_logs_duration_seconds_non_negative'
      and conrelid = 'public.work_logs'::regclass
  ) then
    alter table public.work_logs
      add constraint work_logs_duration_seconds_non_negative
      check (duration_seconds is null or duration_seconds >= 0);
  end if;
end
$$;

-- Inserts always stamp the caller's id; the client cannot forge another owner.
alter table public.work_logs
  alter column user_id set default auth.uid();

-- Enforce ownership NOT NULL.
-- A row with a NULL owner matches no auth.uid(), so it would be invisible to every
-- user AND undeletable through the app. That is a silent data-loss trap, so the
-- migration FAILS LOUDLY instead of committing a half-applied constraint.
do $$
declare
  orphan_count integer;
begin
  select count(*) into orphan_count
  from public.work_logs
  where user_id is null;

  if orphan_count > 0 then
    raise exception
      'work_logs has % row(s) with NULL user_id. Reassign them to a real owner or '
      'delete them, then re-run this migration.', orphan_count;
  end if;

  alter table public.work_logs
    alter column user_id set not null;
  raise notice 'work_logs.user_id set NOT NULL';
end
$$;

-- Keep updated_at fresh.
-- The function body uses a $body$ tag: a literal $$ inside this DO block would
-- terminate the block itself. CREATE OR REPLACE keeps this migration re-runnable.
do $$
begin
  create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  as $body$
  begin
    new.updated_at = now();
    return new;
  end;
  $body$;

  if not exists (
    select 1 from pg_trigger where tgname = 'work_logs_set_updated_at'
  ) then
    create trigger work_logs_set_updated_at
      before update on public.work_logs
      for each row
      execute function public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security — explicit per-owner policies
-- ---------------------------------------------------------------------------
alter table public.work_logs enable row level security;

-- Remove EVERY existing policy before creating the intended set.
-- PostgreSQL ORs permissive policies together, so a leftover policy with an
-- unknown name (for example `with check (true)`) would silently widen access
-- for every signed-in user. Dropping only known names is not enough.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select polname from pg_policy where polrelid = 'public.work_logs'::regclass
  loop
    execute format('drop policy %I on public.work_logs', policy_row.polname);
  end loop;
end
$$;

-- Grants are ADDITIVE in PostgreSQL: a later `grant` cannot take a privilege
-- away. Supabase's default for a table created in the dashboard is
-- `grant all ... to authenticated`, which includes TRUNCATE — and TRUNCATE is
-- NOT governed by RLS, so any signed-in user could wipe every user's rows.
-- Revoke first, then grant back only what the app needs.
revoke all on public.work_logs from anon, authenticated;

grant select, insert, update, delete on public.work_logs to authenticated;

-- (select auth.uid()) is the Supabase-recommended form: it is evaluated once per
-- statement instead of once per row.
create policy "work_logs_select_own"
  on public.work_logs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "work_logs_insert_own"
  on public.work_logs
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "work_logs_update_own"
  on public.work_logs
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "work_logs_delete_own"
  on public.work_logs
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 3b. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app subscribes to row changes on work_logs via supabase_realtime.
-- Tables must be explicitly added to the publication for realtime to work.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'work_logs'
  ) then
    alter publication supabase_realtime add table public.work_logs;
  end if;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run as the signed-in user, expected results in brackets)
-- ---------------------------------------------------------------------------
-- select * from public.work_logs;                                   [own rows only]
-- insert into public.work_logs (title, log_date, duration_seconds)
--   values ('probe', current_date, 60);                              [succeeds]
-- update public.work_logs set title = 'x' where id = '<other-user-row>';  [0 rows]
-- delete from public.work_logs where id = '<other-user-row>';        [0 rows]
-- set role anon; select * from public.work_logs;                     [permission denied]

-- ==========================================================================
-- ===== 20261020091000_tasks_phase3.sql
-- ==========================================================================
-- Central Hub — Phase 3: tasks table + row-level security
-- Date: 2026-10-20
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- Context
--   This migration introduces the `tasks` table — the first of the goals/projects/tasks
--   domain (Section B of MASTER_SPEC). Tasks are PLANNED INTENT, deliberately separate
--   from observed activity (`work_logs`). A task has no duration of its own; its
--   `estimated_duration_seconds` is a planning field, and actual time spent is recorded
--   later as attributed sessions against this task (Phase 4).
--
-- Design rules honoured (MASTER_SPEC v2, Section 7B/8)
--   - Every record is owned by exactly one user; ownership is enforced in the DATABASE
--     via RLS, never only in the frontend.
--   - `user_id` defaults to `auth.uid()` and is NOT NULL; an orphan guard FAILS LOUDLY
--     rather than committing a half-applied constraint.
--   - Durations use ONE unit everywhere: integer seconds. `estimated_duration_seconds`
--     IS NULL means "not estimated" — never 0.
--   - Task status is a state machine with a CHECK constraint; the transition rules are
--     documented in docs/DATA_MODEL.md and validated in the client.
--   - The `updated_at` trigger reuses `public.set_updated_at()` from the Phase 2
--     migration (CREATE OR REPLACE keeps this migration re-runnable).
--
-- Idempotent: safe to apply repeatedly (`if not exists`, `add column if not exists`,
-- policy-drop loop, `revoke ... grant` ordered correctly).

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null default auth.uid() references auth.users(id),
  title                    text not null,
  description              text,
  status                   text not null default 'todo',
  priority                 text not null default 'medium',
  due_date                 date,
  estimated_duration_seconds integer,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint tasks_status_valid
    check (status in ('todo','in_progress','in_review','completed','blocked','cancelled')),
  constraint tasks_priority_valid
    check (priority in ('low','medium','high','urgent')),
  constraint tasks_duration_non_negative
    check (estimated_duration_seconds is null or estimated_duration_seconds >= 0)
);

comment on column public.tasks.user_id is
  'Owner. Defaults to auth.uid(); the client cannot forge another owner.';
comment on column public.tasks.status is
  'Task state. Transitions documented in docs/DATA_MODEL.md. A task status is
   INTENT (planned progress), separate from time-tracking status.';
comment on column public.tasks.estimated_duration_seconds is
  'Canonical planning duration: integer seconds. NULL means not estimated, never 0.';
comment on column public.tasks.completed_at is
  'UTC timestamp set when status transitions to completed. NULL while open.';
comment on column public.tasks.due_date is
  'Calendar day in the user local date-space, stored as a plain date.';

-- ---------------------------------------------------------------------------
-- 2b. completed_at follows the status (database is the last line of defence)
-- ---------------------------------------------------------------------------
-- The app sets completed_at in TasksContext.transitionTask, but a client-side rule
-- alone can be bypassed (a direct REST write, a future API, a second client). The
-- constraint makes "completed" and "completed_at" impossible to disagree.
do $$
declare
  inconsistent integer;
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_completed_at_matches_status'
      and conrelid = 'public.tasks'::regclass
  ) then
    select count(*) into inconsistent
    from public.tasks
    where (status = 'completed') <> (completed_at is not null);

    if inconsistent > 0 then
      raise exception
        'public.tasks has % row(s) where status and completed_at disagree. Set '
        'completed_at for completed tasks and clear it for open ones, then re-run '
        'this migration.', inconsistent;
    end if;

    alter table public.tasks
      add constraint tasks_completed_at_matches_status
      check ((status = 'completed') = (completed_at is not null));
  end if;
end
$$;

-- Keep updated_at fresh. Reuse (or create) the trigger function; idempotent.
do $$
begin
  create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  as $body$
  begin
    new.updated_at = now();
    return new;
  end;
  $body$;

  if not exists (
    select 1 from pg_trigger where tgname = 'tasks_set_updated_at'
  ) then
    create trigger tasks_set_updated_at
      before update on public.tasks
      for each row
      execute function public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Ownership enforcement (fail loudly on orphan rows)
-- ---------------------------------------------------------------------------
alter table public.tasks
  alter column user_id set default auth.uid();

do $$
declare
  orphan_count integer;
begin
  select count(*) into orphan_count
  from public.tasks
  where user_id is null;

  if orphan_count > 0 then
    raise exception
      'tasks has % row(s) with NULL user_id. Reassign them to a real owner or '
      'delete them, then re-run this migration.', orphan_count;
  end if;

  alter table public.tasks
    alter column user_id set not null;
  raise notice 'tasks.user_id set NOT NULL';
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security — explicit per-owner policies
-- ---------------------------------------------------------------------------
alter table public.tasks enable row level security;

-- Remove EVERY existing policy before creating the intended set.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select polname from pg_policy where polrelid = 'public.tasks'::regclass
  loop
    execute format('drop policy %I on public.tasks', policy_row.polname);
  end loop;
end
$$;

-- Grants are ADDITIVE in PostgreSQL: a later `grant` cannot take a privilege away.
-- Supabase's default for a table created in the dashboard is `grant all ... to
-- authenticated`, which includes TRUNCATE — and TRUNCATE is NOT governed by RLS,
-- so any signed-in user could wipe every user's rows. Revoke first, then grant back
-- only what the app needs.
revoke all on public.tasks from anon, authenticated;
grant select, insert, update, delete on public.tasks to authenticated;

create policy "tasks_select_own"
  on public.tasks
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "tasks_insert_own"
  on public.tasks
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "tasks_update_own"
  on public.tasks
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "tasks_delete_own"
  on public.tasks
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 4. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app subscribes to row changes on tasks via supabase_realtime
-- (src/features/tasks/TasksContext.jsx). Tables must be explicitly added to the
-- publication for realtime to work, otherwise the channel subscribes and
-- silently receives nothing.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app subscribes to task changes via supabase_realtime (TasksContext). Tables
-- must be explicitly added to the publication for realtime to work.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run as the signed-in user, expected results in brackets)
-- ---------------------------------------------------------------------------
-- set_config('app.current_uid','<alice>');   -- emulate Supabase auth.uid() locally
-- select * from public.tasks;                                  [own rows only]
-- insert into public.tasks (title) values ('probe');            [succeeds, user_id = alice]
-- update public.tasks set title = 'x' where id = '<bob-row>';  [0 rows updated]
-- delete from public.tasks where id = '<bob-row>';             [0 rows deleted]
-- insert into public.tasks (user_id, title) values ('<bob>','forged');  [42501]
-- set role anon; select * from public.tasks;                   [permission denied]

-- ==========================================================================
-- ===== 20261020100000_time_tracking_phase4.sql
-- ==========================================================================
-- Central Hub — Phase 4: time tracking (observations, sessions, corrections)
-- Date: 2026-10-20
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- Context
--   Phase 4 (MASTER_SPEC Section 7C) introduces the four tracking concepts that
--   the earlier phases did not model:
--
--     observation -> a raw event ("something happened at T"), never a duration of work
--     session    -> a time interval derived from observations, carrying attribution
--     attribution-> the link from a session to a task, with a source and a confidence
--     outcome    -> an explicitly verified result (deferred: a task reaching
--                   `completed` is currently recorded only as `tasks.completed_at`)
--
--   `work_logs` (Phase 2) stays as the dashboard's daily log entry. It is NOT the
--   source of truth for time totals: a report must never sum `work_logs.duration_seconds`
--   together with `sessions.duration_seconds`, because the same work could be recorded
--   in both (see docs/DECISIONS.md D-007).
--
-- Design rules honoured (MASTER_SPEC v2, Section 7C/8)
--   - Every observation carries a CLIENT-GENERATED unique id, used as the primary key.
--     Re-sending the same observation is a no-op (`on conflict (id) do nothing`), so
--     ingestion is idempotent by construction.
--   - Event occurrence time (`occurred_at`) is stored SEPARATELY from ingestion time
--     (`ingested_at`), so late and out-of-order events are representable.
--   - Durations use ONE unit everywhere: integer seconds. NULL means "not recorded" —
--     never 0.
--   - Overlapping observations MUST NOT be double-counted: a session's duration is the
--     length of the UNION of its observation intervals. The rule is implemented once, in
--     src/features/tracking/sessionUtils.js, and covered by assertions.
--   - Manual corrections are stored as SEPARATE records (`session_corrections`); the
--     observed values in `sessions` are never overwritten, so the original stays auditable.
--   - Ownership is enforced in the DATABASE via RLS, never only in the frontend.
--
-- Additive only: `work_logs` and `tasks` are not modified, and no existing row is
-- touched. Rollback: drop `public.session_corrections`, `public.sessions`,
-- `public.observations` (in that order) — nothing else depends on them.
--
-- Idempotent: safe to apply repeatedly (`create table if not exists`, policy-drop loop,
-- `revoke ... grant` ordered correctly, guarded publication membership).

begin;

-- The sessions table references public.tasks (attribution). If the Phase 3 migration
-- has not been applied yet, the FK would fail with an opaque "relation does not exist"
-- error, so fail loudly with the actual remedy.
do $$
begin
  if to_regclass('public.tasks') is null then
    raise exception
      'public.tasks does not exist. Apply supabase/migrations/20261020091000_tasks_phase3.sql '
      'before this migration (sessions.task_id references tasks).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. observations — raw events (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.observations (
  id               uuid primary key,                    -- CLIENT-GENERATED idempotency key
  user_id          uuid not null default auth.uid() references auth.users(id),
  source           text not null default 'manual',
  occurred_at      timestamptz not null,                -- occurrence time (UTC)
  ingested_at      timestamptz not null default now(),  -- ingestion time
  duration_seconds integer,                             -- span covered; NULL = point event
  application      text,                                -- minimal metadata (app name)
  window_title     text,                                -- only when the user opts in
  is_idle          boolean not null default false,
  constraint observations_source_valid
    check (source in ('manual','collector','import')),
  constraint observations_duration_non_negative
    check (duration_seconds is null or duration_seconds >= 0)
);

comment on table public.observations is
  'Raw observed events. The primary key is generated by the client, so repeating an
   ingestion is a no-op. Rows are append-only: UPDATE is not granted to the client, so
   an observation can never be silently overwritten.';
comment on column public.observations.id is
  'Client-generated idempotency key. Re-sending the same observation does not create a
   second row (insert with on conflict (id) do nothing).';
comment on column public.observations.occurred_at is
  'UTC time the event happened. Distinct from ingested_at (when the row arrived), so late
   and out-of-order events are representable.';
comment on column public.observations.duration_seconds is
  'Canonical duration unit: integer seconds. NULL means the observation is a point event
   with no recorded span — never 0.';

-- ---------------------------------------------------------------------------
-- 2. sessions — derived time intervals with attribution
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id),
  started_at            timestamptz not null,
  ended_at              timestamptz not null,
  duration_seconds      integer,                       -- NULL = no measured coverage
  idle_seconds          integer,                       -- NULL = idle not measured
  source                text not null default 'manual',
  application           text,
  timezone              text not null default 'UTC',   -- IANA name, used for day boundaries
  task_id               uuid references public.tasks(id) on delete set null,
  attribution_source    text,                          -- 'manual' | 'rule' | 'inferred'
  attribution_confidence numeric,                      -- 0..1, NULL = unknown
  observation_ids       uuid[],                        -- observations that produced it
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint sessions_source_valid
    check (source in ('manual','collector','import')),
  constraint sessions_duration_non_negative
    check (duration_seconds is null or duration_seconds >= 0),
  constraint sessions_idle_non_negative
    check (idle_seconds is null or idle_seconds >= 0),
  constraint sessions_time_order
    check (ended_at >= started_at),
  constraint sessions_confidence_range
    check (attribution_confidence is null or (attribution_confidence >= 0 and attribution_confidence <= 1)),
  constraint sessions_attribution_source_valid
    check (attribution_source is null or attribution_source in ('manual','rule','inferred'))
);

comment on table public.sessions is
  'A time interval of work. duration_seconds is the length of the UNION of the member
   observation intervals, so overlapping observations are never double-counted. Attribution
   is explicit: task_id + attribution_source + attribution_confidence. A session with no
   task is unattributed — the system never invents a task relationship.';
comment on column public.sessions.duration_seconds is
  'Canonical duration unit: integer seconds. Length of the union of the member
   observation intervals (overlap rule).';
comment on column public.sessions.idle_seconds is
  'Union length of the idle observations inside the session. NULL means idle was not
   measured, so active time cannot be derived.';
comment on column public.sessions.task_id is
  'Attributed task. ON DELETE SET NULL: deleting a task must not destroy recorded time —
   the session survives as unattributed evidence.';
comment on column public.sessions.attribution_confidence is
  'Confidence of the attribution, 0..1. NULL means unknown. A session is only
   "confirmed" when attribution_source = manual.';
comment on column public.sessions.timezone is
  'IANA timezone in force when the session was recorded; used for local-day bucketing.';

-- ---------------------------------------------------------------------------
-- 3. session_corrections — manual corrections as separate records (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.session_corrections (
  id                       uuid primary key,           -- CLIENT-GENERATED idempotency key
  user_id                  uuid not null default auth.uid() references auth.users(id),
  session_id               uuid not null references public.sessions(id) on delete cascade,
  previous_started_at      timestamptz,
  previous_ended_at        timestamptz,
  previous_duration_seconds integer,
  corrected_started_at     timestamptz not null,
  corrected_ended_at       timestamptz not null,
  corrected_duration_seconds integer not null,
  reason                   text,
  created_at               timestamptz not null default now(),
  constraint session_corrections_duration_non_negative
    check (corrected_duration_seconds >= 0),
  constraint session_corrections_time_order
    check (corrected_ended_at >= corrected_started_at),
  constraint session_corrections_duration_matches_interval
    check (corrected_duration_seconds = (extract(epoch from (corrected_ended_at - corrected_started_at)))::integer)
);

comment on table public.session_corrections is
  'Manual corrections stored as their own records. The observed values in `sessions` are
   never overwritten, so the original stays auditable. The latest correction for a
   session is its effective correction.';
comment on column public.session_corrections.previous_duration_seconds is
  'The observed value at the time of correction. Kept for audit; never used to overwrite
   the session row.';

-- ---------------------------------------------------------------------------
-- 4. Ownership enforcement (fail loudly on orphan rows)
-- ---------------------------------------------------------------------------
do $$
declare
  orphan_count integer;
begin
  foreach orphan_count in array array[
    (select count(*) from public.observations   where user_id is null),
    (select count(*) from public.sessions      where user_id is null),
    (select count(*) from public.session_corrections where user_id is null)
  ] loop
    if orphan_count > 0 then
      raise exception
        'Phase 4 time-tracking tables have % row(s) with NULL user_id. Reassign them to a '
        'real owner or delete them, then re-run this migration.', orphan_count;
    end if;
  end loop;

  alter table public.observations       alter column user_id set not null;
  alter table public.sessions          alter column user_id set not null;
  alter table public.session_corrections alter column user_id set not null;
  raise notice 'phase 4 user_id columns set NOT NULL';
end
$$;

alter table public.observations         alter column user_id set default auth.uid();
alter table public.sessions            alter column user_id set default auth.uid();
alter table public.session_corrections alter column user_id set default auth.uid();

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger (sessions only — observations and corrections are append-only)
-- ---------------------------------------------------------------------------
do $$
begin
  create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  as $body$
  begin
    new.updated_at = now();
    return new;
  end;
  $body$;

  if not exists (
    select 1 from pg_trigger where tgname = 'sessions_set_updated_at'
  ) then
    create trigger sessions_set_updated_at
      before update on public.sessions
      for each row
      execute function public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Indexes (bounded reads are ordered by time)
-- ---------------------------------------------------------------------------
create index if not exists observations_owner_occurred_at_idx
  on public.observations (user_id, occurred_at desc);
create index if not exists sessions_owner_started_at_idx
  on public.sessions (user_id, started_at desc);
create index if not exists sessions_task_id_idx
  on public.sessions (task_id);
create index if not exists session_corrections_session_id_idx
  on public.session_corrections (session_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. Row Level Security — explicit per-owner policies
-- ---------------------------------------------------------------------------
alter table public.observations         enable row level security;
alter table public.sessions            enable row level security;
alter table public.session_corrections enable row level security;

-- Remove EVERY existing policy before creating the intended set. PostgreSQL ORs
-- permissive policies together, so a leftover policy with an unknown name (for example
-- `with check (true)`) would silently widen access for every signed-in user.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select polname from pg_policy where polrelid = 'public.observations'::regclass
  loop
    execute format('drop policy %I on public.observations', policy_row.polname);
  end loop;

  for policy_row in
    select polname from pg_policy where polrelid = 'public.sessions'::regclass
  loop
    execute format('drop policy %I on public.sessions', policy_row.polname);
  end loop;

  for policy_row in
    select polname from pg_policy where polrelid = 'public.session_corrections'::regclass
  loop
    execute format('drop policy %I on public.session_corrections', policy_row.polname);
  end loop;
end
$$;

-- Grants are ADDITIVE in PostgreSQL: a later `grant` cannot take a privilege away.
-- Supabase's default for a table created in the dashboard is `grant all ... to
-- authenticated`, which includes TRUNCATE — and TRUNCATE is NOT governed by RLS, so any
-- signed-in user could wipe every user's rows. Revoke first, then grant back only what
-- the app needs.
revoke all on public.observations         from anon, authenticated;
revoke all on public.sessions            from anon, authenticated;
revoke all on public.session_corrections from anon, authenticated;

-- observations and session_corrections are append-only: no UPDATE grant.
grant select, insert, delete on public.observations         to authenticated;
grant select, insert, delete on public.session_corrections to authenticated;
grant select, insert, update, delete on public.sessions     to authenticated;

-- (select auth.uid()) is the Supabase-recommended form: it is evaluated once per
-- statement instead of once per row.
create policy "observations_select_own"
  on public.observations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "observations_insert_own"
  on public.observations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "observations_delete_own"
  on public.observations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "sessions_select_own"
  on public.sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- A session may only reference a task owned by the SAME user. The subquery runs under
-- the caller's RLS on `tasks`, so it can only ever see the caller's own tasks.
create policy "sessions_insert_own"
  on public.sessions
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      task_id is null
      or exists (
        select 1 from public.tasks t
        where t.id = sessions.task_id
          and t.user_id = (select auth.uid())
      )
    )
  );

create policy "sessions_update_own"
  on public.sessions
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      task_id is null
      or exists (
        select 1 from public.tasks t
        where t.id = sessions.task_id
          and t.user_id = (select auth.uid())
      )
    )
  );

create policy "sessions_delete_own"
  on public.sessions
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "session_corrections_select_own"
  on public.session_corrections
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- A correction may only reference a session owned by the SAME user. The subquery runs
-- under the caller's RLS on `sessions`.
create policy "session_corrections_insert_own"
  on public.session_corrections
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.sessions s
      where s.id = session_corrections.session_id
        and s.user_id = (select auth.uid())
    )
  );

create policy "session_corrections_delete_own"
  on public.session_corrections
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 8. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app subscribes to row changes through supabase_realtime. Tables must be
-- explicitly added to the publication for realtime to work.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['observations', 'sessions', 'session_corrections']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run as the signed-in user, expected results in brackets)
-- ---------------------------------------------------------------------------
-- set_config('app.current_uid','<alice>');                                  -- emulate auth.uid()
-- insert into public.observations (id, occurred_at, duration_seconds)
--   values ('<client-uuid>', now(), 60);                    [succeeds, user_id = alice]
-- insert into public.observations (id, occurred_at)          -- same id again
--   values ('<client-uuid>', now());                         [no second row: idempotent]
-- select * from public.observations;                         [own rows only]
-- insert into public.sessions (started_at, ended_at, duration_seconds)
--   values (now(), now(), 60);                               [succeeds]
-- insert into public.sessions (started_at, ended_at, duration_seconds, task_id)
--   values (now(), now(), 60, '<bob-task>');                 [42501: policy violation]
-- update public.sessions set title = 'x';                   [0 rows for another user]
-- set role anon; select * from public.sessions;              [permission denied]

-- ==========================================================================
-- ===== 20261020110000_integrations_phase5.sql
-- ==========================================================================
-- Central Hub — Phase 5: integrations (connections, sync runs, observation provenance)
-- Date: 2026-10-20
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- Context
--   Phase 5 (MASTER_SPEC Section 7D) introduces the integration domain: the app talks to
--   external data sources through INDEPENDENT ADAPTERS, each with a documented contract
--   (what it can access, how it authenticates, what it reads and writes, how it
--   deduplicates, and what happens on disconnect).
--
--   This migration creates the PERSISTENCE layer only — it adds no adapter and talks to
--   no external service:
--
--     integrations          -> one row per user + provider connection: truthful state,
--                              last successful sync time, non-sensitive adapter settings
--     integration_sync_runs -> one row per synchronisation attempt: what was seen, what
--                              was written, what was skipped, and the failure reason
--
--   `observations` (Phase 4) gains an `integration_id` provenance column, so a row that
--   was IMPORTED by an adapter can be traced back to the connection that produced it —
--   and removed together with it on disconnect.
--
-- Design rules honoured (MASTER_SPEC v2, Section 7D/8)
--   - Every record is owned by exactly one user; ownership is enforced in the DATABASE
--     via RLS, never only in the frontend.
--   - `user_id` defaults to `auth.uid()` and is NOT NULL; an orphan guard FAILS LOUDLY
--     rather than committing a half-applied constraint.
--   - Truthful connection states only: 'disconnected', 'connecting', 'connected',
--     'syncing', 'error' — enforced by a CHECK constraint, so the UI can never show a
--     state the database does not know.
--   - `config` holds NON-SENSITIVE adapter settings ONLY (file paths, filters, poll
--     intervals, limits). Credentials are NEVER stored there — a credential belongs in a
--     secret store, which this migration does not create yet.
--   - Disconnect is a DELETE of the connection row: the integration, its sync runs and
--     the observations it imported are removed by ON DELETE CASCADE — exactly the data
--     that integration produced, and nothing else.
--   - Sync runs are started-then-closed records: `started_at`/`finished_at` plus the
--     record counters, which are non-negative. `records_skipped` is what keeps a
--     re-import idempotent and auditable.
--
-- ADDITIVE ONLY: no existing table is dropped and no existing row is touched. The only
-- change to an existing table is `public.observations` gaining a NULLABLE
-- `integration_id` column — NULL means "not produced by an integration", so the Phase 4
-- behaviour of existing observations is unchanged.
--
-- Disconnect semantics
--   delete from public.integrations where id = '<integration>';
--     -> the integration row is removed,
--     -> its `integration_sync_runs` are removed (ON DELETE CASCADE),
--     -> every observation that referenced it is removed (ON DELETE CASCADE).
--   Observations that were NOT imported by that integration (integration_id IS NULL, or
--   pointing at another integration) are untouched.
--
-- Rollback
--   The ORDER matters: `observations.integration_id` holds the foreign key to
--   `public.integrations`, so dropping the table first fails loudly with
--   "constraint observations_integration_id_fkey on table observations depends on
--   table integrations". Drop the link first:
--   drop trigger if exists observations_integration_owner_guard on public.observations;
--   drop function if exists public.observations_integration_owner_guard();
--   alter table public.observations drop column if exists integration_id;
--   drop table public.integration_sync_runs, public.integrations;
--
-- Idempotent: safe to apply repeatedly (`create table if not exists`,
-- `add column if not exists`, `create index if not exists`, policy-drop loop,
-- `revoke ... grant` ordered correctly, guarded trigger/publication membership).

begin;

-- The observations table carries the provenance link. If the Phase 4 migration has not
-- been applied yet, the `alter table` below would fail with an opaque "relation does
-- not exist" error, so fail loudly with the actual remedy.
do $$
begin
  if to_regclass('public.observations') is null then
    raise exception
      'public.observations does not exist. Apply supabase/migrations/20261020100000_time_tracking_phase4.sql '
      'before this migration (observations.integration_id references integrations).';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. integrations — one connection per provider per user
-- ---------------------------------------------------------------------------
create table if not exists public.integrations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id),
  provider     text not null,                              -- adapter id, e.g. 'local_activity_file'
  label        text,                                       -- human-readable name of the connection
  status       text not null default 'disconnected',
  config       jsonb not null default '{}'::jsonb,          -- NON-SENSITIVE settings only
  last_sync_at timestamptz,                                -- last SUCCESSFUL sync (UTC)
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint integrations_status_valid
    check (status in ('disconnected','connecting','connected','syncing','error')),
  constraint integrations_user_provider_unique
    unique (user_id, provider)
);

comment on table public.integrations is
  'One connection between a user and an external provider, driven by an independent
   adapter. The row is the TRUTHFUL state of the connection: the UI reads it, it never
   invents a state. Deleting the row disconnects the provider and removes everything
   that connection produced (its sync runs and the observations it imported).';
comment on column public.integrations.user_id is
  'Owner. Defaults to auth.uid(); the client cannot forge another owner.';
comment on column public.integrations.provider is
  'Adapter id of the provider, e.g. ''local_activity_file''. One connection per
   (user_id, provider): a user cannot hold two connections to the same provider.';
comment on column public.integrations.label is
  'Human-readable name of the connection, shown in the UI. NULL means "not labelled".';
comment on column public.integrations.status is
  'Truthful connection state: disconnected | connecting | connected | syncing | error.
   Enforced by a CHECK constraint, so no client can store a state the UI cannot render.';
comment on column public.integrations.config is
  'NON-SENSITIVE adapter settings ONLY (file paths, filters, poll intervals, limits).
   CREDENTIALS MUST NEVER BE STORED HERE — this column is readable by every signed-in
   user through the client, so a secret written here is a secret leaked. Credentials
   belong in a server-side secret store, which does not exist yet.';
comment on column public.integrations.last_sync_at is
  'UTC time of the last SUCCESSFUL synchronisation. NULL means "never synced
   successfully" — never 0.';
comment on column public.integrations.last_error is
  'Last failure message of this connection. NULL means "no error recorded".';

-- One connection per provider per user. If the table already existed without the
-- constraint, add it (a pre-existing table is the only way this can be missing);
-- duplicate rows make the ADD fail loudly, which is the desired outcome.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'integrations_user_provider_unique'
      and conrelid = 'public.integrations'::regclass
  ) then
    alter table public.integrations
      add constraint integrations_user_provider_unique
      unique (user_id, provider);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. integration_sync_runs — one row per synchronisation attempt
-- ---------------------------------------------------------------------------
create table if not exists public.integration_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id),
  integration_id  uuid not null references public.integrations(id) on delete cascade,
  status          text not null default 'running',          -- running | success | error
  started_at      timestamptz not null default now(),        -- UTC
  finished_at     timestamptz,                              -- UTC; NULL while running
  records_seen    integer not null default 0,
  records_written integer not null default 0,
  records_skipped integer not null default 0,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint integration_sync_runs_status_valid
    check (status in ('running','success','error')),
  constraint integration_sync_runs_records_non_negative
    check (records_seen >= 0 and records_written >= 0 and records_skipped >= 0),
  constraint integration_sync_runs_time_order
    check (finished_at is null or finished_at >= started_at)
);

comment on table public.integration_sync_runs is
  'One synchronisation attempt of one integration. A run is opened with status
   ''running'' and closed with ''success'' or ''error''; the counters say what the
   adapter saw, wrote and skipped. Runs are the audit trail of an import and they
   disappear with the connection they belong to (ON DELETE CASCADE).';
comment on column public.integration_sync_runs.user_id is
  'Owner. Defaults to auth.uid(); the client cannot forge another owner. A run may
   only reference an integration owned by the SAME user — enforced by the RLS policy
   (the referenced integration is looked up under the caller''s own RLS).';
comment on column public.integration_sync_runs.integration_id is
  'The connection this run belongs to. ON DELETE CASCADE: disconnecting removes the
   run history together with the connection.';
comment on column public.integration_sync_runs.status is
  'Run state: running | success | error. A run left in ''running'' means the adapter
   never closed it (crash, timeout) — it is the truth, not an estimate.';
comment on column public.integration_sync_runs.finished_at is
  'UTC time the run was closed. NULL while the run is still running.';
comment on column public.integration_sync_runs.records_seen is
  'Records the adapter read from the source.';
comment on column public.integration_sync_runs.records_written is
  'Records actually written to the app. The difference against records_seen is what
   records_skipped explains.';
comment on column public.integration_sync_runs.records_skipped is
  'Records deliberately not written (already present, filtered out, not applicable).
   This is what makes a repeated import idempotent and auditable.';
comment on column public.integration_sync_runs.error is
  'Failure message of the run. NULL means "no error recorded".';

-- ---------------------------------------------------------------------------
-- 3. Ownership enforcement (fail loudly on orphan rows)
-- ---------------------------------------------------------------------------
alter table public.integrations          alter column user_id set default auth.uid();
alter table public.integration_sync_runs alter column user_id set default auth.uid();

do $$
declare
  orphan_count integer;
begin
  foreach orphan_count in array array[
    (select count(*) from public.integrations          where user_id is null),
    (select count(*) from public.integration_sync_runs where user_id is null)
  ] loop
    if orphan_count > 0 then
      raise exception
        'Phase 5 integration tables have % row(s) with NULL user_id. Reassign them to a '
        'real owner or delete them, then re-run this migration.', orphan_count;
    end if;
  end loop;

  alter table public.integrations          alter column user_id set not null;
  alter table public.integration_sync_runs alter column user_id set not null;
  raise notice 'phase 5 user_id columns set NOT NULL';
end
$$;

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger (both tables are mutable: a run is opened and then closed)
-- ---------------------------------------------------------------------------
do $$
begin
  create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  as $body$
  begin
    new.updated_at = now();
    return new;
  end;
  $body$;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'integrations_set_updated_at'
      and tgrelid = 'public.integrations'::regclass
  ) then
    create trigger integrations_set_updated_at
      before update on public.integrations
      for each row
      execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'integration_sync_runs_set_updated_at'
      and tgrelid = 'public.integration_sync_runs'::regclass
  ) then
    create trigger integration_sync_runs_set_updated_at
      before update on public.integration_sync_runs
      for each row
      execute function public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Indexes (bounded reads are ordered by time)
-- ---------------------------------------------------------------------------
create index if not exists integrations_user_id_idx
  on public.integrations (user_id);
create index if not exists integration_sync_runs_integration_id_idx
  on public.integration_sync_runs (integration_id);
create index if not exists integration_sync_runs_owner_started_at_idx
  on public.integration_sync_runs (user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 6. Provenance: observations imported by an integration
-- ---------------------------------------------------------------------------
-- The link makes imported rows traceable to the connection that produced them, and
-- makes disconnect exact: deleting the integration removes exactly the observations it
-- imported (ON DELETE CASCADE) and nothing else.
alter table public.observations
  add column if not exists integration_id uuid references public.integrations(id) on delete cascade;

comment on column public.observations.integration_id is
  'The integration that imported this observation. NULL means "not produced by an
   integration" (manual entry, collector). ON DELETE CASCADE: disconnecting removes the
   observations that integration imported, and only those.';

create index if not exists observations_integration_id_idx
  on public.observations (integration_id);

-- Ownership guard for the provenance link.
--
-- This is a TRIGGER, not a policy: the Phase 4 observations policies are intentionally
-- left untouched (they are append-only and grant no UPDATE). The trigger enforces the
-- rule on every write path, including the ones a policy cannot cover.
--
-- The lookup runs with the CALLER's privileges, so RLS on `integrations` hides every
-- connection the caller does not own. "Not visible" therefore means "not the caller's",
-- and the write is rejected. This is the same pattern the Phase 4 policies use for
-- `sessions.task_id` / `session_corrections.session_id`.
do $$
begin
  create or replace function public.observations_integration_owner_guard()
  returns trigger
  language plpgsql
  as $body$
  declare
    caller_uid uuid := auth.uid();
    owner_uid  uuid;
  begin
    -- Back-end / service_role writes carry no auth.uid(); they are trusted, and the
    -- foreign key still guarantees the referenced integration exists.
    if caller_uid is null then
      return new;
    end if;

    if new.integration_id is null then
      return new;
    end if;

    select i.user_id into owner_uid
    from public.integrations i
    where i.id = new.integration_id;

    if owner_uid is null or owner_uid <> caller_uid then
      raise exception
        'observations.integration_id must reference an integration owned by the caller.';
    end if;

    return new;
  end;
  $body$;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'observations_integration_owner_guard'
      and tgrelid = 'public.observations'::regclass
  ) then
    create trigger observations_integration_owner_guard
      before insert or update on public.observations
      for each row
      execute function public.observations_integration_owner_guard();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Row Level Security — explicit per-owner policies
-- ---------------------------------------------------------------------------
alter table public.integrations          enable row level security;
alter table public.integration_sync_runs enable row level security;

-- Remove EVERY existing policy before creating the intended set. PostgreSQL ORs
-- permissive policies together, so a leftover policy with an unknown name (for example
-- `with check (true)`) would silently widen access for every signed-in user.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select polname from pg_policy where polrelid = 'public.integrations'::regclass
  loop
    execute format('drop policy %I on public.integrations', policy_row.polname);
  end loop;

  for policy_row in
    select polname from pg_policy where polrelid = 'public.integration_sync_runs'::regclass
  loop
    execute format('drop policy %I on public.integration_sync_runs', policy_row.polname);
  end loop;
end
$$;

-- Grants are ADDITIVE in PostgreSQL: a later `grant` cannot take a privilege away.
-- Supabase's default for a table created in the dashboard is `grant all ... to
-- authenticated`, which includes TRUNCATE — and TRUNCATE is NOT governed by RLS, so any
-- signed-in user could wipe every user's rows. Revoke first, then grant back only what
-- the app needs.
revoke all on public.integrations          from anon, authenticated;
revoke all on public.integration_sync_runs from anon, authenticated;

grant select, insert, update, delete on public.integrations          to authenticated;
grant select, insert, update, delete on public.integration_sync_runs to authenticated;

-- (select auth.uid()) is the Supabase-recommended form: it is evaluated once per
-- statement instead of once per row.
create policy "integrations_select_own"
  on public.integrations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "integrations_insert_own"
  on public.integrations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "integrations_update_own"
  on public.integrations
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "integrations_delete_own"
  on public.integrations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "integration_sync_runs_select_own"
  on public.integration_sync_runs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- A sync run may only reference an integration owned by the SAME user. The subquery
-- runs under the caller's RLS on `integrations`, so it can only ever see the caller's
-- own connections.
create policy "integration_sync_runs_insert_own"
  on public.integration_sync_runs
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.integrations i
      where i.id = integration_sync_runs.integration_id
        and i.user_id = (select auth.uid())
    )
  );

create policy "integration_sync_runs_update_own"
  on public.integration_sync_runs
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.integrations i
      where i.id = integration_sync_runs.integration_id
        and i.user_id = (select auth.uid())
    )
  );

create policy "integration_sync_runs_delete_own"
  on public.integration_sync_runs
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 8. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app subscribes to row changes through supabase_realtime. Tables must be
-- explicitly added to the publication for realtime to work.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['integrations', 'integration_sync_runs']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run as the signed-in user, expected results in brackets)
-- ---------------------------------------------------------------------------
-- set_config('app.current_uid','<alice>');                        -- emulate auth.uid()
-- insert into public.integrations (provider, label)
--   values ('local_activity_file','Activity file');                [succeeds, user_id = alice]
-- insert into public.integrations (provider, label)
--   values ('local_activity_file','Second file');                 [23505: one connection per provider]
-- insert into public.integrations (user_id, provider)
--   values ('<bob>','local_activity_file');                       [42501: policy violation]
-- select * from public.integrations;                              [own rows only]
-- insert into public.integration_sync_runs (integration_id)
--   values ('<alice-integration>');                               [succeeds]
-- insert into public.integration_sync_runs (integration_id)
--   values ('<bob-integration>');                                 [42501: policy violation]
-- update public.integrations set status = 'connected'
--   where id = '<bob-integration>';                                [0 rows updated]
-- delete from public.integrations where id = '<bob-integration>';  [0 rows deleted]
-- insert into public.observations (id, occurred_at, integration_id)
--   values ('<client-uuid>', now(), '<bob-integration>');         [guard error]
-- delete from public.integrations where id = '<alice-integration>';
--                                                                  [sync runs + imported observations removed]
-- set role anon; select * from public.integrations;               [permission denied]
-- set role authenticated; truncate public.integrations;           [permission denied]

-- ==========================================================================
-- ===== 20261020120000_notifications_workflows_phase6.sql
-- ==========================================================================
-- Central Hub — Phase 6: notifications and workflow automation
-- Date: 2026-10-20
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- Context
--   Phase 6 (MASTER_SPEC Section 7E) introduces the notification and workflow domain:
--   "support task reminders, scheduled learning sessions, overdue items, review prompts
--   and important system failures" on top of "a reliable workflow foundation with
--   time-based and event-based triggers, explicit conditions and permitted actions,
--   persistent job scheduling, idempotency and duplicate prevention, retry policies
--   and execution history, cancellation and recovery after restart, quiet hours,
--   snoozing, and delivery preferences, and approval requirements for sensitive
--   actions".
--
--   This migration creates the PERSISTENCE layer only. It sends no message, talks to no
--   external service and schedules nothing by itself:
--
--     workflows                -> the DEFINITION: trigger, conditions, action, policy
--     workflow_runs            -> one row per execution attempt: what happened
--     notifications            -> the DELIVERY RECORD of a notification
--     notification_preferences -> quiet hours, channels and per-kind switches
--     approvals                -> a request for permission before a sensitive action
--
--   The scheduler itself is a separate process (scripts/worker.mjs). The schedule LIVES
--   in this database, so it survives an application restart, but nothing runs unless the
--   worker runs — that limitation is documented in docs/TECHNICAL.md and stated in the
--   UI, instead of being papered over.
--
-- Design rules honoured (MASTER_SPEC v2, Section 7E / 8)
--   - Every record is owned by exactly one user; ownership is enforced in the DATABASE
--     via RLS, never only in the frontend.
--   - `user_id` defaults to `auth.uid()` and is NOT NULL; an orphan guard FAILS LOUDLY
--     rather than committing a half-applied constraint.
--   - TRUTHFUL STATES ONLY. A notification distinguishes SCHEDULED (planned), SENT
--     (handed to a channel), DELIVERED (the channel confirmed it) and ACKNOWLEDGED (the
--     user acted on it) — the four states the spec asks to be told apart, each with its
--     own timestamp. A run distinguishes scheduled | running | succeeded | failed |
--     skipped | cancelled | awaiting_approval.
--   - IDEMPOTENCY IS ENFORCED BY THE DATABASE: `(user_id, idempotency_key)` is unique,
--     so the same scheduled occurrence can never be executed twice, no matter how many
--     workers or retries race for it.
--   - `anon` gets NOTHING and `authenticated` gets no TRUNCATE: `revoke all` runs
--     before the minimal grant, because grants are additive.
--   - Only the `in_app` channel exists. Email and push are NOT modelled as working:
--     the CHECK constraint refuses any other channel, so a row can never claim a
--     delivery that no channel can perform.
--
-- ADDITIVE ONLY: no existing table is dropped, altered or emptied. The Phase 1-5 tables
-- are untouched.
--
-- Delete semantics
--   delete from public.workflows where id = '<workflow>';
--     -> the workflow, its runs and its approvals are removed (ON DELETE CASCADE),
--     -> the notifications it produced are KEPT (ON DELETE SET NULL): a delivered
--        message is a record of what the user was told, and it must not vanish with
--        the rule that produced it.
--
-- Rollback
--   drop table if exists public.approvals, public.notifications,
--     public.notification_preferences, public.workflow_runs, public.workflows;
--
-- Idempotent: safe to apply repeatedly (`create table if not exists`,
-- `add constraint if not exists` guards, policy-drop loop, `revoke ... grant` ordered
-- correctly, guarded trigger/publication membership).

begin;

-- ---------------------------------------------------------------------------
-- 1. workflows — the definition of a scheduled workflow
-- ---------------------------------------------------------------------------
create table if not exists public.workflows (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                  text not null,
  description           text,
  trigger_type          text not null default 'schedule',    -- schedule | event
  trigger_config        jsonb not null default '{}'::jsonb,   -- {kind:'daily', at:'09:00', timezone, weekdays, everyMinutes}
  conditions            jsonb not null default '[]'::jsonb,   -- [{type:'task_overdue'}]
  action_type           text not null default 'create_notification',
  action_config         jsonb not null default '{}'::jsonb,   -- {kind, title, body}
  channel               text not null default 'in_app',       -- the ONLY implemented channel
  enabled               boolean not null default true,
  requires_approval     boolean not null default false,       -- the action waits for the user
  max_attempts          integer not null default 3,
  retry_backoff_seconds integer not null default 60,
  next_run_at           timestamptz,                           -- next planned occurrence (UTC)
  event_cursor          timestamptz,                           -- last event already processed (UTC)
  last_run_at           timestamptz,                           -- last STARTED run (UTC)
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint workflows_trigger_type_valid
    check (trigger_type in ('schedule','event')),
  constraint workflows_action_type_valid
    check (action_type in ('create_notification')),
  constraint workflows_channel_valid
    check (channel in ('in_app')),
  constraint workflows_max_attempts_valid
    check (max_attempts > 0),
  constraint workflows_backoff_valid
    check (retry_backoff_seconds >= 0)
);

comment on table public.workflows is
  'A scheduled workflow: when it runs (trigger), what must be true (conditions), what it
   does (action) and how it behaves (retries, approval). The row is the definition — the
   executions live in workflow_runs and the messages in notifications.';
comment on column public.workflows.user_id is
  'Owner. Defaults to auth.uid(); the client cannot forge another owner.';
comment on column public.workflows.trigger_type is
  'schedule | event. A time-based trigger is executed by the worker; an event trigger is
   NOT implemented yet, and the engine refuses it with a reason instead of ignoring it.';
comment on column public.workflows.trigger_config is
  'The trigger definition: {kind:''daily''|''weekly''|''interval'', at:''HH:MM'',
   timezone:''Europe/Berlin'', weekdays:[0..6], everyMinutes:15}. Times are wall-clock
   times in the given timezone; the stored run times are UTC.';
comment on column public.workflows.conditions is
  'A list of conditions that must ALL hold for the workflow to act. An unknown condition
   type never matches — it is reported, not silently ignored.';
comment on column public.workflows.channel is
  'The delivery channel. Only ''in_app'' exists: a row cannot claim a delivery that no
   channel can perform.';
comment on column public.workflows.requires_approval is
  'When true, the run stops at ''awaiting_approval'' and an approval row is created.
   The action is only performed after the user approves it.';
comment on column public.workflows.next_run_at is
  'The next planned occurrence, in UTC. NULL means "no occurrence planned".';
comment on column public.workflows.event_cursor is
  'The watermark of the last EVENT already processed, in UTC. An event-triggered
   workflow reads the events after this cursor; NULL means "everything so far". The
   cursor is an efficiency aid — the idempotency key of a run is what actually
   prevents a repeated execution.';

-- ---------------------------------------------------------------------------
-- 2. workflow_runs — one row per execution attempt
-- ---------------------------------------------------------------------------
create table if not exists public.workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workflow_id     uuid not null references public.workflows(id) on delete cascade,
  idempotency_key text not null,
  status          text not null default 'scheduled',
  attempt         integer not null default 1,
  scheduled_for   timestamptz not null,
  next_attempt_at timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  result          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint workflow_runs_status_valid
    check (status in ('scheduled','running','succeeded','failed','skipped','cancelled','awaiting_approval')),
  constraint workflow_runs_attempt_valid
    check (attempt >= 1),
  constraint workflow_runs_time_order
    check (finished_at is null or finished_at >= started_at or started_at is null),
  constraint workflow_runs_idempotency_unique
    unique (user_id, idempotency_key)
);

comment on table public.workflow_runs is
  'One execution attempt of one workflow — the execution history the spec asks for. A run
   is opened with ''scheduled'', executed (''running'') and closed with a truthful outcome
   (succeeded | failed | skipped | cancelled | awaiting_approval).';
comment on column public.workflow_runs.idempotency_key is
  'The duplicate-prevention key: the workflow id and the scheduled occurrence. The
   (user_id, idempotency_key) unique constraint means the same occurrence can be
   executed only once, however many workers or retries race for it.';
comment on column public.workflow_runs.status is
  'scheduled | running | succeeded | failed | skipped | cancelled | awaiting_approval.';
comment on column public.workflow_runs.result is
  'What the execution observed: the evaluated conditions and the identifiers of the rows
   it wrote. It never contains invented data — only what the run actually did.';

-- ---------------------------------------------------------------------------
-- 3. notifications — the delivery record
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workflow_id     uuid references public.workflows(id) on delete set null,
  run_id          uuid references public.workflow_runs(id) on delete set null,
  channel         text not null default 'in_app',
  kind            text not null,
  title           text not null,
  body            text,
  status          text not null default 'scheduled',
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  acknowledged_at timestamptz,
  snoozed_until   timestamptz,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint notifications_channel_valid
    check (channel in ('in_app')),
  constraint notifications_status_valid
    check (status in ('scheduled','sent','delivered','acknowledged','failed','cancelled'))
);

comment on table public.notifications is
  'A notification the user was (or will be) told about. The four states are DISTINCT
   and each has its own timestamp: scheduled (planned) | sent (handed to the channel) |
   delivered (the channel confirmed it) | acknowledged (the user acted on it). A missing
   timestamp means that step did not happen — it is never back-filled with a guess.';
comment on column public.notifications.workflow_id is
  'The workflow that produced it. ON DELETE SET NULL: deleting the rule keeps the
   message, because a delivered message is a record of what the user was told.';
comment on column public.notifications.snoozed_until is
  'Set while the notification is snoozed. The row stays; the snooze is visible, not
   hidden.';
comment on column public.notifications.payload is
  'The data the notification was built from (e.g. the tasks that were overdue). It
   contains what was actually observed — never a generated or inferred record.';

-- ---------------------------------------------------------------------------
-- 4. notification_preferences — quiet hours, channels, per-kind switches
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  timezone           text not null default 'UTC',
  quiet_hours_start  text,                     -- 'HH:MM' local, NULL = no quiet hours
  quiet_hours_end    text,
  channels           jsonb not null default '{"in_app":true}'::jsonb,
  kinds              jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.notification_preferences is
  'One row per user: the delivery preferences. quiet_hours_start/end are local
   ''HH:MM'' times; a window whose start is later than its end crosses midnight. The row
   is created by the app on first use, so a missing row means "no preferences saved",
   never "zero".';

-- ---------------------------------------------------------------------------
-- 5. approvals — permission before a sensitive action
-- ---------------------------------------------------------------------------
create table if not exists public.approvals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workflow_id uuid references public.workflows(id) on delete cascade,
  run_id      uuid references public.workflow_runs(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending',
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint approvals_status_valid
    check (status in ('pending','approved','rejected','expired'))
);

comment on table public.approvals is
  'A request for permission before a workflow performs a sensitive action. The action
   waits in ''awaiting_approval'' until the user approves it; a rejection cancels the
   run. The approval is a separate record, so the history survives the decision.';

-- ---------------------------------------------------------------------------
-- 6. Ownership enforcement (fail loudly on orphan rows)
-- ---------------------------------------------------------------------------
alter table public.workflows                alter column user_id set default auth.uid();
alter table public.workflow_runs            alter column user_id set default auth.uid();
alter table public.notifications            alter column user_id set default auth.uid();
alter table public.approvals                alter column user_id set default auth.uid();

do $$
declare
  orphan_count integer;
begin
  foreach orphan_count in array array[
    (select count(*) from public.workflows     where user_id is null),
    (select count(*) from public.workflow_runs where user_id is null),
    (select count(*) from public.notifications where user_id is null),
    (select count(*) from public.approvals     where user_id is null)
  ] loop
    if orphan_count > 0 then
      raise exception
        'Phase 6 workflow tables have % row(s) with NULL user_id. Reassign them to a '
        'real owner or delete them, then re-run this migration.', orphan_count;
    end if;
  end loop;

  alter table public.workflows     alter column user_id set not null;
  alter table public.workflow_runs alter column user_id set not null;
  alter table public.notifications alter column user_id set not null;
  alter table public.approvals     alter column user_id set not null;
  raise notice 'phase 6 user_id columns set NOT NULL';
end
$$;

-- ---------------------------------------------------------------------------
-- 7. updated_at triggers
-- ---------------------------------------------------------------------------
do $$
begin
  create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  as $body$
  begin
    new.updated_at = now();
    return new;
  end;
  $body$;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'workflows_set_updated_at'
      and tgrelid = 'public.workflows'::regclass
  ) then
    create trigger workflows_set_updated_at
      before update on public.workflows
      for each row
      execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'workflow_runs_set_updated_at'
      and tgrelid = 'public.workflow_runs'::regclass
  ) then
    create trigger workflow_runs_set_updated_at
      before update on public.workflow_runs
      for each row
      execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'notifications_set_updated_at'
      and tgrelid = 'public.notifications'::regclass
  ) then
    create trigger notifications_set_updated_at
      before update on public.notifications
      for each row
      execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'notification_preferences_set_updated_at'
      and tgrelid = 'public.notification_preferences'::regclass
  ) then
    create trigger notification_preferences_set_updated_at
      before update on public.notification_preferences
      for each row
      execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'approvals_set_updated_at'
      and tgrelid = 'public.approvals'::regclass
  ) then
    create trigger approvals_set_updated_at
      before update on public.approvals
      for each row
      execute function public.set_updated_at();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Indexes (bounded reads are ordered by time)
-- ---------------------------------------------------------------------------
create index if not exists workflows_user_id_idx
  on public.workflows (user_id);
create index if not exists workflows_user_next_run_at_idx
  on public.workflows (user_id, next_run_at);
create index if not exists workflow_runs_user_created_at_idx
  on public.workflow_runs (user_id, created_at desc);
create index if not exists workflow_runs_workflow_id_idx
  on public.workflow_runs (workflow_id);
create index if not exists notifications_user_created_at_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_status_idx
  on public.notifications (user_id, status);
create index if not exists approvals_user_created_at_idx
  on public.approvals (user_id, created_at desc);

-- The event trigger reads the tasks that were completed after the workflow's cursor.
-- The index is created ONLY when `public.tasks` exists, so this migration keeps
-- working on its own (it has no hard dependency on the Phase 3 migration).
do $$
begin
  if to_regclass('public.tasks') is not null then
    create index if not exists tasks_user_completed_at_idx
      on public.tasks (user_id, completed_at);
  else
    raise notice
      'public.tasks does not exist yet: the event-trigger index was skipped. Apply '
      'supabase/migrations/20261020091000_tasks_phase3.sql and re-run this migration.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Row Level Security — explicit per-owner policies
-- ---------------------------------------------------------------------------
alter table public.workflows                enable row level security;
alter table public.workflow_runs            enable row level security;
alter table public.notifications            enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.approvals                enable row level security;

-- Remove EVERY existing policy before creating the intended set. PostgreSQL ORs
-- permissive policies together, so a leftover policy with an unknown name (for example
-- `with check (true)`) would silently widen access for every signed-in user.
do $$
declare
  policy_row record;
  table_name text;
begin
  foreach table_name in array array[
    'workflows', 'workflow_runs', 'notifications',
    'notification_preferences', 'approvals'
  ] loop
    for policy_row in
      select polname from pg_policy
      where polrelid = format('public.%I', table_name)::regclass
    loop
      execute format('drop policy %I on public.%I', policy_row.polname, table_name);
    end loop;
  end loop;
end
$$;

-- Grants are ADDITIVE in PostgreSQL: a later `grant` cannot take a privilege away, and
-- TRUNCATE is NOT governed by RLS. Revoke first, then grant back only what the app needs.
revoke all on public.workflows                from anon, authenticated;
revoke all on public.workflow_runs            from anon, authenticated;
revoke all on public.notifications            from anon, authenticated;
revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.approvals                from anon, authenticated;

grant select, insert, update, delete on public.workflows                to authenticated;
grant select, insert, update, delete on public.workflow_runs            to authenticated;
grant select, insert, update, delete on public.notifications            to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.approvals                to authenticated;

-- (select auth.uid()) is the Supabase-recommended form: it is evaluated once per
-- statement instead of once per row.
create policy "workflows_select_own"
  on public.workflows
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "workflows_insert_own"
  on public.workflows
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "workflows_update_own"
  on public.workflows
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "workflows_delete_own"
  on public.workflows
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- A run may only reference a workflow owned by the SAME user. The subquery runs under
-- the caller's RLS on `workflows`, so it can only ever see the caller's own workflows.
create policy "workflow_runs_select_own"
  on public.workflow_runs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "workflow_runs_insert_own"
  on public.workflow_runs
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.workflows w
      where w.id = workflow_runs.workflow_id
        and w.user_id = (select auth.uid())
    )
  );

create policy "workflow_runs_update_own"
  on public.workflow_runs
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.workflows w
      where w.id = workflow_runs.workflow_id
        and w.user_id = (select auth.uid())
    )
  );

create policy "workflow_runs_delete_own"
  on public.workflow_runs
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "notifications_select_own"
  on public.notifications
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "notifications_insert_own"
  on public.notifications
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      workflow_id is null
      or exists (
        select 1 from public.workflows w
        where w.id = notifications.workflow_id
          and w.user_id = (select auth.uid())
      )
    )
    and (
      run_id is null
      or exists (
        select 1 from public.workflow_runs r
        where r.id = notifications.run_id
          and r.user_id = (select auth.uid())
      )
    )
  );

create policy "notifications_update_own"
  on public.notifications
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "notifications_delete_own"
  on public.notifications
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "notification_preferences_select_own"
  on public.notification_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "notification_preferences_insert_own"
  on public.notification_preferences
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "notification_preferences_update_own"
  on public.notification_preferences
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "notification_preferences_delete_own"
  on public.notification_preferences
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "approvals_select_own"
  on public.approvals
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "approvals_insert_own"
  on public.approvals
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      workflow_id is null
      or exists (
        select 1 from public.workflows w
        where w.id = approvals.workflow_id
          and w.user_id = (select auth.uid())
      )
    )
    and (
      run_id is null
      or exists (
        select 1 from public.workflow_runs r
        where r.id = approvals.run_id
          and r.user_id = (select auth.uid())
      )
    )
  );

create policy "approvals_update_own"
  on public.approvals
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "approvals_delete_own"
  on public.approvals
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 10. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app subscribes to row changes through supabase_realtime. Tables must be explicitly
-- added to the publication for realtime to work.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'workflows', 'workflow_runs', 'notifications', 'approvals'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run as the signed-in user, expected results in brackets)
-- ---------------------------------------------------------------------------
-- set_config('app.current_uid','<alice>');                        -- emulate auth.uid()
-- insert into public.workflows (name, trigger_config)
--   values ('Overdue check', '{"kind":"daily","at":"09:00"}');   [succeeds, user_id = alice]
-- insert into public.workflows (user_id, name)
--   values ('<bob>','Forged');                                   [42501: policy violation]
-- insert into public.workflows (name, channel) values ('x','email');
--                                                                  [23514: only in_app exists]
-- insert into public.workflow_runs (workflow_id, idempotency_key, scheduled_for)
--   values ('<alice-workflow>','k1', now());                     [succeeds]
-- insert into public.workflow_runs (workflow_id, idempotency_key, scheduled_for)
--   values ('<alice-workflow>','k1', now());                     [23505: duplicate prevented]
-- insert into public.workflow_runs (workflow_id, idempotency_key, scheduled_for)
--   values ('<bob-workflow>','k2', now());                       [42501: policy violation]
-- select * from public.notifications;                            [own rows only]
-- delete from public.workflows where id = '<alice-workflow>';
--   -> the runs and approvals are removed; the notifications survive
--      (workflow_id becomes NULL).
-- set role anon; select * from public.workflows;                 [permission denied]
-- set role authenticated; truncate public.notifications;         [permission denied]

-- ==========================================================================
-- ===== 20261020130000_ai_phase7.sql
-- ==========================================================================
-- Central Hub — Phase 7: AI assistance and evidence-based reviews.
-- Date: 2026-08-21
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- Context
--   Phase 7 (MASTER_SPEC Section 7G) adds OPTIONAL AI assistance on top of the
--   Phase 2-6 data. The spec is explicit about the shape of that feature:
--
--     - "the app MUST fully work with AI disabled or unconfigured";
--     - "AI must not invent records, silently change important task states,
--       bypass permissions, or execute consequential actions without the
--       required approval";
--     - "Every AI-generated action must be traceable (inputs, model, output,
--       approval), reviewable, reversible where possible, and subject to the
--       same authorization rules as ordinary application actions. Minimize and
--       disclose what user data is sent to any external AI provider."
--
--   This migration creates the PERSISTENCE layer for that. It creates no model
--   call and sends nothing anywhere: the provider is chosen at runtime, and the
--   on-device provider never leaves the browser.
--
--     ai_runs            -> one row per analysis: what was asked, which model
--                            answered, what came back, and whether it succeeded.
--                            This is the TRACEABILITY record the spec requires.
--     ai_classification_proposals
--                         -> a proposed task for an activity. A proposal is
--                            NEVER applied on its own: it starts 'pending' and
--                            only becomes 'approved' when the user decides.
--                            This is the REVIEW step, and it is what keeps the
--                            AI from silently changing task state.
--     ai_preferences     -> one row per user: which provider to use, and
--                            whether window titles may be included in an
--                            analysis. Window titles are opt-in, so the
--                            default is false.
--
-- Design rules honoured (MASTER_SPEC v2, Section 7G / 8)
--   - Every record is owned by exactly one user; ownership is enforced in the
--     DATABASE (RLS), not in the client.
--   - A missing value stays NULL. It is never 0: "no answer" and "answer 0"
--     are different facts.
--   - A confidence is a number in 0..1; the CHECK constraint refuses anything
--     else, so a proposal can never claim to be more certain than certainty.
--   - The digest of the sent evidence is stored, so a run can PROVE what was
--     sent without keeping a second copy of it.
--
-- ADDITIVE ONLY: no existing table is dropped, altered or emptied. The Phase 2-6
-- tables are untouched.
--
-- Delete semantics
--   delete from public.ai_runs where id = '<run>';
--   delete from public.ai_classification_proposals where id = '<proposal>';
--   delete from public.ai_preferences where user_id = auth.uid();
--   Deleting a user removes all three: the last two cascade from
--   auth.users, and ai_runs cascade from ai_preferences' owner.

begin;

-- ---------------------------------------------------------------------------
-- 1. ai_runs — the traceability record
-- ---------------------------------------------------------------------------
create table if not exists public.ai_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind          text not null,                 -- the capability that was requested
  provider      text not null,                 -- 'local' | 'xai'
  model         text not null,                 -- the model that answered
  status        text not null default 'running',
  input_digest  text not null,                 -- identifies the evidence package that was sent
  input         jsonb,                         -- the evidence package, as sent
  output        jsonb,                         -- the validated answer
  error         text,                          -- why the run failed, when it did
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint ai_runs_kind_valid
    check (kind in ('day_summary','classify_activity','priorities','ask')),
  constraint ai_runs_status_valid
    check (status in ('running','success','error')),
  constraint ai_runs_user_id_not_null check (user_id is not null)
);

comment on table public.ai_runs is
  'One row per AI analysis: the capability requested, the provider and model that answered, a digest of the evidence that was sent, and the answer itself. This is the traceability record MASTER_SPEC 7G requires.';
comment on column public.ai_runs.input_digest is
  'A stable digest of the exact evidence package that was sent. It identifies the input without keeping a second copy of it.';
comment on column public.ai_runs.input is
  'The evidence package as it was sent. Null when the run failed before the package was built, or when the user has not asked for it to be kept.';

-- A database that already has the Phase 7 table keeps the original check.
-- Dropping and re-adding it is what lets a question ('ask') be recorded.
alter table public.ai_runs drop constraint if exists ai_runs_kind_valid;
alter table public.ai_runs
  add constraint ai_runs_kind_valid
  check (kind in ('day_summary','classify_activity','priorities','ask'));

-- ---------------------------------------------------------------------------
-- 2. ai_classification_proposals — the review step
-- ---------------------------------------------------------------------------
create table if not exists public.ai_classification_proposals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id          uuid references public.ai_runs(id) on delete set null,
  observation_id  uuid not null references public.observations(id) on delete cascade,
  proposed_task_id uuid references public.tasks(id) on delete set null,
  proposed_label  text,
  confidence      numeric not null,
  reason          text,
  status          text not null default 'pending',
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint ai_classification_proposals_confidence_valid
    check (confidence >= 0 and confidence <= 1),
  constraint ai_classification_proposals_status_valid
    check (status in ('pending','approved','rejected')),
  constraint ai_classification_proposals_decided_valid
    check (
      (status = 'pending' and decided_at is null)
      or (status in ('approved','rejected') and decided_at is not null)
    )
);

comment on table public.ai_classification_proposals is
  'A proposed task for an activity. A proposal is never applied on its own: it starts as pending and only becomes approved when the user decides, which is what keeps an AI from silently changing task state.';
comment on column public.ai_classification_proposals.observation_id is
  'The activity this proposal is about. Deleting the activity deletes the proposal.';

-- ---------------------------------------------------------------------------
-- 3. ai_preferences — one row per user
-- ---------------------------------------------------------------------------
create table if not exists public.ai_preferences (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  provider               text not null default 'local',
  include_window_titles  boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint ai_preferences_provider_valid check (provider in ('local','xai'))
);

comment on table public.ai_preferences is
  'One row per user: which provider answers their analyses, and whether window titles may be included. Window titles are opt-in, so the default is false.';
comment on column public.ai_preferences.include_window_titles is
  'Whether window titles may be included in an analysis sent to an external provider. False by default: a window title is the content of a screen, and the spec treats it as opt-in data.';

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
create index if not exists ai_runs_owner_created_idx
  on public.ai_runs (user_id, created_at desc);

create index if not exists ai_classification_proposals_owner_status_idx
  on public.ai_classification_proposals (user_id, status);

create index if not exists ai_classification_proposals_observation_idx
  on public.ai_classification_proposals (observation_id);

-- ---------------------------------------------------------------------------
-- 5. updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_ai_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ai_preferences_set_updated_at on public.ai_preferences;
create trigger ai_preferences_set_updated_at
  before update on public.ai_preferences
  for each row
  execute function public.set_ai_preferences_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------------
alter table public.ai_runs                      enable row level security;
alter table public.ai_classification_proposals enable row level security;
alter table public.ai_preferences               enable row level security;

-- Remove EVERY existing policy before creating the intended set. PostgreSQL ORs
-- permissive policies together, so a leftover policy with an unknown name (for
-- example `with check (true)`) would silently widen access for every signed-in
-- user.
do $$
declare
  policy_row record;
  table_name text;
begin
  foreach table_name in array array[
    'ai_runs', 'ai_classification_proposals', 'ai_preferences'
  ] loop
    for policy_row in
      select polname from pg_policy
      where polrelid = format('public.%I', table_name)::regclass
    loop
      execute format('drop policy if exists %I on public.%I', policy_row.polname, table_name);
    end loop;
  end loop;
end
$$;

-- (select auth.uid()) is the Supabase-recommended form: it is evaluated once per
-- statement instead of once per row.
create policy "ai_runs_select_own"
  on public.ai_runs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "ai_runs_insert_own"
  on public.ai_runs
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "ai_runs_update_own"
  on public.ai_runs
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "ai_runs_delete_own"
  on public.ai_runs
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "ai_classification_proposals_select_own"
  on public.ai_classification_proposals
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "ai_classification_proposals_insert_own"
  on public.ai_classification_proposals
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "ai_classification_proposals_update_own"
  on public.ai_classification_proposals
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "ai_classification_proposals_delete_own"
  on public.ai_classification_proposals
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "ai_preferences_select_own"
  on public.ai_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "ai_preferences_insert_own"
  on public.ai_preferences
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "ai_preferences_update_own"
  on public.ai_preferences
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "ai_preferences_delete_own"
  on public.ai_preferences
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
-- `anon` gets NOTHING and `authenticated` gets no TRUNCATE: `revoke all` runs
-- before the minimal grant, because grants are additive.
revoke all on public.ai_runs                      from anon, authenticated;
revoke all on public.ai_classification_proposals from anon, authenticated;
revoke all on public.ai_preferences               from anon, authenticated;

grant select, insert, update, delete on public.ai_runs                      to authenticated;
grant select, insert, update, delete on public.ai_classification_proposals to authenticated;
grant select, insert, update, delete on public.ai_preferences               to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Realtime publication membership
-- ---------------------------------------------------------------------------
-- The app reads the proposals through a realtime channel, so the tables have to
-- be members of the publication. Tables must be added explicitly.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_runs'
  ) then
    alter publication supabase_realtime add table public.ai_runs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_classification_proposals'
  ) then
    alter publication supabase_realtime add table public.ai_classification_proposals;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_preferences'
  ) then
    alter publication supabase_realtime add table public.ai_preferences;
  end if;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run as the signed-in user, expected results in brackets)
--
--   select count(*) from public.ai_runs;                                   -- [0]
--   select count(*) from public.ai_classification_proposals;                -- [0]
--   select count(*) from public.ai_preferences;                             -- [0]
--   insert into public.ai_preferences (user_id) values (auth.uid())
--     returning provider, include_window_titles;                            -- [local, false]
--   insert into public.ai_runs (kind, provider, model, input_digest)
--     values ('day_summary','local','on-device-rules','x');                -- [ok]
--   insert into public.ai_runs (kind, provider, model, input_digest)
--     values ('not_a_kind','local','on-device-rules','x');                  -- [check violation]
--   insert into public.ai_classification_proposals
--     (observation_id, confidence) values (gen_random_uuid(), 1.4);         -- [check violation]
--   -- as another user, the rows above are invisible
--   set role anon; select count(*) from public.ai_runs;                     -- [permission denied]


-- ==========================================================================
-- ===== 20261022140000_coding_activity.sql
-- ==========================================================================
-- Central Hub — coding activity from Cursor and VS Code
-- Date: 2026-10-22
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- The coding tracker writes heartbeats as observations. These columns describe
-- a heartbeat without putting a file path or a window title on the row:
--
--   activity_kind  'coding' for this collector. NULL on every older observation.
--                  Later activity sources add a value here with a new migration;
--                  this check lists only the kind that exists.
--   editor         'cursor' or 'vscode'. NULL when the row is not from an editor.
--   project_name   the workspace folder's name, never a path.
--   language       the editor language id, e.g. 'javascript'.
--   file_name      the file's name, never a path.
--
-- Heartbeats stay observations (source = 'collector'). They are NOT copied into
-- sessions. Sessions are the attributed work stream; coding time is observed
-- editor activity. The timeline groups heartbeats in the app. Putting both in
-- one total would count the same hour twice when a person also logs a session.
--
-- Requires public.observations (Phase 4). Idempotent.
--
-- Rollback:
--   drop index if exists public.observations_user_coding_occurred_idx;
--   alter table public.observations drop constraint if exists observations_language_label;
--   alter table public.observations drop constraint if exists observations_project_name_label;
--   alter table public.observations drop constraint if exists observations_file_name_basename;
--   alter table public.observations drop constraint if exists observations_editor_valid;
--   alter table public.observations drop constraint if exists observations_activity_kind_valid;
--   alter table public.observations
--     drop column if exists file_name,
--     drop column if exists language,
--     drop column if exists project_name,
--     drop column if exists editor,
--     drop column if exists activity_kind;

begin;

do $$
begin
  if to_regclass('public.observations') is null then
    raise exception
      'public.observations does not exist. Apply supabase/migrations/20261020100000_time_tracking_phase4.sql before this migration.';
  end if;
end
$$;

alter table public.observations add column if not exists activity_kind text;
alter table public.observations add column if not exists editor text;
alter table public.observations add column if not exists project_name text;
alter table public.observations add column if not exists language text;
alter table public.observations add column if not exists file_name text;

alter table public.observations drop constraint if exists observations_activity_kind_valid;
alter table public.observations
  add constraint observations_activity_kind_valid
  check (activity_kind is null or activity_kind in ('coding'));

alter table public.observations drop constraint if exists observations_editor_valid;
alter table public.observations
  add constraint observations_editor_valid
  check (editor is null or editor in ('cursor', 'vscode'));

alter table public.observations drop constraint if exists observations_file_name_basename;
alter table public.observations
  add constraint observations_file_name_basename
  check (
    file_name is null
    or (
      char_length(file_name) between 1 and 255
      and file_name !~ '[\\/]'
      and position('..' in file_name) = 0
    )
  );

alter table public.observations drop constraint if exists observations_project_name_label;
alter table public.observations
  add constraint observations_project_name_label
  check (
    project_name is null
    or (
      char_length(project_name) between 1 and 255
      and project_name !~ '[\\/]'
      and position('..' in project_name) = 0
    )
  );

alter table public.observations drop constraint if exists observations_language_label;
alter table public.observations
  add constraint observations_language_label
  check (
    language is null
    or (
      char_length(language) between 1 and 64
      and language !~ '[\\/]'
    )
  );

create index if not exists observations_user_coding_occurred_idx
  on public.observations (user_id, occurred_at desc)
  where activity_kind = 'coding';

comment on column public.observations.activity_kind is
  'Which activity stream produced the row. NULL means an observation from before coding tracking, or a row that is not coding. ''coding'' is a Cursor/VS Code heartbeat. Missing is NULL, never a fake kind.';
comment on column public.observations.editor is
  'cursor or vscode when activity_kind = coding. NULL on every other observation.';
comment on column public.observations.project_name is
  'Workspace folder name only. Full paths are not stored.';
comment on column public.observations.file_name is
  'File name only. Full paths are not stored.';
comment on column public.observations.language is
  'Editor language id, such as javascript. Not a file path.';

commit;

-- ---------------------------------------------------------------------------
-- Reload PostgREST's schema cache.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
