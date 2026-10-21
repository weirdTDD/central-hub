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
