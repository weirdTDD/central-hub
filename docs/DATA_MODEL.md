# Central Hub — Data Model

Entities, ownership, relationships, and delete behavior. Conceptual; tables introduced as phases ship.

## Identity / accounts

- **users** — id (uuid, PK), email (citext, unique), password_hash, created_at, updated_at. Owned by the account holder. Delete: cascade user-owned records or anonymize per retention policy.

## Goals, projects, tasks

- **goals** — id, user_id (FK→users), title, description, target_date, status, created_at, updated_at. Owner: user. Delete: restrict if tasks reference; or soft-delete. *Planned.*
- **projects** — id, user_id (FK→users), goal_id (FK→goals, nullable), title, description, status, created_at, updated_at. Owner: user. Delete: restrict if tasks reference. *Planned.*
- **tasks** — live (Phase 3). See `### tasks (live, Phase 3)` below. `project_id`/`goal_id` link columns are deferred to the goals/projects increment; until then tasks are self-contained (ownable, state-machinable records).

## Time and activity tracking

### work_logs (live, Phase 2)

Verified against the live Supabase project and against PostgreSQL 18 locally.

```sql
create table public.work_logs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id),
  title            text,
  notes            text,
  created_at       timestamptz not null default now(),  -- ingestion time
  log_date         date,                                  -- occurrence time
  duration_seconds integer,                               -- canonical duration unit
  display_name     text,                                  -- display label only
  updated_at       timestamptz not null default now(),
  constraint work_logs_duration_seconds_non_negative
    check (duration_seconds is null or duration_seconds >= 0)
);
```

- **Ownership:** `user_id` defaults to `auth.uid()`; the client cannot forge an owner.
- **Duration:** stored only as integer seconds. `duration_seconds IS NULL` means "not
  recorded" — never 0.
- **Time:** `log_date` (occurrence) is stored separately from `created_at` (ingestion),
  so late or out-of-order records are representable.
- **Delete:** hard delete, scoped to the owner by RLS.
- **RLS policies** (`public.work_logs`): `work_logs_select_own`,
  `work_logs_insert_own`, `work_logs_update_own`, `work_logs_delete_own` — all
  `to authenticated` using `(select auth.uid()) = user_id`. The `anon` role has no
  grants on the table at all.
- **Migration:** `supabase/migrations/20261020090000_work_logs_phase2.sql` (idempotent;
  applies cleanly three times in a row).

### tasks (live, Phase 3)

```sql
create table public.tasks (
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
  constraint tasks_status_valid  check (status in (...)),
  constraint tasks_priority_valid check (priority in (...)),
  constraint tasks_duration_non_negative check (estimated_duration_seconds is null or >= 0),
  constraint tasks_completed_at_matches_status
    check ((status = 'completed') = (completed_at is not null))
);
```

- **Ownership:** `user_id` defaults to `auth.uid()`, NOT NULL + orphan guard (fails loudly).
- **State machine:** `todo → in_progress → in_review/completed/blocked`; `in_review → completed/in_progress/blocked`; `blocked → in_progress/cancelled`; `completed → todo` (reopen); `cancelled → todo`. Valid values enforced by the DB `CHECK`; allowed transitions validated client-side in `TasksContext.transitionTask`.
- **completed_at:** set in the context to the completion time when `status` → `completed`; cleared (`NULL`) when reopened. The database enforces the pairing (`tasks_completed_at_matches_status`), so a client-side write cannot leave a completed task without a completion time.
- **Duration:** `estimated_duration_seconds` is integer seconds (same canonical unit as work logs). `NULL` means "not estimated" — never `0`.
- **Time:** `due_date` is a user-local day, stored as a `date`.
- **Delete:** hard delete, scoped to the owner by RLS. (Sessions/outcomes are not yet created, so no cascade concerns.)
- **RLS policies** (`public.tasks`): `tasks_select_own`, `tasks_insert_own`, `tasks_update_own`, `tasks_delete_own` — all `to authenticated` using `(select auth.uid()) = user_id`. The `anon` role has no grants. `authenticated` is NOT the table owner, so `TRUNCATE` is refused (`42501`).
- **Migration:** `supabase/migrations/20261020091000_tasks_phase3.sql` (idempotent; verified locally against PostgreSQL 16).

> Note: `goals` and `projects` tables are still **planned**; tasks were built self-contained (no FK columns yet) so this increment is bounded. Project/goal linkage lands in a follow-up increment.

### Phase 4 time tracking — IMPLEMENTED AND LOCALLY VERIFIED (not applied to live)

Status: implemented on 2026-10-20 in `supabase/migrations/20261020100000_time_tracking_phase4.sql`
and verified against PostgreSQL 16 (Docker) with a 31-check security/ownership/integrity
suite plus a 5-check `anon` suite; the domain rules are covered by 30 Node assertions in
`scripts/verify-tracking.mjs`. The migration is **not** applied to the live Supabase
project (no admin credentials in this environment) and **no UI consumes the tables yet**
(Phase 4B). The SQL below is the implemented shape.

#### observations (designed)

Raw events. One row per observed thing that happened — not an interval of work.

```sql
create table public.observations (
  id               uuid primary key,                    -- CLIENT-GENERATED idempotency key
  user_id          uuid not null default auth.uid() references auth.users(id),
  source           text not null default 'manual',
  occurred_at      timestamptz not null,                -- occurrence time (UTC)
  ingested_at      timestamptz not null default now(),  -- ingestion time
  duration_seconds integer,                             -- span this observation covers; NULL = point event
  application      text,                                -- minimal metadata (app name)
  window_title     text,                                -- only when the user opts in
  is_idle          boolean not null default false,
  constraint observations_source_valid
    check (source in ('manual','collector','import')),
  constraint observations_duration_non_negative
    check (duration_seconds is null or duration_seconds >= 0)
);
```

- **Ownership:** `user_id` defaults to `auth.uid()`; a client cannot forge an owner.
- **Idempotency:** the primary key is generated by the client, so re-sending the same
  observation is a no-op (`on conflict (id) do nothing`). A repeated insert never creates
  a second row and never mutates the first.
- **Time:** `occurred_at` (UTC, when it happened) is separate from `ingested_at` (when it
  arrived), so late and out-of-order events are representable.
- **Duration:** integer seconds, `NULL` = instantaneous point event — never `0`.
- **Delete:** hard delete, scoped to the owner by RLS.

#### sessions (designed)

A time interval derived from observations, or created by hand. This is the record that
carries attribution and the canonical duration.

```sql
create table public.sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id),
  started_at            timestamptz not null,
  ended_at              timestamptz not null,
  duration_seconds      integer,                       -- NULL = no measured coverage
  idle_seconds          integer,                       -- NULL = idle not measured
  source                text not null default 'manual',
  application           text,
  timezone              text not null default 'UTC',   -- IANA name for day boundaries
  task_id               uuid references public.tasks(id) on delete set null,
  attribution_source    text,                          -- 'manual' | 'rule' | 'inferred'
  attribution_confidence numeric,                      -- 0..1, NULL = unknown
  observation_ids       uuid[],                        -- observations that produced this session
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint sessions_duration_non_negative check (duration_seconds is null or duration_seconds >= 0),
  constraint sessions_idle_non_negative check (idle_seconds is null or idle_seconds >= 0),
  constraint sessions_time_order check (ended_at >= started_at),
  constraint sessions_confidence_range
    check (attribution_confidence is null or (attribution_confidence >= 0 and attribution_confidence <= 1)),
  constraint sessions_attribution_source_valid
    check (attribution_source is null or attribution_source in ('manual','rule','inferred'))
);
```

- **Ownership:** `user_id` defaults to `auth.uid()`, NOT NULL with a loud orphan guard.
- **Overlap rule:** `duration_seconds` is the length of the **union** of the session's
  observation intervals. Overlapping observations are counted once, and sessions are a
  partition of the observed timeline, so session durations can never double-count the
  same observed time. The rule is implemented in one pure function and covered by
  assertions.
- **Missing duration:** `duration_seconds IS NULL` means "no measured coverage" — never
  `0`. A session built only from point events stores NULL.
- **Attribution:** `task_id` + `attribution_source` + `attribution_confidence`. A session
  with no task is *unattributed* — time is tracked without inventing a relationship. A
  task with no source is allowed (`attribution_source IS NULL` = unknown source).
- **Timezone:** `timezone` is the IANA zone in force when the session was recorded; it is
  used for local-day bucketing. A user-level preference is deferred.
- **Delete:** hard delete, scoped to the owner by RLS. Deleting the linked **task** sets
  `task_id` to `NULL` (`on delete set null`) — recorded time is evidence and is not
  destroyed by removing a task.

#### session_corrections (designed)

A manual correction is its own record. The observed values are never overwritten.

```sql
create table public.session_corrections (
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
  constraint session_corrections_duration_non_negative check (corrected_duration_seconds >= 0),
  constraint session_corrections_time_order check (corrected_ended_at >= corrected_started_at),
  constraint session_corrections_duration_matches_interval
    check (corrected_duration_seconds = (extract(epoch from (corrected_ended_at - corrected_started_at)))::integer)
);
```

- **Ownership:** `user_id` defaults to `auth.uid()`; a correction can only reference a
  session the same user owns (the FK is checked against the session's owner by the
  session's own RLS-protected lookup).
- **Effective duration:** the latest correction for a session wins; otherwise the
  session's own `duration_seconds`. The original stays in `sessions`, so the audit trail
  is intact.
- **Idempotent insert:** the row carries a client-generated id, so re-sending the same
  correction is a no-op instead of creating a duplicate.
- **Self-consistency:** a correction's duration must match the interval it corrects.
- **Delete:** cascading with the session it corrects.

#### Legacy relationship to `work_logs`

`work_logs` (Phase 2) stays as the dashboard's daily log entry and keeps its own
`duration_seconds`. It is **not** the source of truth for time totals: a report must never
sum `work_logs.duration_seconds` together with `sessions.duration_seconds`, because the
same work could be recorded in both. Any import of legacy rows into manual `sessions`
belongs to the reporting increment and must be idempotent.

### Phase 5 integrations — IMPLEMENTED (migration written, verified locally, not applied to live)

Status: implemented on 2026-10-20 in `supabase/migrations/20261020110000_integrations_phase5.sql`
and verified against PostgreSQL 16 (Docker) with a 40-check security/ownership/integrity
suite, a preflight check (the migration refuses to run before Phase 4) and a
three-times schema-drift check (applying it three times leaves an identical schema).
The migration is **not** applied to the live Supabase project (no admin credentials in
this environment) and **no adapter and no UI consume the tables yet** — Phase 5 is
persistence only. The existing `src/settings/components/IntegrationScreen.jsx` is a mock
of SSO providers and is unrelated to these tables.

#### integrations (designed)

One connection between a user and an external provider, driven by an independent adapter.
The row is the truthful state of the connection: the UI reads it, it never invents a state.

```sql
create table public.integrations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id),
  provider     text not null,                     -- adapter id, e.g. 'local_activity_file'
  label        text,                              -- human-readable name of the connection
  status       text not null default 'disconnected',
  config       jsonb not null default '{}'::jsonb,  -- NON-SENSITIVE settings only
  last_sync_at timestamptz,                       -- last SUCCESSFUL sync (UTC)
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint integrations_status_valid
    check (status in ('disconnected','connecting','connected','syncing','error')),
  constraint integrations_user_provider_unique
    unique (user_id, provider)
);
```

- **Ownership:** `user_id` defaults to `auth.uid()`, NOT NULL with a loud orphan guard; a
  client cannot forge an owner (RLS `with check` → `42501`).
- **One connection per provider:** `unique (user_id, provider)` — a second connection to
  the same provider is rejected (`23505`). Reconnecting means updating the existing row,
  not inserting a duplicate.
- **Truthful states:** `disconnected | connecting | connected | syncing | error`, enforced
  by `integrations_status_valid`; an unknown state is rejected (`23514`). A row left in
  `connecting`/`syncing` is the truth of an interrupted attempt, not an estimate.
- **`config` is NOT a secret store:** it holds non-sensitive adapter settings only (file
  paths, filters, poll intervals, limits). Credentials must never be written here — the
  column is readable by every signed-in user through the client. A credential belongs in
  a server-side secret store, which does not exist yet.
- **Time:** `last_sync_at` is the UTC time of the last **successful** sync; `NULL` means
  "never synced successfully" — never 0. `last_error` is `NULL` when no error occurred.
- **Delete:** hard delete of the connection row, scoped to the owner by RLS. Deleting it
  *is* the disconnect operation and removes, by `ON DELETE CASCADE`: the integration row,
  its `integration_sync_runs`, and the observations it imported. Nothing else is touched.
- **RLS policies** (`public.integrations`): `integrations_select_own`,
  `integrations_insert_own`, `integrations_update_own`, `integrations_delete_own` — all
  `to authenticated` using `(select auth.uid()) = user_id`. The `anon` role has no
  grants; `authenticated` is not the table owner, so `TRUNCATE` is refused (`42501`).
- **`updated_at`:** kept fresh by the `integrations_set_updated_at` trigger (reuses
  `public.set_updated_at()`).
- **Realtime:** the table is a member of the `supabase_realtime` publication.

#### integration_sync_runs (designed)

One synchronisation attempt of one integration — the audit trail of an import.

```sql
create table public.integration_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id),
  integration_id  uuid not null references public.integrations(id) on delete cascade,
  status          text not null default 'running',   -- running | success | error
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,                        -- NULL while running
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
```

- **Ownership:** `user_id` defaults to `auth.uid()`; the client cannot forge an owner.
- **Cross-owner references are rejected in the database:** the insert and the update
  policy additionally require
  `exists (select 1 from public.integrations i where i.id = integration_sync_runs.integration_id and i.user_id = (select auth.uid()))`.
  The subquery runs under the caller's RLS, so it can only ever see the caller's own
  connections — pointing a run at another user's integration fails with `42501`.
- **Run lifecycle:** opened with `status = 'running'` and closed with `success` or
  `error`; `finished_at` stays `NULL` while running. A run left in `running` means the
  adapter never closed it (crash, timeout) — it is the truth, not an estimate.
- **Counters:** `records_seen` (read from the source), `records_written` (written to the
  app), `records_skipped` (deliberately not written — already present, filtered out).
  Non-negative by constraint. The skipped counter is what makes a repeated import
  idempotent *and* auditable.
- **Delete:** cascading with the connection (`ON DELETE CASCADE`); a run can also be
  deleted on its own, scoped to the owner by RLS.
- **RLS policies** (`public.integration_sync_runs`):
  `integration_sync_runs_select_own`, `integration_sync_runs_insert_own`,
  `integration_sync_runs_update_own`, `integration_sync_runs_delete_own` — all
  `to authenticated`. `anon` has no grants; `TRUNCATE` is refused.
- **`updated_at`:** kept fresh by the `integration_sync_runs_set_updated_at` trigger. A
  run is opened and then closed, so it is mutable (unlike the append-only Phase 4
  tables) and therefore carries `updated_at`.
- **Realtime:** the table is a member of the `supabase_realtime` publication.

#### Provenance link: `observations.integration_id`

```sql
alter table public.observations
  add column if not exists integration_id uuid references public.integrations(id) on delete cascade;
create index if not exists observations_integration_id_idx on public.observations (integration_id);
```

- **What it is:** the connection that imported the observation. `NULL` means "not
  produced by an integration" (manual entry, collector). The column is nullable and
  additive, so the Phase 4 behaviour of existing observations is unchanged.
- **Delete:** `ON DELETE CASCADE` — disconnecting removes exactly the observations that
  integration imported, and only those. Observations with `integration_id IS NULL`, or
  pointing at another integration, survive.
- **Ownership guard (trigger, not policy):** the Phase 4 `observations` policies are
  append-only, grant no `UPDATE`, and are deliberately left untouched.
  `public.observations_integration_owner_guard()` runs `before insert or update` on
  `public.observations` and raises
  `observations.integration_id must reference an integration owned by the caller.`
  when the referenced integration is not the caller's. The lookup runs with the
  caller's privileges, so RLS on `integrations` hides every other user's connection.
- **Back-end writes are unaffected:** the guard only enforces when `auth.uid()` is not
  null, so `service_role` / server-side ingestion is not blocked.

#### Disconnect contract (what a caller must know)

`delete from public.integrations where id = '<integration>';` is the whole disconnect
operation. It removes, in one statement:

1. the connection row,
2. its `integration_sync_runs` (`ON DELETE CASCADE`),
3. the observations that referenced it (`ON DELETE CASCADE`).

It does **not** remove observations that were not imported by that integration, and it
does not touch any other user's rows. The cascade is performed by the database, so it
is not subject to the caller's RLS.

#### Rollback

The order matters — `observations.integration_id` holds the foreign key to
`public.integrations`, so the table cannot be dropped while that column exists
("constraint observations_integration_id_fkey on table observations depends on table
integrations"). Drop the link first:

```sql
drop trigger if exists observations_integration_owner_guard on public.observations;
drop function if exists public.observations_integration_owner_guard();
alter table public.observations drop column if exists integration_id;
drop table public.integration_sync_runs, public.integrations;
```

### Phase 6 notifications and workflows — IMPLEMENTED (migration written, verified locally, not applied to live)

Status: implemented on 2026-10-20 in `supabase/migrations/20261020120000_notifications_workflows_phase6.sql`,
verified against PostgreSQL 16 (Docker) with a 58-check security/ownership/integrity
suite (the whole chain 2→3→4→5→6 applied twice with no schema drift) and end to end
through a real PostgREST 12.2.3 with a real JWT (the worker delivered real
notifications). The migration is **not** applied to the live Supabase project (no
admin credentials in this environment).

The schedule lives in the database, so it survives a restart. It is EXECUTED by the
worker process (`scripts/worker.mjs`); while that process is not running, no workflow
runs. That limitation is stated in the UI, not hidden.

#### workflows (designed)

The definition of a scheduled workflow: when it runs, what must be true, what it does.

```sql
create table public.workflows (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                  text not null,
  description           text,
  trigger_type          text not null default 'schedule',    -- schedule | event
  trigger_config        jsonb not null default '{}'::jsonb,   -- {kind, at, weekdays, everyMinutes, timezone}
  conditions            jsonb not null default '[]'::jsonb,   -- [{type:'task_overdue'}]
  action_type           text not null default 'create_notification',
  action_config         jsonb not null default '{}'::jsonb,   -- {kind, title, body}
  channel               text not null default 'in_app',       -- the ONLY implemented channel
  enabled               boolean not null default true,
  requires_approval     boolean not null default false,
  max_attempts          integer not null default 3,
  retry_backoff_seconds integer not null default 60,
  next_run_at           timestamptz,
  event_cursor          timestamptz,                           -- last event already processed (UTC)
  last_run_at           timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
```

`next_run_at` is the next planned OCCURRENCE (a clock workflow). `event_cursor` is
the watermark of the last EVENT already processed (an event workflow) — an
event-triggered workflow reads the events after it, and a NULL cursor means
"everything so far". The cursor is an efficiency aid; the unique idempotency key of
a run is what actually prevents a repeated execution.

Delete: the workflow's runs and approvals are removed (ON DELETE CASCADE). The
notifications it produced are KEPT (ON DELETE SET NULL) — a delivered message is a
record of what the user was told.

#### workflow_runs (designed)

One execution attempt — the execution history. The idempotency key is the
duplicate-prevention mechanism, and it is enforced by the database.

```sql
create table public.workflow_runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workflow_id      uuid not null references public.workflows(id) on delete cascade,
  idempotency_key  text not null,
  status           text not null default 'scheduled',
  attempt          integer not null default 1,
  scheduled_for    timestamptz not null,
  next_attempt_at  timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  error            text,
  result           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint workflow_runs_idempotency_unique unique (user_id, idempotency_key)
);
```

`status`: scheduled | running | succeeded | failed | skipped | cancelled |
awaiting_approval. The key is derived from the workflow id and the occurrence, so the
same occurrence can be executed only once, however many workers or retries race for it.

#### notifications (designed)

The delivery record. The four states the spec asks to be told apart are DISTINCT and
each has its own timestamp.

```sql
create table public.notifications (
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
  updated_at      timestamptz not null default now()
);
```

`status`: scheduled (planned) | sent (handed to the channel) | delivered (the channel
confirmed it) | acknowledged (the user acted on it) | failed | cancelled. A missing
timestamp means that step did not happen — it is never back-filled.

#### notification_preferences (designed)

One row per user: the delivery preferences. Quiet hours are local `HH:MM` times; a
window whose start is later than its end crosses midnight.

```sql
create table public.notification_preferences (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  timezone          text not null default 'UTC',
  quiet_hours_start text,
  quiet_hours_end   text,
  channels          jsonb not null default '{"in_app":true}'::jsonb,
  kinds             jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
```

A missing row means "no preferences saved" — never "zero quiet hours".

#### approvals (designed)

Permission before a sensitive action. The action waits in `awaiting_approval` until
the user approves it; a rejection cancels the run.

```sql
create table public.approvals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  workflow_id uuid references public.workflows(id) on delete cascade,
  run_id      uuid references public.workflow_runs(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending',   -- pending | approved | rejected | expired
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

#### Rollback

```sql
drop table if exists public.approvals, public.notifications,
  public.notification_preferences, public.workflow_runs, public.workflows;
```

### Planned (not yet created)

- **goals** — id, user_id (FK→users), title, description, target_date, status, created_at, updated_at. Owner: user. Delete: restrict if tasks reference; or soft-delete.
- **projects** — id, user_id (FK→users), goal_id (FK→goals, nullable), title, description, status, created_at, updated_at. Owner: user. Delete: restrict if tasks reference.
- **observations** — implemented above (Phase 4, verified locally, not yet live): client-keyed raw events with occurrence/ingestion time split.
- **sessions** — implemented above (Phase 4, verified locally, not yet live): derived intervals with attribution and the union-duration overlap rule.
- **session_corrections** — implemented above (Phase 4, verified locally, not yet live): corrections as separate auditable records.
- **outcomes** — id, user_id, task_id (FK→tasks), type (completed/verified), evidence, recorded_at (UTC). Owner: user. *Planned — the "outcome" concept of §7C; a task reaching `completed` is currently recorded only as `tasks.completed_at`.*
- **integrations** — implemented above (Phase 5, verified locally, not yet live): one connection per user and provider with truthful states, a non-sensitive `config`, sync-run audit trail, and a disconnect that removes exactly the observations that integration imported.
- **workflows / workflow_runs / notifications / notification_preferences / approvals** — implemented above (Phase 6, verified locally, not yet live): the schedule, the execution history, the delivery records, the preferences and the approval requests.
- **event triggers** — implemented above (Phase 6C): one event type, `task_completed`, read from the `tasks` table. A task that reached `completed` without a `completed_at` timestamp produces no event — there is nothing to point at.

### Coding heartbeats (observations columns, 2026-10-22)

Migration `supabase/migrations/20261022140000_coding_activity.sql` adds nullable columns to `public.observations`:

| Column | Meaning |
|--------|---------|
| `activity_kind` | `'coding'`, and after the learning migration also `'learning'`, or NULL. NULL is every observation that is neither. |
| `editor` | `'cursor'` or `'vscode'`, or NULL. |
| `project_name` | Workspace folder name. Not a path. |
| `language` | Editor language id. |
| `file_name` | File name. Not a path. |

- **What a row is:** one heartbeat of active editor time. `occurred_at` is the start, `duration_seconds` is the measured span, `source` is `collector`, `integration_id` points at the `coding_tracker` connection when the extension sent it.
- **Sessions:** coding time is **not** copied into `public.sessions`. The timeline is derived by `foldHeartbeats`. Session totals and coding totals stay separate (D-012).
- **Delete:** deleting the connection cascades to heartbeats that reference it. Deleting one local day deletes the coding observations in that range and leaves other observations and sessions alone.
- **Missing:** a day with no heartbeats is "nothing recorded", not zero, until the UI is showing a measured total.

### Learning heartbeats (observations columns, 2026-10-22)

Migration `supabase/migrations/20261022150000_learning_activity.sql` widens `activity_kind` and adds nullable columns. Apply it after the coding migration. The coding migration will not narrow `activity_kind` back to coding-only once `learning` is in the check.

| Column | Meaning |
|--------|---------|
| `activity_kind` | `'learning'` for this collector. `'coding'` stays allowed. NULL is every other observation. |
| `site_host` | Allowlist host, such as `freecodecamp.org`. Not a URL, path, or query. |
| `page_title` | Page title when it is safe to keep. A URL is not stored here. |
| `course_label` | Course name when the page shape is known (freeCodeCamp). NULL otherwise. |
| `lesson_label` | Lesson or page name. Not a URL path. |

- **What a row is:** one heartbeat of active browser time on an allowlisted site. `occurred_at` is the start, `duration_seconds` is the measured span, `source` is `collector`, `application` is the site label, `window_title` stays NULL, and `integration_id` points at the `learning_tracker` connection when the extension sent it. Coding columns (`editor`, `project_name`, `language`, `file_name`) stay NULL.
- **Allowlist:** `integrations.config.sites` on the `learning_tracker` row. An explicit empty array tracks nothing. A missing `sites` key means the default: freeCodeCamp curriculum (`freecodecamp.org`, path prefix `/learn`). The address is matched in memory and is not a column.
- **Sessions:** learning time is **not** copied into `public.sessions` and is **not** added to coding totals (D-013). The timeline is derived by `foldHeartbeats` in `extensions/learning-tracker/lib/learningTime.js`.
- **Delete:** deleting the connection cascades to heartbeats that reference it. Deleting one local day deletes the learning observations in that range and leaves coding observations, other observations, and sessions alone.
- **Missing:** a day with no learning heartbeats is "nothing recorded", not zero.

### Grok chats and task reminders (2026-10-22)

Migration `supabase/migrations/20261022160000_grok_chat_alerts.sql`. Requires `public.tasks`. `ai_preferences.grok_model` is added only when that table already exists.

- **grok_conversations** — one chat. `title`, optional `model`, `user_id` default `auth.uid()`. Delete cascades to messages.
- **grok_messages** — a turn: `user`, `assistant`, or `tool`. A tool turn keeps `tool_call_id`. The message's owner must own the conversation (trigger, security invoker, so RLS applies).
- **task_alerts** — a reminder for one task (`task_id` on delete cascade). `due_at` is the next occurrence. `repeat` is `none`, `daily`, `weekly`, or `weekdays`. `status` is `scheduled`, `paused`, or `fired`. `last_fired_at` is the occurrence already delivered, so a second open does not deliver it again. `created_by` is `user` or `grok`. The task must belong to the same user.
- **Delivery:** an inbox row in `public.notifications` with `kind = task_alert` and `channel = in_app`. The id is derived from the alert and the occurrence. Browser notifications are this device showing that row; they are not a database channel.
- **RLS:** select, insert, update, and delete for `authenticated` where `user_id = auth.uid()`. `anon` has no grants.

## Relationships / ownership rules

- All records carry user_id; RLS enforces user A cannot read/modify user B's records.
- Manual corrections stored as separate records; originals remain auditable (never silently overwrite observed data).
- Missing data represented as missing, never zero.
- Durations in integer seconds everywhere.
- Times in UTC; timezone stored per user for display/day boundaries.
