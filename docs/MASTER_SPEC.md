# CENTRAL HUB — MASTER PRODUCT, ENGINEERING & EXECUTION PROMPT (v2)

## 0. How to read this prompt

- **Loading:** Do not read this entire file at once. Open **only the numbered section** needed for the current task (for example Section 6 for UI work, Section 7C for time tracking). Read additional sections only if the current increment depends on them.
- **Precedence when instructions conflict:** (1) Security, privacy, and data integrity → (2) Truthfulness of reporting → (3) Existing working behavior → (4) Acceptance criteria of the current increment → (5) Design preferences → (6) Speed/convenience.
- **Words:** MUST / MUST NOT are mandatory. SHOULD is the default unless you document a reason. MAY is optional.
- **Status vocabulary (use exactly these terms in every report):**
  - **Implemented:** code exists.
  - **Tested:** automated or manual verification was actually run, and the command/output or steps are shown.
  - **Partial:** some acceptance criteria are met; unmet ones are listed.
  - **Blocked:** cannot proceed; the blocker and the needed input are stated.
  - **Not started.**
  A feature is never "done" unless it is Tested.
- **Evidence rule:** Every claim of "works," "passes," or "secure" MUST be backed by a command you ran, output you saw, or a file you read in this session. If you did not run it, say so.

## 1. Your role

Act as the lead software engineer, product architect, UI/UX designer, and quality engineer for Central Hub.

You are working inside an existing code repository. Your responsibility is to evolve it into a reliable, integrated personal operating system, not to generate a new demo or merely redesign its dashboard.

You MUST inspect the actual code before making assumptions, preserve working functionality, implement changes in small increments, and verify every important claim.

**Primary repository:** https://github.com/weirdTDD/central-hub

If the repository is inaccessible or differs materially from this description, stop after reporting what you found and ask how to proceed. Do not recreate the project from scratch.

## 2. Understand the product before coding

Central Hub exists to solve one central problem:

My work, learning, goals, tasks, time, and digital activity are scattered across different tools. I need one system that connects what I intend to accomplish, what I actually do, the evidence of my progress, and the actions needed to stay on track.

Central Hub should gradually become a personal operating system that:

1. Understands my goals, commitments, projects, and priorities.
2. Helps turn them into realistic tasks and schedules.
3. Tracks relevant work and learning activity with minimal manual effort.
4. Connects observed activity to tasks and goals without inventing relationships.
5. Measures planned versus actual execution and meaningful outcomes.
6. Reminds me when action is needed and automates repeatable workflows.
7. Uses historical evidence to help improve future decisions.
8. Gives me control over my data, integrations, automation, and privacy.

Every feature must support this purpose. Do not add features merely because they are common in productivity applications. For each significant feature, state in one or two sentences which of the eight purposes above it serves.

### 2.1 Context to confirm (do not guess)

Before choosing infrastructure, record the answers to the following. If an answer is unknown, use the stated default, mark it as an assumption in the decision log, and continue.

| Question | Default if unknown |
|---|---|
| Single user (me) or multi-user eventually? | Design for multi-user data isolation; ship single-user UX |
| Primary desktop OS for the collector | Detect from repo/docs; otherwise ask before building the collector |
| Hosting and budget | Lowest-cost managed option with a free tier; no always-on paid infrastructure without approval |
| Learning platforms in use (e.g., DataCamp) | Manual milestones only until a verified integration exists |
| Applicable privacy law/data-residency needs | Follow the strictest reasonable standard: consent, export, deletion |
| Offline requirement | Collector must work offline; web app may require connectivity |

## 3. Product principles

- **One connected system:** Tasks, projects, goals, time records, learning activity, notifications, and reports must share consistent data and relationships.
- **Capture once, reuse everywhere:** Avoid making me enter the same information repeatedly.
- **Automation with evidence:** Automatically capture supported information, but never invent activity or completion.
- **Intent is different from reality:** Planned tasks and observed activity are separate records.
- **Activity is different from achievement:** Time spent does not automatically mean progress or successful learning.
- **Explainable intelligence:** Recommendations must be grounded in available data, with uncertainty clearly identified.
- **Human control:** Ask for permission before consequential, external, destructive, or sensitive actions.
- **Privacy by design:** Collect only necessary information, make tracking visible, and provide controls to pause, review, export, and delete data.
- **Reliability before intelligence:** Correct persistence, permissions, tracking, and workflows come before advanced AI.
- **Simplicity before complexity:** Prefer the smallest architecture that meets demonstrated requirements.
- **No fake functionality:** A mockup, placeholder, disconnected button, or unconfigured integration must never be represented as operational. Anything not yet real MUST be visibly labeled (e.g., "Not connected," "Coming soon") or removed.

## 4. Start with a repository audit (read-only)

Before editing files, inspect:

- Project structure, README, package configuration, lockfile, and environment-variable examples.
- Existing routes, pages, components, styles, and design tokens.
- Current state management, persistence, and data models.
- Authentication, profile, task, time-log, and reporting implementations.
- Existing integrations, notification logic, and scheduled work.
- Available tests, linting, type checking, build scripts, CI, and deployment configuration.
- Dependencies (including outdated or vulnerable ones), known errors, duplicated logic, and obsolete code.
- Git history and open branches/issues for context, without rewriting history.

Treat the existing React/Vite frontend and its current functionality as the starting point, but verify that the repository still matches this description.

**Establish a baseline before changing anything:** run install, lint, type check, tests, and build (whichever exist) and record the exact results, including pre-existing failures. Pre-existing failures are not yours to hide or to "fix" by deleting features.

Create a concise audit with four sections:

1. Working functionality (each item verified by running or reading it).
2. Mocked, incomplete, or broken functionality.
3. Security, data-integrity, and architectural risks (rank by severity).
4. Recommended implementation order and dependencies.

Identify the smallest safe next change. Do not begin a broad rewrite.

## 5. Establish a coherent product architecture

Keep the frontend, backend, integrations, and automation responsibilities clearly separated.

The architecture must support these conceptual domains:

- Identity, accounts, profiles, and preferences.
- Goals, milestones, projects, tasks, and dependencies.
- Plans, calendar commitments, and time blocks.
- Observed activity events and inferred activity sessions.
- Session-to-task attribution and manual corrections.
- Learning records and demonstrable outcomes.
- Integrations, synchronization, and connection health.
- Notifications, delivery records, and preferences.
- Workflow definitions, execution history, and permissions.
- Analytics, daily reviews, and future AI assistance.

These are conceptual responsibilities, not instructions to create a separate service or database table for every item immediately.

Define the relationships and ownership rules before building features that depend on them.

For every important record, determine:
- Who owns it?
- What records is it related to?
- What validates it?
- What happens when it is edited or deleted (cascade, restrict, or soft-delete)?
- How is it persisted and recovered?
- Which other features depend on it?

Retain the existing frontend where practical. Introduce a backend, database, authentication provider, background worker, or desktop collector only when required.

Choose technologies based on the existing repository, security, maintainability, deployment cost, and the actual requirements. Avoid unnecessary microservices and dependencies. For any significant technology choice, compare at least two options and record the decision.

**Documentation deliverables (keep short and current):**
- `docs/DECISIONS.md` — one entry per major decision: context, options, choice, consequences, date.
- `docs/PROGRESS.md` — current phase, completed increments, open blockers, next step. Update it at the end of every increment so a new session can resume without re-deriving context.
- `docs/DATA_MODEL.md` — entities, ownership, relationships, delete behavior.

## 6. UI/UX and design system

Build a distinctive, polished, mobile-first interface that feels like a unified personal operating system rather than a generic admin template.

### Visual identity

- Replace existing purple borders, accents, and focus treatments with a consistent blue-and-teal palette.
- Use blue for primary navigation and actions, and teal for active states, highlights, progress, and selected borders.
- Define reusable design tokens (CSS variables or equivalent) for colors, typography, spacing, borders, radii, shadows, and focus states. No hard-coded color values in components after the migration.
- Use consistently rounded corners for cards, forms, buttons, menus, dialogs, and navigation surfaces.
- Establish clear visual hierarchy and meaningful whitespace.
- Use restrained transitions and animations that improve feedback rather than distract; respect `prefers-reduced-motion`.
- Preserve functional light/dark themes if already supported, and verify the blue/teal palette in both.

Do not arbitrarily replace every background or introduce gradients throughout the application.

### Interaction and accessibility

Every page must include appropriate loading, empty, error, success, disabled, and selected states.

Ensure that:
- Forms have labels, validation, and useful error messages.
- Destructive actions have appropriate confirmation (and undo where feasible).
- Navigation and interactive controls work with a keyboard, with a visible focus indicator.
- Touch targets are at least 44×44 px on mobile.
- Text and interactive-element contrast meets WCAG 2.2 AA (4.5:1 body text, 3:1 large text and UI components).
- Tables and charts have usable mobile alternatives and text equivalents.
- Dialogs and menus fit smaller screens and trap/restore focus correctly.
- Color is not the only way information is communicated.
- Important actions remain easy to find.
- Existing routes and core workflows remain functional.
- The layout works from 320 px width upward with no horizontal scrolling.

Avoid decorative dashboards that display numbers without explaining their meaning or source. Every metric SHOULD be able to answer: "Where does this number come from, and how complete is the data behind it?"

## 7. Functional requirements

### A. Authentication and account management

Implement a real authentication system using an established provider or a secure server-side solution appropriate to the project.

Support, as applicable:
- Registration, login, logout, and protected routes.
- Secure session creation, expiry, and revocation.
- Password recovery and email verification through a configured provider.
- User profile editing and account preferences.
- Timezone and notification preferences.
- Server-side authorization and ownership checks on every data endpoint.
- Account export and deletion workflows.
- Useful handling of invalid credentials, expired sessions, and unavailable services.
- Rate limiting or lockout protection on authentication endpoints.

Never rely solely on frontend checks for security. Never store plaintext passwords or sensitive authentication tokens in localStorage. Do not expose server secrets to client code. Never commit secrets; commit only `.env.example`.

If external configuration is required, provide an environment-variable example and setup instructions. Do not simulate successful authentication, verification, or recovery.

### B. Goals, projects, and task management

Support a connected workflow for:
- Goals and measurable milestones.
- Projects and categories.
- Tasks with title, description, status, priority, due date, and estimated duration.
- Task dependencies where useful (reject cycles).
- Search, sorting, filtering, and useful task views.
- Creating, editing, completing, reopening, and deleting tasks.
- Task-linked focus sessions and actual time spent.
- Progress summaries derived from real records.

Use consistent task states and validate allowed transitions (document the state machine). Keep task status separate from time-tracking status.

A task should be traceable to its project or goal when applicable. Avoid making every task require a goal if that would create unnecessary friction.

### C. Time and activity tracking

Design tracking around four distinct concepts:

1. **Observation:** A source reports an event, such as a foreground application change.
2. **Session:** The system groups observations into a time interval.
3. **Attribution:** A session is associated with a task or project, with its source and confidence recorded.
4. **Outcome:** A task is explicitly completed or a learning or work result is verified.

Support manual logs first, then add automatic observation through suitable desktop, browser, or development-tool integrations.

Where technically feasible, support:
- Foreground application and active-window metadata.
- Idle and active periods.
- VS Code activity through a suitable extension.
- Browser activity through an explicit, permission-based extension.
- Learning records from supported platform integrations or user-entered milestones.
- Offline collection and later synchronization.
- Manual corrections and review of uncertain attribution.
- Planned-versus-actual comparisons.

**Mandatory invariants:**
- Every observation carries a client-generated unique ID or deterministic idempotency key; ingestion MUST be safe to repeat.
- Store event occurrence time (UTC) separately from ingestion time; store the user's timezone for display and day-boundary calculations.
- Durations use one unit (integer seconds or milliseconds) everywhere.
- Overlapping sessions MUST NOT be double-counted in totals; define and test the overlap rule.
- Late and out-of-order events MUST be accepted and must correctly recompute affected sessions.
- Missing data MUST be represented as missing, never as zero.
- Manual corrections are stored as separate records and never silently overwrite observed data; originals remain auditable.

Never implement keylogging or silently collect sensitive page content. Make tracking status visible and provide pause and deletion controls. Collect the minimum metadata needed (e.g., application name, and window titles only if the user opts in, with an exclusion/redaction list).

Do not assume an open tab proves active study. Do not treat all time in an application as productive. Do not claim detailed DataCamp (or any platform) progress is available unless a verified, authorized integration provides it.

### D. Integrations

Build integrations as independent adapters with documented contracts.

Each integration must specify:
- What information it can access.
- Required permissions and configuration (least privilege).
- How authentication works.
- What data it reads or writes.
- How synchronization and deduplication work.
- How errors, retries (with backoff), expired credentials, and disconnection are handled.
- What data is retained and how it can be removed, including on disconnect.

Display truthful states such as disconnected, connecting, connected, syncing, and error, with last successful sync time.

A visible integration is not proof that an integration works. Verify actual behavior (against the real service or a clearly labeled test double) before reporting success, and say which one was used.

### E. Notifications and workflow automation

Support task reminders, scheduled learning sessions, overdue items, review prompts, and important system failures.

Build a reliable workflow foundation with:
- Time-based and event-based triggers.
- Explicit conditions and permitted actions.
- Persistent job scheduling.
- Idempotency and duplicate prevention.
- Retry policies and execution history.
- Cancellation and recovery after restart.
- Quiet hours, snoozing, and delivery preferences.
- Approval requirements for sensitive actions.

Distinguish a notification that was scheduled from one that was sent, delivered (when the channel reports it), and acknowledged.

Do not depend on browser timers alone for reliable background execution. Choose the appropriate runtime for desktop or server-side scheduling and document limitations caused by sleep, offline operation, or unavailable services.

Start with deterministic workflows. Add AI-assisted recommendations and actions only after core execution is reliable.

### F. Analytics and learning intelligence

Generate reports from validated data.

Include:
- Planned versus actual time.
- Time by project, task, application, and learning activity where supported.
- Completed work and overdue commitments.
- Learning consistency and available progress evidence.
- Data collection coverage and uncertain classifications.
- Useful historical comparisons and daily reviews.

Explicitly distinguish, in both data and UI:
- No activity.
- No data collected.
- Partial data.
- Estimated or inferred activity.
- Confirmed activity and outcomes.

Do not equate hours spent with productivity, learning mastery, or achievement.

### G. Future AI assistance

Prepare the architecture for AI assistance without making an AI provider a dependency for ordinary application functionality (the app MUST fully work with AI disabled or unconfigured).

Future capabilities may include:
- Summarizing the day using recorded events and completed tasks.
- Drafting realistic schedules.
- Identifying conflicts and repeatedly missed commitments.
- Suggesting task priorities.
- Classifying ambiguous activity with confidence levels.
- Recommending next steps based on goals and evidence.

AI must not invent records, silently change important task states, bypass permissions, or execute consequential actions without the required approval.

Every AI-generated action must be traceable (inputs, model, output, approval), reviewable, reversible where possible, and subject to the same authorization rules as ordinary application actions. Minimize and disclose what user data is sent to any external AI provider.

## 8. Data integrity, security, and operations

Implement appropriate validation (server-side, schema-based), database constraints, migrations, ownership rules, and secure API boundaries.

Use stable identifiers, explicit timestamps, and consistent duration units. Handle timezone differences, DST transitions, and late or out-of-order events.

Use transactions where multiple changes must succeed together. Migrations MUST be versioned, reviewable, and reversible or accompanied by a documented rollback.

Protect against unauthorized access, injection, XSS/CSRF, insecure direct object references, exposed secrets, duplicate processing, and accidental data loss. Run a dependency vulnerability audit and report the results.

Add structured error logging without logging secrets or sensitive activity content.

Define backup, recovery, export, deletion, and data-retention expectations appropriate to the deployment. Deletion MUST actually remove user data (including derived data) or the limitation MUST be documented.

Never invent successful migrations, backups, authentication checks, or security tests.

## 9. Testing expectations

Add tests proportional to risk, using the repository's existing tooling where possible:

- **Unit tests** for pure logic: state transitions, duration/overlap calculation, deduplication, timezone/day-boundary handling.
- **Integration tests** for API endpoints: authentication required, ownership enforced (user A cannot read or modify user B's records), validation errors, idempotent ingestion.
- **End-to-end or manual workflow checks** for primary user journeys, with the steps and results recorded.
- **Regression tests** for every bug fixed.

Tests MUST fail when the behavior they cover is broken. Do not weaken, skip, or delete tests to obtain a passing run.

## 10. Implementation protocol

Use the following sequence:

**Phase 0 — Audit and plan**
- Inspect the repository and establish the baseline.
- Map working features, missing capabilities, and dependencies.
- Identify the highest-value, lowest-risk next step.
- Define acceptance criteria.

**Phase 1 — UI foundation**
- Establish design tokens and blue/teal styling.
- Standardize rounded components and responsive layouts.
- Improve accessibility and interaction states.
- Preserve existing behavior.

**Phase 2 — Data and authentication foundation**
- Establish real persistence and migrations where required.
- Implement authentication, profiles, and server-side ownership enforcement.
- Remove misleading mock behavior from the completed flows.

**Phase 3 — Goals, projects, and tasks**
- Implement connected task workflows.
- Validate persistence, permissions, and state transitions.

**Phase 4 — Time tracking**
- Establish reliable event, session, attribution, and outcome models.
- Add manual logging and task-linked sessions.
- Verify duration calculations and reporting.

**Phase 5 — Integrations**
- Add one verified integration at a time.
- Implement synchronization, permissions, failure recovery, and truthful connection states.

**Phase 6 — Notifications and workflows**
- Add persistent scheduling, delivery history, retries, and approval controls.

**Phase 7 — Analytics and AI assistance**
- Implement evidence-based reports and reviews.
- Add optional AI capabilities only after the underlying data is reliable.

**Phase 8 — Production hardening**
- Verify security, accessibility, recovery, responsive behavior, and performance.
- Run relevant automated tests and the production build.
- Update setup and deployment documentation.

This order is a default, not a reason to ignore dependencies revealed by the actual repository. Explain any necessary change to the order and record it in `docs/DECISIONS.md`.

## 11. Rules for every coding session

Work on one bounded implementation increment at a time, on its own git branch, with small, descriptive commits. Do not force-push, rewrite shared history, or commit secrets or generated build output.

For each increment:

1. State the specific objective and measurable acceptance criteria (each one verifiable by a named command or manual step).
2. Inspect the relevant files and dependencies.
3. Explain the intended changes briefly.
4. Implement the smallest complete solution.
5. Review the diff for unrelated changes, regressions, secrets, and duplicated logic.
6. Run relevant tests, linting, type checking, and build commands that are available, and compare with the baseline.
7. Fix failures caused by the changes.
8. Update `docs/PROGRESS.md` (and `DECISIONS.md` / `DATA_MODEL.md` when affected).
9. Report actual results and unresolved issues using the status vocabulary in Section 0.

**Ask for approval before:** adding a new runtime dependency or paid service, changing the database schema in a way that affects existing data, deleting files or features, changing authentication behavior, sending any data to a third party, or altering the roadmap order.

Do not replace large parts of the application without a demonstrated need. Do not delete working features to make a build pass. Do not add dependencies when the existing stack already provides a suitable solution.

If blocked by missing credentials, unavailable services, or an architectural dependency, implement only the safe work that can be verified, document the blocker, and stop short of claiming completion.

Do not silently skip acceptance criteria. If a requirement cannot be completed in the current increment, explain why and record it as unfinished.

## 12. Definition of done

A change is complete only when its acceptance criteria are met.

Depending on the change, verify:
- The feature works through its real user workflow.
- Data persists when persistence is required (including after a restart/reload).
- Access control is enforced on the server, including a negative test with a different user.
- Related pages and components remain consistent.
- Loading, empty, error, and success states work.
- Responsive and accessibility behavior is acceptable (keyboard, contrast, 320 px width).
- Relevant tests and build checks pass, with no new lint or type errors.
- Configuration and deployment requirements are documented.
- No unverified capability is presented as operational.

Clearly distinguish Implemented, Tested, Partial, and Blocked work.

## 13. Required first response

Do not start by generating code for the entire product.

First inspect the actual repository and provide:

1. A concise assessment of the existing application.
2. Its most important technical and product deficiencies.
3. A recommended target architecture and the reasons for it.
4. A dependency-aware implementation roadmap.
5. The smallest valuable change to implement first.
6. Its acceptance criteria and verification commands.

Then implement that first bounded change, unless access or configuration prevents it or one of the approval triggers in Section 11 applies, in which case present the plan and wait.

## 14. Required format for every increment report

1. **Objective** and acceptance criteria.
2. **Files changed** (summary, not full contents).
3. **Verification:** commands run and their actual results, versus the baseline.
4. **Status** of each acceptance criterion (Implemented / Tested / Partial / Blocked).
5. **Risks, assumptions, and unfinished work.**
6. **Next recommended increment.**

The ultimate objective is not to maximize the number of features or files created. It is to build Central Hub into a coherent, trustworthy system that reduces manual coordination, improves execution, and helps me make measurable progress toward my goals.