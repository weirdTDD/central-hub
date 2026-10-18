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
| `components/NotificationScreen.jsx` | Preference toggles |
| `components/IntegrationScreen.jsx` | SSO rows (Google connected, Microsoft connect, SAML) |

**Theme key:** `localStorage["dailylogs-theme"]`

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
```

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
