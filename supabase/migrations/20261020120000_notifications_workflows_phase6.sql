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
