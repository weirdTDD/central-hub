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
