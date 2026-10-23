-- Sentral Hub — Phase 5: integrations (connections, sync runs, observation provenance)
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
