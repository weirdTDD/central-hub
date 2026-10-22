# Central Hub — Decision Log

Format: one entry per major decision — context, options, choice, consequences, date.

## D-001 — Backend and authentication stack

**Context:** Phase 2 requires replacing mock auth (any credentials accepted; tokens in localStorage) with a real system and adding persistent data storage. The redesign prompt defaults to "lowest-cost managed option with a free tier; no always-on paid infrastructure without approval" and requires server-side ownership checks on every data endpoint.

**Options considered:**
1. Supabase (PostgreSQL + Auth + Realtime + Row Level Security, generous free tier).
2. Self-hosted Node/Express + PostgreSQL on Render free tier (build auth, RLS-equivalent authorization, realtime from scratch).

**Choice:** Supabase.

**Consequences:** Auth, database, and RLS-based ownership handled by a managed service with a free tier; no always-on paid infrastructure. Reduces operational surface versus self-hosting. Requires adding `@supabase/supabase-js` and environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) via `.env.example` only. Deferral: desktop collector OS confirmed as Windows WSL2; integration planning deferred to Phase 4+.

**Date:** 2026-10-20

## D-002 — UI palette

**Context:** Existing components use inline purple `#5B16E1` accents (e.g. DashboardPage.jsx). The redesign prompt requires blue for primary navigation/actions and teal for active states/highlights/progress/selected borders, with design tokens and no hard-coded colors after migration.

**Options considered:**
1. Keep purple and add teal as an accent only.
2. Migrate to blue primary / teal active across all components via CSS variables.

**Choice:** Option 2 (blue primary, teal active/progress), starting with index.css tokens + DashboardPage.jsx migration in Phase 1.

**Consequences:** Hard-coded purple removed incrementally per component; tokens defined in index.css; dark/light variants preserved.

**Date:** 2026-10-20

## D-003 — Work log storage shape

**Context:** The live `public.work_logs` table already existed with `id uuid, user_id uuid, title text, notes text, created_at timestamptz`, and RLS enabled. The app needs a work *day* distinct from the ingestion timestamp, and one canonical duration unit.

**Options considered:**
1. Reuse the existing columns and keep a display-level `duration` string.
2. Extend the table with `log_date date`, `duration_seconds integer`, `display_name text`.

**Choice:** Option 2.

**Consequences:** `duration_seconds` becomes the single source of truth for duration (integer seconds everywhere); `timeSpentMinutes` is derived in the client. `log_date` separates occurrence time from `created_at` (ingestion), so late/out-of-order records are representable. A log with no recorded duration stores `NULL`, never `0`, and is excluded from duration totals and reported separately as a data-completeness count. `display_name` was added so the existing "User Name" form field round-trips through the database instead of silently reverting on reload.

**Date:** 2026-10-20

## D-004 — Ownership enforcement and verification method

**Context:** Prompt Section 7A requires server-side authorization on every data endpoint; the anon key must never reach user work logs.

**Options considered:**
1. Filter by `user_id` in client queries only.
2. Row Level Security with per-owner policies, plus explicit `revoke` from `anon`.

**Choice:** Option 2 — four per-owner policies (`select`/`insert`/`update`/`delete`) on `public.work_logs`, all `to authenticated` using `(select auth.uid()) = user_id`, and `revoke all on public.work_logs from anon`.

**Consequences:** Ownership is enforced in the database, so it holds for every client including direct REST calls. The migration is idempotent and was verified against a real PostgreSQL 18 instance (Docker) emulating Supabase's roles and `auth.uid()`: cross-user reads/updates/deletes return zero rows, forging another owner is rejected with `42501`, and `anon` is denied outright.

**Date:** 2026-10-20

## D-006 — Phase 3 tasks model: self-contained table with a validated state machine

**Context:** Phase 3 introduces goals/projects/tasks. The `work_logs` schema already
uses integer-second durations, `auth.uid()` ownership, and per-owner RLS. Tasks must
be PLANNED INTENT, kept separate from observed activity, with a consistent, validated
state machine (Section 7B: "Use consistent task states and validate allowed
transitions; keep task status separate from time-tracking status").

**Options considered:**
1. Create `goals`, `projects`, and `tasks` tables together with FK linkages and a
   full UI for all three in one increment.
2. Create only `tasks` (self-contained, no project/goal FK columns yet), with a
   documented state machine and the full CRUD list page; defer goals/projects
   tables and FK linkages to a follow-up increment.

**Choice:** Option 2.

**Consequences:** Keeps the increment reviewable (<10 min diff) and avoids two
unused-with-no-UI tables (`goals`, `projects`). `tasks` is a real, owned, queryable
table from the start. `estimated_duration_seconds` reuses the canonical
integer-second unit. Status/priority values are enforced by DB `CHECK`
constraints; allowed transitions are validated client-side in
`TasksContext.transitionTask` (there is no app backend yet — this is a documented
limitation; a stored procedure could enforce it server-side later).
`completed_at` is set/cleared by the context on complete/reopen.
RLS hardening mirrors D-004 (drop-all-policies loop, `revoke all` then grant only
CRUD to `authenticated`; `anon` gets nothing; owner is the DB role so
`authenticated` cannot `TRUNCATE`). The migration is idempotent and was verified
locally against PostgreSQL 16 (Docker) with a 21-case security/ownership suite.
Project/goal linkage (`project_id`/`goal_id` FK columns) lands in a later
increment when those tables and their UI exist.

**Date:** 2026-10-20

## D-007 — Phase 4 time-tracking model: observations, sessions, and corrections as separate records

**Context:** Phase 4 (MASTER_SPEC §7C) requires four distinct concepts — observation, session, attribution, outcome — and mandates: client-generated idempotency keys, occurrence time stored separately from ingestion time, one duration unit, an explicit overlap rule, late/out-of-order events accepted and correctly recomputed, missing data represented as missing, and manual corrections stored as separate records that never overwrite observed data. The repository already has `work_logs` (a daily manual log entry: title, notes, day, duration) and `tasks` (planned intent with a validated state machine), but neither can express a raw event, an attributed time interval, or an auditable correction.

**Options considered:**
1. Extend `work_logs` with more columns and treat a log row as both the observation and the session (single table, no separate correction record).
2. Three tables — `observations` (raw events, client-keyed), `sessions` (derived time intervals with attribution), `session_corrections` (manual corrections as separate, auditable rows) — and keep `work_logs` as the existing daily narrative log.
3. Full event sourcing: one append-only event table with client-side projections for every read model.

**Choice:** Option 2.

**Consequences:**
- `observations.id` is a client-generated UUID used as the primary key, so repeating ingestion is a no-op (`on conflict (id) do nothing`) — ingestion is idempotent by construction, not by convention.
- `occurred_at` (UTC) and `ingested_at` (server default) are separate columns, so late and out-of-order events are representable; sessions are recomputed from observations sorted by `occurred_at`.
- `sessions.duration_seconds` is the length of the **union** of the session's observation intervals: overlapping observations are counted once. Sessions are a partition of the observed timeline, so the sum of session durations can never exceed the observed time.
- Attribution is explicit and conservative: `task_id` plus `attribution_source` (`manual` / `rule` / `inferred`) and `attribution_confidence` (0–1, nullable = unknown). A session with no task stays unattributed; the system never invents a task relationship.
- Corrections live in `session_corrections` as their own rows; `sessions` keeps the original values, so the observed record stays auditable. The effective duration is the latest correction when one exists, otherwise the session's own duration.
- `sessions.timezone` (IANA name, default `UTC`) carries the user's timezone for day-boundary calculations at write time. A user-level timezone preference table is deferred to a later preferences increment.
- `sessions.task_id` uses `on delete set null`: deleting a task must not destroy recorded time — the session survives as unattributed evidence.
- `work_logs` is kept (it is the dashboard's daily log and already powers existing reports). It is **not** the source of truth for time totals: reports must not sum `work_logs.duration_seconds` and `sessions.duration_seconds` together, or the same work would be counted twice. A one-off import of legacy `work_logs` rows into manual `sessions` is deferred to the reporting increment and must be idempotent if it happens.
- Ownership follows D-004/D-006: `user_id` defaults to `auth.uid()`, NOT NULL with a loud orphan guard, per-owner RLS policies, `revoke all` before a minimal `grant` to `authenticated` (so `TRUNCATE` stays denied), and `anon` receives no grants.
- The state machine for tasks stays independent of time tracking; a session never changes a task's status.
- Transition validation and sessionization logic live in a pure client module (`src/features/tracking/`) so they can be verified with plain Node assertions, since there is no app backend and no test framework in the repository yet.

**Implementation (2026-10-20):** implemented in `supabase/migrations/20261020100000_time_tracking_phase4.sql`, `src/features/tracking/sessionUtils.js` (pure rules), `src/lib/tracking.js` (data layer) and `scripts/verify-tracking.mjs` (30 Node assertions). The migration applies idempotently and passed a 31-check security/ownership/integrity suite plus a 5-check `anon` suite against PostgreSQL 16 in Docker. It is **not** applied to the live Supabase project, and no UI consumes the tables yet (Phase 4B).

**Date:** 2026-10-20

## D-008 — Supabase session persistence in `localStorage`

**Context:** `src/lib/supabase.js` creates the Supabase client with `persistSession: true`, so the browser stores the session (access **and** refresh token) in `localStorage` under `sb-<ref>-auth-token`. The project rule in `docs/MASTER_SPEC.md` states that sensitive authentication tokens must never be stored in `localStorage`. An independent review flagged this as a security finding: any XSS in the SPA, or local access to the browser profile, yields a full, refreshable account session.

**Options considered:**
1. Keep the Supabase default (localStorage) and accept the risk explicitly.
2. `persistSession: false` (memory-only session) with a PKCE refresh on every page load.
3. Move the session to an httpOnly, Secure, SameSite cookie issued by a server-side endpoint.

**Choice:** Option 1, recorded explicitly.

**Consequences:**
- The risk is real and accepted for this phase: the app is a single-user personal
  operating system, the tokens are short-lived and rotated by Supabase, and the app
  stores no other secret in the browser. Option 2 would sign the user out on every
  reload and break the dashboard's realtime sync; option 3 needs a server-side
  endpoint, and there is no app backend yet.
- The mitigated part of the finding IS fixed in this change set: no third-party avatar
  service receives the account email any more (the avatar is rendered locally from
  initials — see `src/lib/avatar.js`), which was the only place where an identifier
  left the browser.
- This decision is revisited when a backend exists (option 3 becomes feasible) or if
  the app gains a public/multi-user deployment (then option 1 must be replaced).
- No password or API secret is ever stored in the browser; the anon key is public by
  design and every row is protected by RLS.

**Date:** 2026-10-20

## D-005 — Report module: removing fabricated data

**Context:** With work logs now persisted for real, the report module would have contradicted the live data: the heatmap randomised empty days, the status pie used hard-coded counts, the completion chart used a hard-coded series, the KPI cards used mock trend percentages, and `Top LoggedTasks` fell back to a mock dataset because it was rendered without a `logs` prop.

**Options considered:**
1. Keep the mock charts and label them.
2. Replace each with data derived from the stored records, or remove it where no real source exists.

**Choice:** Option 2.

**Consequences:** The heatmap no longer fabricates activity (empty days are level 0, "no data" is distinct from "no activity"). The hard-coded status pie was replaced by a real "Data Coverage" chart reporting how many log entries carry a duration, since work logs have no task status until task management exists. The completion chart now counts real log entries per weekday and states explicitly that log entries are not completed tasks. The KPI cards dropped the mock trend badges and gained a completeness note. `Top LoggedTasks` is now fed the real filtered logs. Removing the mock trend badges is a deliberate removal of always-fake UI, not a lost feature.

**Date:** 2026-10-20

## D-009 — Phase 5 first integration: a local activity-file import

**Context:** Phase 5 of the master spec (integrations) requires "one verified integration at a time", with a documented contract per adapter — what it can access, its permissions and configuration, how it authenticates, what it reads and writes, how synchronisation and deduplication work, how errors, retries, expired credentials and disconnection are handled, what is retained and how it is removed — plus truthful connection states (disconnected, connecting, connected, syncing, error) with the last successful sync time. The repository had no integration machinery at all: the only thing present was a static settings screen that rendered a hard-coded "Google — Connected" row, which the spec's "no fake functionality" rule forbids. The collector OS is recorded as Windows WSL2, and the learning platforms are "manual milestones only until a verified integration exists" (no platform named yet), so no third-party integration could be verified in this environment. Sending data to a third party is also an approval trigger in the spec, so it cannot be done unilaterally.

**Options considered:**
1. A VS Code activity extension — a real collector, but it needs a published extension host, a WSL2/Windows bridging decision, and a trust model for window titles; none of it can be verified end to end here.
2. A learning-platform integration (e.g. DataCamp) — blocked until the platform is named and its credentials are approved; the spec forbids claiming platform progress without a verified, authorized integration.
3. A local activity-file import — a real adapter over a file the user picks on their own machine: no network, no third party, no credentials, and every part of it is verifiable locally.
4. A synthetic test double with no real data source — fast, but it verifies nothing about the contract and is exactly the fake functionality the spec forbids.

**Choice:** Option 3, a local activity-file import. It is a real adapter, not a mock, and it exercises the complete contract: permissions (the user explicitly picks a file), authentication (none — the app session only), reads and writes (the records become observations), synchronisation (manual, on demand), deduplication (deterministic client-generated observation ids, so re-importing the same file creates no duplicates), error handling (a malformed file fails the whole run with a message that names the offending record and leaves already imported data untouched), retention, and removal on disconnect (the imported observations are removed with the connection). It is also the manual step toward the eventual Windows/WSL2 collector, and it keeps the spec's "no fake functionality" rule intact.

**Consequences:**
- The collector and extension adapters remain unbuilt. They will follow the same documented contract and the same verification script, so a later adapter is an addition to a settled shape rather than a new design.
- The first import writes observations with `source = 'import'` and links them to the connection through `observations.integration_id`, so a disconnect removes exactly that data and nothing else. The migration that creates `integrations` and `integration_sync_runs` and adds `observations.integration_id` is `supabase/migrations/20261020110000_integrations_phase5.sql`; it is **not** applied to the live Supabase project, and the integrations screen is being built in parallel — no screen is claimed as working here.
- Adapters that are not implemented carry no connect affordance and are listed as "Coming soon". A visible integration is not proof that an integration works, so no adapter is reported as connected until it has actually been verified.
- The roadmap order changed: Phase 5A is being built before Phase 4B, the time-tracking UI. This is acceptable because the integration foundation and the adapter contract are independent of the tracking UI, the imported data is observable in the integrations screen and in the database once that screen lands, and 4B follows immediately.

**Date:** 2026-10-20

## D-010 — Phase 6 notifications: a database-backed schedule executed by a worker process

**Context:** Phase 6 of the master spec (Section 7E) requires "a reliable workflow foundation with time-based and event-based triggers, explicit conditions and permitted actions, persistent job scheduling, idempotency and duplicate prevention, retry policies and execution history, cancellation and recovery after restart, quiet hours, snoozing, and delivery preferences, and approval requirements for sensitive actions" and, explicitly, "do not depend on browser timers alone for reliable background execution. Choose the appropriate runtime for desktop or server-side scheduling and document limitations caused by sleep, offline operation, or unavailable services". The repository is a React/Vite frontend on Supabase: there is no application server, and the hosting budget rule forbids always-on paid infrastructure. The spec also asks to "distinguish a notification that was scheduled from one that was sent, delivered (when the channel reports it), and acknowledged", and the "no fake functionality" rule forbids a channel that does not exist.

**Options considered:**
1. Browser timers (`setTimeout` in the app) — forbidden by the spec, and a closed laptop silently loses every scheduled notification.
2. Postgres-only execution (`pg_cron` + a PL/pgSQL function that evaluates the whole engine) — no extra runtime, but the domain rules become SQL that cannot be unit-tested in Node, and `pg_cron` availability depends on the Supabase plan.
3. A Supabase Edge Function (Deno) — a real server-side runtime, but it needs a deployment pipeline and a service-role secret, and nothing about it can be run or verified in this environment.
4. A database-backed schedule executed by a small Node worker process — the schedule lives in the database (so it survives restarts and is shared by every client), and a plain process does the execution.

**Choice:** Option 4, with the engine written once in pure JavaScript (`src/features/notifications/workflowEngine.js`) and used by BOTH the worker and the app.

- The schedule is persistent: `workflows.next_run_at` plus the `workflow_runs` history. A restart of the app or of the worker loses nothing.
- Duplicate prevention is enforced by the DATABASE: `(user_id, idempotency_key)` is unique, and the key is derived from the workflow id and the occurrence. Two workers, a retry and a restart cannot execute the same occurrence twice.
- The worker runs as the signed-in user (its access token is supplied in the environment), so it needs no service-role secret and it is subject to the same row-level security as the app.
- The worker talks to PostgREST with `fetch` instead of `@supabase/supabase-js`: the browser client requires a global `WebSocket` (Node.js 22+), and a scheduler must not depend on the runtime of the UI.
- The ONLY channel that exists is `in_app`; the CHECK constraint refuses any other channel, so a row can never claim a delivery that no channel can perform. Email and push are listed as "Not connected" in the UI.
- The four notification states (scheduled / sent / delivered / acknowledged) are stored as four separate facts with four separate timestamps, so a missing step is visible as missing.

**Consequences:**
- The scheduler only runs while `node scripts/worker.mjs` is running. This is stated in the Notifications page ("the schedule is executed by the worker process; while that process is not running, no workflow is executed") and in `docs/TECHNICAL.md`, rather than being presented as an always-on capability.
- The worker is a separate process, not part of the app build: it must be started (or scheduled by a service manager) wherever the workflows should run.
- Event-based triggers are NOT implemented: the schema accepts `trigger_type = 'event'`, but the engine refuses such a workflow with a reason instead of silently ignoring it. The UI does not offer the option.
- The migration `supabase/migrations/20261020120000_notifications_workflows_phase6.sql` is **not** applied to the live Supabase project (no admin credentials in this environment), so the `/notifications` page cannot be exercised against live data yet.
- The roadmap order changed again: Phase 6 was built before Phase 4B (the time-tracking UI) was finished. The user approved this explicitly in the session that built it. The reasons: the workflow domain depends on the task and session records that already exist, the notification domain is independent of the tracking UI, and both remaining Phase 4/5 gaps are unaffected by the new domain.

**Date:** 2026-10-20

## D-012 — Coding time is heartbeats on observations, not rows in sessions

**Context:** Central Hub needs automatic coding time from Cursor and VS Code: active time, idle detection, project, language, file activity, and which editor was in use. Supabase is already the store (observations, sessions, integrations, RLS). The sessions table is the recorded-time stream used by planned-versus-actual. A person can also log that same hour by hand.

**Options considered:**
1. A new `coding_sessions` table, written by the extension, shown on its own page.
2. Write derived sessions into `public.sessions` with `source = collector` so the existing journal and planned-versus-actual pick them up.
3. Store heartbeats as `observations` (`source = collector`, `activity_kind = coding`) and derive the timeline in the app. Do not copy them into `sessions`.

**Choice:** Option 3.

**Consequences:**
- The extension (one VS Code extension; Cursor runs it too) detects the editor from `vscode.env.appName` (`Cursor` → cursor, anything else → vscode). It records the span between activities inside an idle window (default 120 seconds). Idle time, unfocused time, and a sleep gap are not counted. A single activity with no following activity has no measured span and is not stored.
- Each heartbeat is an observation with a client id derived from the connection, editor, project, file, start, and duration. A retry does not create a second row. Full paths and window titles are not stored; the file and project columns are names only.
- `activity_kind` is `'coding'` or NULL. Later sources (browser, chat) can add a value with a migration. The check does not list kinds that do not exist yet.
- The Coding page, the dashboard card, and the report panel sum heartbeats with the same overlap rule: overlapping time is counted once. Those totals are labeled as coding time and are not added to work logs or to session totals.
- The extension signs in as the user (email and password once; refresh token in the editor's secret storage). It upserts an `integrations` row with provider `coding_tracker`. Disconnect deletes the heartbeats linked to that row. Offline heartbeats stay in the editor until they send.
- The migration is `supabase/migrations/20261022140000_coding_activity.sql`. It is not applied to the live project from this environment.

**Date:** 2026-10-22

## D-011 — Event triggers: a task completion, read from the task table

**Context:** D-010 built the clock half of the workflow foundation: "time-based and event-based triggers" is what the spec asks for, and the event half was left unimplemented on purpose (the engine refused it with a reason). An event trigger needs a way to notice that something happened, a way to know it has already been handled, and a way to guarantee it is not handled twice.

**Choice:** The only event type is **`task_completed`** — a task row that reached the `completed` state. It is read from the `tasks` table, not from a message bus, because the event IS a stored fact: the row already says it happened.

- **The event is a fact, not a signal.** The worker reads the tasks whose `completed_at` is after the workflow's `event_cursor`; it never invents an event and never reacts to something it cannot point at.
- **The cursor is an efficiency aid, not the guarantee.** `workflows.event_cursor` is the watermark of the last processed event, so a tick does not walk the whole task table. The GUARANTEE against a repeated execution is the idempotency key of the run: the key is derived from the workflow, the event type, the task and the moment the task was completed, and the database refuses a second run with the same key.
- **A new event workflow starts at "now".** When a workflow is created (or switched back on), its cursor is set to the current instant, so it reacts to what happens from then on and does not deliver a burst of notifications for everything that happened before it existed.
- **An event that does not match the conditions is still recorded** — as a `skipped` run — and the cursor still advances, so the history says why nothing was delivered and the same event is not examined again.
- **Only the event types that exist are offered.** `EVENT_TYPES` contains exactly one entry; the create form offers exactly that one. An unknown event kind is refused by the engine with a reason, never silently ignored.

**Consequences:**
- The event trigger is only as good as the `completed_at` column: a task that was completed without a timestamp produces no event, because there is nothing to point at.
- A task that is completed, reopened and completed again produces a second event (the completion moment differs) and therefore a second notification. That is deliberate — two completions are two events.
- The migration adds `workflows.event_cursor` and a `tasks (user_id, completed_at)` index. The index is created only when `public.tasks` exists, so the Phase 6 migration keeps working without the Phase 3 migration.
- Event-triggered workflows have no `next_run_at`: there is no clock to plan. The UI shows the trigger description instead of a next occurrence.

**Date:** 2026-10-20
