# Central Hub — Redesign Merge Plan

Plan file: `.kilo/plans/1792454659-central-hub-redesign-merge-plan.md`

## 1. Assessment of the existing application

The repo is a client-only React/Vite SPA named `activity_app` (DailyLogs product), per `README.md` and `docs/TECHNICAL.md`.

**Stack:** React 19, Vite 7, React Router 7, Tailwind CSS 4, Radix UI primitives, Recharts + ECharts, date-fns, react-day-picker, pnpm. Path alias `@` → `./src`. No test framework, no type-check script, no lint failures recorded yet.

**Architecture (client-only, no API layer):**
- `src/App.jsx` composes `AuthProvider` > `LogsProvider` > `AppRoutes`.
- `AuthContext` — mock auth: any non-empty email/password succeeds; session in `localStorage["dailylogs-auth"]`; Google button seeds a mock user. No server, no password hashing, tokens in localStorage.
- `LogsContext` — in-memory work logs seeded from `src/report/mockData.js` (`WORK_LOGS`); resets to seed on reload. No persistence.
- Routes preserved: `/login`, `/dashboard`, `/logs/new`, `/logs/:id/edit`, `/reports`, `/settings/{profile,notifications,integrations}`.
- UI: purple `#5B16E1` accents inline in components (e.g. `DashboardPage.jsx`); `index.css` already defines oklch design tokens but they are purple-leaning; shadcn-style primitives under `src/components/ui/`.
- Settings: profile, notification toggles, SSO integrations UI (all mock — "Google connected", etc.).

**Verified working (by reading):** auth gate/redirects, dashboard table + search/date range/pagination/CSV export, create/edit/delete log flows, reports KPIs/charts/heatmap, settings tabs, theme persistence.

## 2. Technical and product deficiencies (vs. redesign prompt)

Ranked by severity.

1. **No real backend / persistence** — logs live in memory and reset on reload. Prompt requires real persistence, DB, migrations, server-side ownership (Phases 2–4).
2. **Mock authentication** — any credentials accepted; tokens in localStorage; no expiry/revocation/rate limiting. Prompt requires real auth provider, server-side authorization, no tokens in localStorage (Section 7A).
3. **No design tokens / wrong palette** — inline purple `#5B16E1` colors throughout components; prompt requires blue primary + teal active/progress, no hard-coded colors, rounded corners, WCAG AA (Section 6).
4. **No tests** — prompt requires unit/integration/E2E proportional to risk (Section 9).
5. **Missing docs** — no `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/DATA_MODEL.md` (Section 5).
6. **Time-tracking model is a single flat log** — prompt needs four distinct concepts: observation, session, attribution, outcome; plus idempotent ingestion, UTC/ingestion-time separation, overlap rules (Section 7C).
7. **Integration UI is fake** — SSO rows shown as connected without any real integration (violates "No fake functionality", Section 3).

## 3. Recommended target architecture

Keep the existing React/Vite frontend and routes where practical (prompt Section 11: preserve existing routes and working behavior). Add a managed backend only when required.

**Recommended stack:**
- Frontend: existing React 19 + Vite 7 + Tailwind 4 + React Router 7 (retained, restyled).
- Backend/DB/Auth: **Supabase** (PostgreSQL + Auth + Row Level Security + Realtime, generous free tier). Matches prompt's "lowest-cost managed option with a free tier" + "server-side authorization and ownership checks" + "real authentication system." No always-on paid infra.
- Alternative considered: self-hosted Node/Express + PostgreSQL on Render free tier. Rejected because it requires building auth, RLS-equivalent authorization, and realtime from scratch; more operational surface for a single-user personal OS.
- Desktop collector: deferred (Phase 4+); target OS undecided — current env is Linux but that may be the dev container, not the user's desktop. See open question.

**Data isolation:** design for multi-user (RLS by `user_id`), ship single-user UX (prompt default).

**Preserved routes:** `/login`, `/dashboard`, `/logs/new`, `/logs/:id/edit`, `/reports`, `/settings/*` — unchanged paths so UI screens don't need a rewrite (prompt Section 7 Extension points).

## 4. Dependency-aware implementation roadmap

Following prompt Phase 0–8 order, adapted to this repo:

| Phase | Work | Depends on |
|-------|------|------------|
| 0 | Audit & plan; baseline lint/build; create `PROGRESS.md`, `DECISIONS.md`, `DATA_MODEL.md` | — |
| 1 | UI foundation: blue/teal design tokens in `index.css`, replace inline purple, rounded components, accessibility states | existing UI primitives |
| 2 | Data & auth foundation: connect Supabase client, real auth (replace mock `AuthContext`), persistent logs via server/API or Supabase, server-side ownership, migrations | Phase 1 tokens |
| 3 | Goals, projects, tasks: connected task workflows, state machine, persistence/permissions | Phase 2 |
| 4 | Time tracking: observation/session/attribution/outcome models, manual logging, duration/overlap rules | Phase 3 (tasks) |
| 5 | Integrations: one verified adapter at a time with truthful connection states | Phase 4 |
| 6 | Notifications & workflows: persistent scheduling, delivery history, retries, approvals | Phase 4/5 |
| 7 | Analytics & AI: evidence-based reports from validated data; optional AI after data reliable | Phase 4/6 |
| 8 | Production hardening: security, a11y, recovery, responsive, build, docs | all |

**Smallest valuable change first (Phase 0 → Phase 1 slice):** Establish the blue/teal design tokens and migrate the Dashboard's inline purple to tokens, preserving all existing behavior. This is low-risk, verifiable via lint/build, and unblocks all later UI work.

## 5. Smallest valuable change — Phase 1 slice (first increment)

**Objective:** Replace hard-coded purple `#5B16E1` in `DashboardPage.jsx` and `index.css` primary/accent tokens with blue-primary/teal-active design tokens, keeping layout and behavior identical.

**Files to touch:**
- `src/index.css` — redefine `--primary` (blue) and add `--accent-active`/`--progress` (teal) tokens; keep dark/light variants.
- `src/dashboard/DashboardPage.jsx` — replace inline `#5B16E1` / `bg-[#5B16E1]` / `border-[#5B16E1]` / `text-[#5B16E1]` / `focus:border-[#5B16E1]` / `hover:bg-[#4a11c0]` with token-based classes.

**Acceptance criteria (each verifiable):**
1. `pnpm lint` passes with no new errors (baseline to be recorded).
2. `pnpm build` succeeds.
3. Dashboard renders with blue primary actions and teal active/selected states (manual visual check at `http://localhost:5173/dashboard`).
4. No route or flow broken (login → dashboard → create/edit log → reports → settings all still work).
5. No hard-coded `#5B16E1` remains in `DashboardPage.jsx`.

**Verification commands:**
```
pnpm lint
pnpm build
pnpm dev   # then manually click through login → dashboard → logs/new → reports → settings
```

## 6. Confirmed decisions

- **Backend/auth stack: Supabase** (PostgreSQL + Auth + Row Level Security, free tier). Confirmed by user. Recorded as the Phase 2 stack; matches prompt hosting default and provides server-side ownership via RLS with no always-on paid infra.
- **Collector OS: Windows WSL2** (not Linux). Confirmed by user. Relevant to Phase 4 desktop collector; current dev env is Linux but the user's primary desktop is WSL2.
- **Learning platforms:** to be specified by user. Default per prompt: manual milestones only until a verified, authorized integration exists (Section 7C). Not a blocker for Phase 0–1.

## 7. Remaining assumptions and risks

- **Assumption:** single user now, multi-user data isolation later (prompt default).
- **Assumption:** Supabase free tier is sufficient; no always-on paid infra without your approval (prompt default).
- **Risk:** no existing test baseline; adding tests is new work in Phase 0/8.
- **Risk:** replacing mock auth removes the "any credentials work" convenience — expected and required by prompt.
- **Open item:** user to name the learning platform(s) for Phase 5 integration planning.
