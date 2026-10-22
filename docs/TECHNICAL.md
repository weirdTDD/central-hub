# DailyLogs — Technical Documentation

Technical reference for the DailyLogs frontend workstream: architecture, modules, data flow, and a changelog of what was added or changed.

## 1. Architecture overview

DailyLogs is a client-only SPA. There is no API layer yet. App state lives in React context and `localStorage` for auth/theme.

```text
Browser
  └─ App
       ├─ AuthProvider          # session in localStorage
       ├─ LogsProvider          # in-memory work logs seeded from mockData
       └─ AppRoutes
            ├─ /login           # public
            └─ ProtectedRoute   # dashboard, logs, reports, settings
```

### Providers (`src/App.jsx`)

| Provider       | Responsibility |
|----------------|----------------|
| `AuthProvider` | Login / logout, persisted user session |
| `LogsProvider` | CRUD over work logs shared by Dashboard + Reports |

Theme preference is applied on boot via `applyTheme(readTheme())` from `src/settings/theme.js`.

### Routing (`src/routes/AppRoutes.jsx`)

- `/` and unknown paths redirect based on auth (`/dashboard` or `/login`)
- App pages wrap with `ProtectedRoute`
- Settings uses nested routes under `/settings`
- `/notifications` is the workflow inbox (Phase 6); its provider lives on that route

---

## 2. Module map

### Auth — `src/auth/`

| File | Role |
|------|------|
| `AuthContext.jsx` | Mock auth API: `login`, `loginWithGoogle`, `logout`, `user`, `isAuthenticated` |
| `AuthPage.jsx` | Split-layout sign-up / login UI (form + purple promo panel) |
| `AuthIllustration.jsx` | SVG illustration for the promo panel |
| `ProtectedRoute.jsx` | Redirects unauthenticated users to `/login` |

**Session key:** `localStorage["dailylogs-auth"]`

**Behavior notes:**
- Sign-up mode collects full name, email, password
- Login mode hides full name
- Password visibility toggle
- Google button creates a seeded mock user (`Bright Kelly`)
- Any non-empty email/password succeeds (no server validation)

### Dashboard & shared logs — `src/dashboard/`

| File | Role |
|------|------|
| `LogsContext.jsx` | Source of truth for work logs; `addLog`, `updateLog`, `deleteLog`, `getLog` |
| `logUtils.js` | Duration parse/format, display dates (`MM-DD-YYYY`), CSV download helper |
| `DashboardPage.jsx` | Table UI: search, date range, selection, dense mode, pagination, export, navigate to create/edit |

**Log shape:**

```js
{
  id: number,
  user: { name, avatar, role },
  task: string,
  date: "YYYY-MM-DD",
  duration: "4h 30m",
  timeSpentMinutes: number,
  note: string
}
```

Seed data lives in `src/report/mockData.js` (`WORK_LOGS`) and is cloned into context state on load.

### Log entry screens — `src/logs/`

| File | Role |
|------|------|
| `LogEntryLayout.jsx` | Top bar (logo + user chip) used by create/edit |
| `LogEntryForm.jsx` | Shared fields: task/user, date, time spent, note |
| `NewLogEntryPage.jsx` | Create flow → `addLog` → `/dashboard` |
| `EditLogEntryPage.jsx` | Edit/delete flow with breadcrumbs |

Entry point from Dashboard: **Generate** → `/logs/new`; pencil → `/logs/:id/edit`.

### Reports — `src/report/`

| Path | Role |
|------|------|
| `reportPage/Page.jsx` | Page shell with sidebar |
| `components/ProductivityReport.jsx` | Filters + composition of report widgets |
| `components/KpiSummary.jsx` | KPI cards (time logged, tasks, avg daily hours) |
| `components/TaskCompletionChart.jsx` | Line chart (Recharts) |
| `components/TaskStatusChart.jsx` | Status breakdown chart |
| `components/TopLoggedTask.jsx` | Top tasks list |
| `components/DateRangePicker.jsx` | Range picker for filters |
| `components/Sidebar.jsx` | App navigation + logout |
| `components/UserInfo.jsx` | Sidebar user chip |
| `heatmap/Heatmap.jsx` | Year activity heatmap |
| `utils/KpiUtils.js` | KPI calculations (`calculateKPIs`) |
| `utils/TaskLogged.js` | Aggregate helpers for top tasks |
| `mockData.js` | Seed work logs |

Reports consume `useLogs()` so create/edit/delete on the dashboard also updates report metrics.

**Import note:** Linux/WSL is case-sensitive. Import `../utils/KpiUtils` (capital **K**), matching the filename.

### Settings — `src/settings/`

| File | Role |
|------|------|
| `SettingsPage.jsx` | Layout + tab nav (Profile / Notification / Integration) |
| `theme.js` | Theme read/write + `document.documentElement` class toggle |
| `components/ProfileScreen.jsx` | Profile form + appearance (Light / Dark / System) |
| `components/NotificationScreen.jsx` | Points at the Notifications page and lists the real channel states |
| `components/IntegrationScreen.jsx` | SSO rows (Google connected, Microsoft connect, SAML) |

**Theme key:** `localStorage["dailylogs-theme"]`

### Notifications & workflows — `src/features/notifications/`

| File | Role |
|------|------|
| `workflowEngine.js` | The PURE rules: next occurrence (timezone-aware), conditions, quiet hours, retry backoff, state machines, idempotency keys |
| `NotificationsContext.jsx` | Loads the inbox, workflows, runs, approvals and preferences; realtime sync |
| `NotificationsPage.jsx` | `/notifications`: inbox, workflows, approvals, preferences, execution history |

Data layer: `src/lib/notifications.js`. Scheduler runtime: `scripts/worker.mjs`.

### Shared UI — `src/components/ui/`

Radix/shadcn-style primitives used by reports and forms: `button`, `calendar`, `card`, `chart`, `drawer`, `popover`, `select`.

Helpers: `src/lib/utils.js` (`cn` via `clsx` + `tailwind-merge`).

---

## 3. Data & UX flows

### Auth gate

1. Unauthenticated visit to a protected path → `/login`
2. Successful login → `/dashboard`
3. Logout → clear storage → `/login`

### Work log lifecycle

1. Seeded from `WORK_LOGS`
2. Create via `/logs/new` (prepends to context list)
3. Edit/delete via `/logs/:id/edit`
4. Dashboard filters/search operate on the live context list
5. Reports recompute from the same list

### CSV export

Dashboard **Export as CSV** exports either:

- selected rows, or
- the current filtered set if nothing is selected

---

## 4. Tooling & config

| File | Purpose |
|------|---------|
| `vite.config.js` | React + Tailwind plugins; `@` → `./src` |
| `package.json` | Scripts and dependencies (`activity_app`) |
| `pnpm-lock.yaml` | Lockfile (prefer pnpm; ignore stray `package-lock.json`) |
| `.gitignore` | Ignores `node_modules`, `dist`, env files; `/logs` is root-only so `src/logs` is tracked |

### Commands

```bash
pnpm install
pnpm approve-builds   # if pnpm blocks esbuild lifecycle scripts
pnpm dev
pnpm build
pnpm lint

node scripts/verify-tracking.mjs    # time-tracking domain rules
node scripts/verify-learning.mjs    # learning allowlist, idle time, queue, and writes
node scripts/verify-grok.mjs        # Grok model, reminders, context, and the chat stream
node scripts/verify-planned-actual.mjs   # planned vs actual: estimates, recorded time, unattributed time
node scripts/verify-contracts.mjs   # app vocabularies vs the SQL constraints
node scripts/verify-integrations.mjs   # integration contract, adapter parsing and dedup rules
node scripts/verify-notifications.mjs  # workflow, quiet-hours, retry and idempotency rules
node scripts/worker.mjs --once      # run the workflow scheduler once (see below)
```

### The workflow worker (the scheduler)

The workflow schedule lives in the database (`workflows.next_run_at`), so it survives
a restart of the app and of the worker. It is **executed** by a separate process:

```bash
CENTRAL_HUB_URL="https://<project>.supabase.co" \
CENTRAL_HUB_ANON_KEY="<anon key>" \
CENTRAL_HUB_ACCESS_TOKEN="<a signed-in user's access token>" \
node scripts/worker.mjs            # runs every 30s
node scripts/worker.mjs --once     # a single tick, then exit
node scripts/worker.mjs --interval=60000
```

- The worker runs **as the signed-in user**, so it needs no service-role key and it
  is bound by the same row-level security as the app.
- While the worker is not running, no workflow is executed. The Notifications page
  says exactly that — it never claims a scheduler is running.
- The worker talks to the REST API with `fetch` (not `@supabase/supabase-js`): the
  browser client needs a global `WebSocket` (Node.js 22+).
- An unconfigured worker prints `Not connected: …` and exits with a non-zero code.
- To run it continuously, use a service manager (systemd, `pm2`, a container) on the
  machine that should run the schedules.

**What the worker does on a tick**

1. It reads the clock workflows whose `next_run_at` has passed, evaluates their
   conditions and delivers a notification for the ones that match.
2. It re-executes the runs whose retry is due (the run row is reused, so a retry can
   never produce a second execution).
3. It reads the EVENT workflows: the tasks that reached `completed` after the
   workflow's `event_cursor`, delivers a notification for each of them, and advances
   the cursor. The only event that exists is `task_completed` (D-011).


### Deploy checklist (order matters)

The frontend reads columns and tables that only exist after the migrations have been
applied. **Apply the migrations BEFORE deploying a new frontend build**, in this
order:

1. `supabase/migrations/20261020090000_work_logs_phase2.sql` — adds `log_date`,
   `duration_seconds`, `display_name` to `work_logs` (creates the table if missing).
2. `supabase/migrations/20261020091000_tasks_phase3.sql` — creates `tasks`. Requires
   nothing from step 1.
3. `supabase/migrations/20261020100000_time_tracking_phase4.sql` — creates
   `observations`, `sessions`, `session_corrections`. **Requires step 2** (it refuses to
   run while `public.tasks` is missing).
4. `supabase/migrations/20261020110000_integrations_phase5.sql` — creates
   `integrations`, `integration_sync_runs` and adds `observations.integration_id`.
   **Requires step 3** (it refuses to run while `public.observations` is missing).
5. `supabase/migrations/20261020120000_notifications_workflows_phase6.sql` — creates
   `workflows`, `workflow_runs`, `notifications`, `notification_preferences` and
   `approvals`. It has no dependency on the earlier migrations, but it must be applied
   before the `/notifications` page is used.
6. `supabase/migrations/20261022140000_coding_activity.sql` — adds coding columns
   (`activity_kind`, `editor`, `project_name`, `language`, `file_name`) to
   `observations`. **Requires step 3.** The `/coding` page, the dashboard Coding
   card, and the report's coding panel read these columns. Apply it before using
   the Cursor / VS Code extension.

Apply them with the Supabase SQL Editor (paste the file, run) or `supabase db push`.
Afterwards, tell PostgREST to pick up the new schema:

```sql
NOTIFY pgrst, 'reload schema';
```

If a build is deployed without the matching migration, the dashboard and reports fail
with `42703 column … does not exist` (or `PGRST205` for a missing table).

---

## 5. Changelog — what was added or changed

This section summarizes the workstream relative to the empty/scaffold repo.

### Added

#### Scaffold & foundation
- Vite + React + Tailwind project config
- Shared UI primitives under `src/components/ui/`
- Global styles (`src/index.css`), app entry (`src/main.jsx`), path alias `@`

#### Auth
- Full sign-in / sign-up page matching the DailyLogs mock
- `AuthContext` with localStorage persistence
- `ProtectedRoute` wrapping app screens
- Sidebar logout wired to clear session

#### Dashboard & logs
- Dashboard table (search, date range, checkboxes, dense mode, pagination)
- CSV export helper
- New Log Entry screen
- Edit Log Entry screen (breadcrumbs, save, delete)
- Shared `LogsContext` so Dashboard and Reports stay in sync

#### Reports
- Productivity report page composition
- KPI cards, heatmap, charts, top logged tasks
- Date range filtering against shared logs
- Case-correct `KpiUtils` import (fixes blank reports page on Linux)

#### Settings
- Profile tab (personal form + appearance theme)
- Notification preferences with toggles
- SSO integrations UI (Google / Microsoft / SAML)
- Theme persistence (`light` | `dark` | `system`)

#### Docs
- Root `README.md` (product + quick start)
- This technical document (`docs/TECHNICAL.md`)

### Changed / fixed

| Item | Detail |
|------|--------|
| KPI import path | `kpiUtils` → `KpiUtils` (case-sensitive filesystem) |
| Reports blank page | `ProductivityReport` referenced removed `WORK_LOGS` import; switched to `filteredLogs` from `useLogs()` |
| `.gitignore` | Broad `logs` rule ignored `src/logs`; narrowed to `/logs` |
| Sidebar navigation | Switched from `<a href>` to React Router `<Link>` |
| Seed data | Unique log IDs, added `note` fields, extra sample rows for dashboard demos |
| App shell | Root redirects and route protection depend on auth state |

### Intentionally not in scope

- Real backend / SSO providers
- Password hashing or real credential validation
- Persisting work logs beyond memory (reload resets to mock seed)
- Automated test suite

---

## 6. Commit history (feature layering)

Work was landed on `main` in ordered commits:

1. `chore: scaffold Vite React app with Tailwind tooling`
2. `feat: add shared UI primitives and app entry`
3. `feat: add productivity reports with shared work-log data`
4. `feat: add settings profile, notifications, and integrations`
5. `feat: add dashboard work logs and create/edit entry flows`
6. `feat: add sign-in authentication and protect application routes`

---

## 7. Extension points

When connecting a real API:

1. Replace `AuthContext` login with token exchange; keep `ProtectedRoute` as the gate
2. Replace `LogsContext` mutations with REST/GraphQL calls; keep the same consumer hooks
3. Keep route paths stable so UI screens do not need a rewrite
4. Move theme/auth keys to a small constants module if more storage keys appear
