-- Sentral Hub — coding activity from Cursor and VS Code
-- Date: 2026-10-22
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- The coding tracker writes heartbeats as observations. These columns describe
-- a heartbeat without putting a file path or a window title on the row:
--
--   activity_kind  'coding' for this collector. NULL on every older observation.
--                  Later activity sources add a value here with a new migration;
--                  this check lists only the kind that exists.
--   editor         'cursor' or 'vscode'. NULL when the row is not from an editor.
--   project_name   the workspace folder's name, never a path.
--   language       the editor language id, e.g. 'javascript'.
--   file_name      the file's name, never a path.
--
-- Heartbeats stay observations (source = 'collector'). They are NOT copied into
-- sessions. Sessions are the attributed work stream; coding time is observed
-- editor activity. The timeline groups heartbeats in the app. Putting both in
-- one total would count the same hour twice when a person also logs a session.
--
-- Requires public.observations (Phase 4). Idempotent.
--
-- Rollback:
--   drop index if exists public.observations_user_coding_occurred_idx;
--   alter table public.observations drop constraint if exists observations_language_label;
--   alter table public.observations drop constraint if exists observations_project_name_label;
--   alter table public.observations drop constraint if exists observations_file_name_basename;
--   alter table public.observations drop constraint if exists observations_editor_valid;
--   alter table public.observations drop constraint if exists observations_activity_kind_valid;
--   alter table public.observations
--     drop column if exists file_name,
--     drop column if exists language,
--     drop column if exists project_name,
--     drop column if exists editor,
--     drop column if exists activity_kind;

begin;

do $$
begin
  if to_regclass('public.observations') is null then
    raise exception
      'public.observations does not exist. Apply supabase/migrations/20261020100000_time_tracking_phase4.sql before this migration.';
  end if;
end
$$;

alter table public.observations add column if not exists activity_kind text;
alter table public.observations add column if not exists editor text;
alter table public.observations add column if not exists project_name text;
alter table public.observations add column if not exists language text;
alter table public.observations add column if not exists file_name text;

alter table public.observations drop constraint if exists observations_activity_kind_valid;
alter table public.observations
  add constraint observations_activity_kind_valid
  check (activity_kind is null or activity_kind in ('coding'));

alter table public.observations drop constraint if exists observations_editor_valid;
alter table public.observations
  add constraint observations_editor_valid
  check (editor is null or editor in ('cursor', 'vscode'));

alter table public.observations drop constraint if exists observations_file_name_basename;
alter table public.observations
  add constraint observations_file_name_basename
  check (
    file_name is null
    or (
      char_length(file_name) between 1 and 255
      and file_name !~ '[\\/]'
      and position('..' in file_name) = 0
    )
  );

alter table public.observations drop constraint if exists observations_project_name_label;
alter table public.observations
  add constraint observations_project_name_label
  check (
    project_name is null
    or (
      char_length(project_name) between 1 and 255
      and project_name !~ '[\\/]'
      and position('..' in project_name) = 0
    )
  );

alter table public.observations drop constraint if exists observations_language_label;
alter table public.observations
  add constraint observations_language_label
  check (
    language is null
    or (
      char_length(language) between 1 and 64
      and language !~ '[\\/]'
    )
  );

create index if not exists observations_user_coding_occurred_idx
  on public.observations (user_id, occurred_at desc)
  where activity_kind = 'coding';

comment on column public.observations.activity_kind is
  'Which activity stream produced the row. NULL means an observation from before coding tracking, or a row that is not coding. ''coding'' is a Cursor/VS Code heartbeat. Missing is NULL, never a fake kind.';
comment on column public.observations.editor is
  'cursor or vscode when activity_kind = coding. NULL on every other observation.';
comment on column public.observations.project_name is
  'Workspace folder name only. Full paths are not stored.';
comment on column public.observations.file_name is
  'File name only. Full paths are not stored.';
comment on column public.observations.language is
  'Editor language id, such as javascript. Not a file path.';

commit;
