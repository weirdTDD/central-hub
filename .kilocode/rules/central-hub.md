# Sentral Hub — Agent Rules (read every session)

Project: personal operating system connecting goals, tasks, time tracking, learning, reminders and reports. Repo: weirdTDD/central-hub (React/Vite frontend). Full spec: `docs/MASTER_SPEC.md` (read ONLY the section relevant to the current task). Memory between sessions: `docs/PROGRESS.md`.

## Start of every session
1. Read this file and `docs/PROGRESS.md`.
2. Do ONLY the task I give you. Do not start other roadmap items.
3. Plan first: list the files you will touch and your acceptance criteria. Wait for my "go" before editing.

## Honesty rules (most important)
- Never claim something works, passes, or is secure unless you ran it in this session and can show the command output.
- If you did not run it, write "NOT VERIFIED".
- Never invent APIs, packages, functions, files, or config. If unsure something exists, inspect the code or installed package first. If you can't verify, say so.
- Never present a mock, placeholder, or unconfigured integration as working. Label it "Not connected" in the UI.
- Never invent user activity, completion, or data.
- If you are unsure or blocked, STOP and ask. Do not guess.

## Scope rules
- One small increment per session. Keep the diff small enough to review in 10 minutes.
- Do not rewrite or restructure large parts of the app.
- Do not delete working features, tests, or files to make a build pass. Do not weaken or skip tests.
- Do not add dependencies, change the DB schema, change auth behavior, or send data to third parties without asking me first.
- Preserve existing routes and working behavior.
- Do not touch unrelated files.

## Security rules
- Authorization and ownership checks happen on the server, never only in the frontend.
- Never store passwords or auth tokens in localStorage. Never commit secrets. Use `.env.example` only.
- Validate all input on the server.
- No keylogging or silent collection. Tracking must be visible, pausable and deletable.

## Product rules
- Planned tasks and observed activity are separate records.
- Time spent is not achievement. Missing data is "no data", never zero.
- Store times in UTC; durations in one unit (seconds). Ingestion must be idempotent.
- Design: blue primary, teal for active/selected/progress, rounded corners, design tokens (no hard-coded colors), keyboard accessible, mobile-first (works at 320px), visible loading/empty/error states.

## Before you say "done"
Run whichever exist: lint, type check, tests, build. Paste the real output. Compare to the baseline in `docs/PROGRESS.md`.

## End of every session
Update `docs/PROGRESS.md` with: what changed, status of each acceptance criterion (Implemented / Tested / Partial / Blocked), open issues, next suggested step. Then give me a report in this format:
1. Objective and acceptance criteria
2. Files changed
3. Commands run and their actual output
4. Status per criterion
5. Risks and unfinished work
6. Next recommended step
