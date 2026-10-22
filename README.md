# DailyLogs

DailyLogs is a React productivity app for logging daily work, reviewing team activity, and managing profile preferences. It covers authentication, a work-log dashboard, create/edit flows, productivity reports, and settings.

## Features

- **Sign in / Sign up** — mock BST account auth with Google continue, session persistence, and protected routes
- **Dashboard** — searchable work-log table with date filters, dense mode, pagination, and CSV export
- **Log entries** — create and edit task logs (task, date, time spent, notes), including delete on edit
- **Reports** — productivity KPIs, activity heatmap, charts, and top logged tasks
- **Settings** — profile details, appearance theme (light / dark / system), notification toggles, and SSO integrations UI

## Stack

- React 19 + Vite 7
- React Router 7
- Tailwind CSS 4
- Recharts + ECharts
- Radix UI primitives
- date-fns + react-day-picker
- pnpm

## Quick start

```bash
pnpm install
pnpm approve-builds   # allow esbuild scripts if pnpm prompts
pnpm dev
```

App runs at [http://localhost:5173](http://localhost:5173).

### Other scripts

| Command        | Description              |
|----------------|--------------------------|
| `pnpm build`   | Production build         |
| `pnpm preview` | Preview production build |
| `pnpm lint`    | Run ESLint               |

## Auth

Sign-in uses Supabase Auth. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then restart `pnpm dev`. Without those values the app shows **Not connected** and does not invent a session.

Apply the SQL migrations in `supabase/migrations/` before using stored data. Order matters; `docs/TECHNICAL.md` lists it. The coding tracker also needs `supabase/migrations/20261022140000_coding_activity.sql`.

## Coding time (Cursor and VS Code)

One extension records **active** coding time in both editors. Cursor is stored as Cursor; Visual Studio Code (and other VS Code-compatible hosts) is stored as VS Code. It does not read file contents, full paths, window titles, or keystrokes. Time is the span between activity in the editor (edits, cursor movement, switching files). Idle time, and time while the window is in the background, is not counted.

Heartbeats are observations on your account (`activity_kind = coding`). The Coding page groups them into sessions by project and editor. They are **not** added to manual sessions or work logs, so the same hour is not counted twice.

### 1. Database

In the Supabase SQL editor, run `supabase/migrations/20261022140000_coding_activity.sql` after the earlier migrations (at least the time-tracking migration that creates `public.observations`). Then reload the API schema:

```sql
NOTIFY pgrst, 'reload schema';
```

### 2. Install the extension

The extension has no npm dependencies. From the repo root, link it into the editor's extensions folder (use the Cursor command if `cursor` is on your PATH, otherwise `code`):

```bash
# Cursor
mkdir -p "$HOME/.cursor/extensions"
ln -sfn "$PWD/extensions/coding-tracker" "$HOME/.cursor/extensions/central-hub.central-hub-coding-tracker-0.1.0"

# VS Code
mkdir -p "$HOME/.vscode/extensions"
ln -sfn "$PWD/extensions/coding-tracker" "$HOME/.vscode/extensions/central-hub.central-hub-coding-tracker-0.1.0"
```

On Windows the folders are `%USERPROFILE%\.cursor\extensions` and `%USERPROFILE%\.vscode\extensions`. Quit and reopen the editor after linking.

You can also package a `.vsix` and install that:

```bash
cd extensions/coding-tracker
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
cursor --install-extension central-hub-coding-tracker-0.1.0.vsix
code --install-extension central-hub-coding-tracker-0.1.0.vsix
```

### 3. Connect it

1. Open the command palette and run **Central Hub: Sign In**.
2. Enter the same Supabase URL and anon key as in `.env`. The anon key is the public project key, not the service-role key.
3. Enter the email and password of your Central Hub account. The password is used once and is not stored. A refresh token is kept in the editor's secret storage.
4. The status bar shows **Central Hub** while tracking is on. **Central Hub: Pause Tracking** and **Central Hub: Resume Tracking** are in the command palette. **Central Hub: Sign Out** stops sending; heartbeats still queued on that computer stay there until you sign in again.

The extension works offline: heartbeats queue on the computer and send when it can reach Supabase. Sending the same heartbeat again does not create a duplicate.

### 4. See it in the app

| Place | What you get |
|-------|----------------|
| `/coding` | The day's sessions by project and editor, plus the day's and week's totals. Delete removes that day's heartbeats. |
| `/dashboard` | A Coding card for the selected day. It is not mixed into the recorded-session total. |
| `/reports` | Coding time for the report range, by project and editor. |
| `/settings/integrations` | Connected, syncing, or error, the last time heartbeats were sent, and these setup steps. |
| `/integrations` | The same connection, and Disconnect (that deletes the heartbeats this connection stored). |

If the tracker has never signed in, the settings card says **Not connected**. It does not show a connected state on its own.

## Learning time (browser)

A browser extension records **active** time on learning sites you choose. The default, until you save your own list, is freeCodeCamp's curriculum (`freecodecamp.org/learn`). Time counts only while the browser window is focused and you are active. Idle time, time in another window, and every site that is not on the list are not counted. The address and the query string are not stored. On freeCodeCamp the course and the lesson are read from the page path. On other sites the page title is kept when it is not itself a URL.

Heartbeats are observations on your account (`activity_kind = learning`). The Learning page groups them into sessions by site and course. They are **not** added to coding time, manual sessions, or work logs.

### 1. Database

In the Supabase SQL editor, run `supabase/migrations/20261022150000_learning_activity.sql` after the coding migration (`20261022140000_coding_activity.sql`). Then reload the API schema:

```sql
NOTIFY pgrst, 'reload schema';
```

### 2. Load the extension

The extension has no npm dependencies. Chrome and Edge use a service worker. Firefox 121 or newer uses the same file as an event page.

Chrome or Edge:

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the `extensions/learning-tracker` folder.

Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select `extensions/learning-tracker/manifest.json`.
3. A temporary add-on is removed when Firefox quits. Load it again after a restart.

### 3. Connect it

1. Open the extension's options page (**Sites and sign-in** in the toolbar popup).
2. Enter the same Supabase URL and anon key as in `.env`. The anon key is the public project key, not the service-role key.
3. Enter the email and password of your Central Hub account. The password is used once and is not stored. A refresh token is kept in the extension's storage.
4. The popup shows the site it is tracking, or **Not on a tracked site**. **Pause** stops the clock. **Sign out** stops sending; heartbeats still queued in the browser stay there until you sign in again.

The extension works offline: heartbeats queue on the computer and send when it can reach Supabase. Sending the same heartbeat again does not create a duplicate.

### 4. Choose sites and see the time

| Place | What you get |
|-------|----------------|
| `/learning` | The day's sessions by site and course, the day's and week's totals, each day of the week, and the tracked-sites list. Delete removes that day's heartbeats. |
| `/dashboard` | A Learning card for the selected day. It is not mixed into coding time or the recorded-session total. |
| `/reports` | Learning time for the report range, by site and course. |
| `/settings/integrations` | Connected, syncing, or error, the last time heartbeats were sent, the tracked sites, and these setup steps. |
| `/integrations` | The same connection, and Disconnect (that deletes the heartbeats this connection stored). |

Add a site as a host (`javascript.info`), a host and path (`freecodecamp.org/learn`), or subdomains (`*.example.com`). `www` is included with the host. Query strings are not part of a pattern. The extension options page edits the same list. The last save wins.

If the tracker has never signed in, the settings card says **Not connected**. Saving a site list creates the connection row; the extension still has to sign in before heartbeats are sent.

## Grok chat and task reminders

Grok (xAI) answers inside Central Hub. The API key stays on the server: the browser calls the `grok-chat` Edge Function, and that function holds `XAI_API_KEY`. Chats are saved on your account. When you ask about your time, the function reads your own tasks, work logs, coding totals, and learning totals. It does not send your email, file paths, page addresses, or window titles.

You can set a reminder on a task from `/grok`, from `/notifications`, or by asking in the chat ("remind me at 6pm to finish the freeCodeCamp section"). A reminder needs a task that already exists. It has a due time and can repeat daily, weekly, or on weekdays. When it is due it is written to the in-app inbox. If you allow browser notifications in Settings → Notification, this device shows the same reminder. Opening the app delivers a reminder that came due while the tab was closed. A computer that is off cannot show it until Central Hub is open again. Quiet hours, set on the Notifications page, hold the popup back.

The chat works only after the steps below. The rest of the app works without them. Settings → Integrations shows **Not connected** until the function answers.

### 1. Database

In the Supabase SQL editor, run `supabase/migrations/20261022160000_grok_chat_alerts.sql` after the tasks migration (`20261020091000_tasks_phase3.sql`). Delivery also needs the notifications migration (`20261020120000_notifications_workflows_phase6.sql`). Then reload the API schema:

```sql
NOTIFY pgrst, 'reload schema';
```

### 2. Key and function

Create a key in the [xAI console](https://console.x.ai/). From the repo, with the Supabase CLI logged in to this project:

```bash
supabase secrets set XAI_API_KEY=your-key
supabase secrets set XAI_CHAT_MODEL=grok-4.7   # optional; grok-4.7 is the default
supabase functions deploy grok-chat
```

`XAI_CHAT_MODEL` overrides the chat model. If it is unset, the function uses `XAI_MODEL` (the same secret as the older Ask function) and otherwise `grok-4.7`. The chat picker can choose Grok 4.7, 4.6, 4.5, 4.3, or 4. Do not put the key in `.env` or in any `VITE_` variable.

### 3. Use it

| Place | What you get |
|-------|----------------|
| `/grok` | Saved chats, a streaming reply, and the reminder form. |
| Every signed-in page | A Grok button that opens the same chat. |
| `/notifications` | The same reminders, next to workflows. |
| `/settings/notifications` | Turn inbox reminders off, or allow browser notifications on this device. |
| `/settings/integrations` | Connected, or the reason it is not, plus these steps. |

A reminder set in chat is marked **Set by Grok**. Deleting it does not delete the task.

## Main routes

| Path | Description |
|------|-------------|
| `/login` | Sign in |
| `/dashboard` | The day: plan, journal, coding time, and learning time |
| `/coding` | Coding timeline |
| `/learning` | Learning time on the sites you track |
| `/tracking` | Recorded sessions |
| `/logs` | Work logs |
| `/logs/new` | Create a log entry |
| `/logs/:id/edit` | Edit or delete a log entry |
| `/tasks` | Tasks |
| `/reports` | Productivity report |
| `/integrations` | Connectors |
| `/notifications` | Reminders and workflows |
| `/ask` | Questions over your records |
| `/grok` | Grok chat, saved history, and task reminders |
| `/settings` | Profile |
| `/settings/notifications` | Notification prefs |
| `/settings/integrations` | Connectors, including Grok, the coding tracker, and the learning tracker |

## Project layout

```text
src/
  auth/          Sign-in flow + route guards
  dashboard/     Day view
  features/coding/  Coding timeline, dashboard card, report panel
  features/grok/    Grok chat, reminders, and the rules both sides share
  logs/          Work log screens
  report/        Reports, sidebar, charts
  settings/      Profile, notifications, integrations
  routes/        App routing
extensions/coding-tracker/   Cursor and VS Code extension
extensions/learning-tracker/ Browser extension for allowlisted learning sites
supabase/migrations/         Database migrations, including coding, learning, and Grok
supabase/functions/grok-chat/  Edge Function that holds the xAI key and streams chat
```

## Docs

See [docs/TECHNICAL.md](docs/TECHNICAL.md) for architecture details, module notes, and a changelog of what was added or changed in this workstream.

## License

Private project (`activity_app`).
