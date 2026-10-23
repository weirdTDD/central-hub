# Sentral Hub

A personal operating system that connects your goals, tasks, time tracking, learning, reminders, and reports.

## Overview

Sentral Hub helps you see the gap between what you intend and what you actually do. It connects planned tasks and observed activity as separate records, so your recorded time is always grounded in evidence — never invented.

- **Goals, projects, tasks** — plan with a validated state machine and priority levels
- **Time tracking** — manual sessions plus optional desktop activity observations, with overlap-safe durations and auditable corrections
- **Integrations** — independent adapters with documented contracts and truthful connection states
- **Notifications & workflows** — persistent scheduling, event triggers, retries, and approvals
- **Reports** — planned versus actual, data coverage, and daily reviews from real records

## Quick start

```bash
pnpm install
pnpm dev
```

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Then fill in your Supabase URL and anon key. See [docs/TECHNICAL.md](docs/TECHNICAL.md) for the full setup guide.

## Stack

- **Frontend:** React 19, Vite 7, Tailwind CSS 4, React Router 7, Radix UI primitives
- **Backend:** Supabase (PostgreSQL + Auth + Row Level Security + Realtime)
- **Design:** blue primary, teal for active/selected/progress, rounded corners, mobile-first

## Documentation

- [Master spec](docs/MASTER_SPEC.md) — product, engineering, and execution prompt
- [Technical reference](docs/TECHNICAL.md) — architecture, modules, data flow, changelog
- [Data model](docs/DATA_MODEL.md) — entities, ownership, relationships, delete behavior
- [Decisions](docs/DECISIONS.md) — decision log
- [Progress log](docs/PROGRESS.md) — current phase and completed increments

## License

UNLICENSED — personal project.
