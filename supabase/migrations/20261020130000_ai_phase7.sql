-- Sentral Hub — Phase 7: AI assistance and evidence-based reviews.
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
    check (kind in ('day_summary','classify_activity','priorities')),
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
  user_id                uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  provider               text not null default 'local',
  include_window_titles  boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint ai_preferences_provider_valid check (provider in ('local','xai'))
);

-- The primary key takes its value from the session, so a row can be written
-- without the client naming the user — and the RLS policy below still decides
-- whose row it is. Stated separately so the default is present even when the
-- table already existed.
alter table public.ai_preferences
  alter column user_id set default auth.uid();

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
