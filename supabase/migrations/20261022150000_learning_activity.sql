-- Central Hub — learning activity from the browser extension
-- Date: 2026-10-22
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- The learning tracker writes heartbeats as observations. These columns describe
-- a heartbeat without storing the page URL:
--
--   activity_kind  'learning' for this collector. 'coding' stays allowed.
--                  NULL is every observation that is neither.
--   site_host      the allowlist host, such as freecodecamp.org. Not a URL.
--   page_title     the page title when it is safe to keep. NULL when the title
--                  was a URL or carried a token. Not the address bar.
--   course_label   course name when the page shape is known (freeCodeCamp).
--   lesson_label   lesson or page name. Not a path.
--
-- Heartbeats stay observations (source = 'collector'). They are NOT copied into
-- sessions, and they are not coding heartbeats. The timeline groups them in
-- the app. Adding them to session totals or to coding totals would count the
-- same hour twice when a person also logs that work.
--
-- Requires public.observations (Phase 4). Idempotent. Apply after
-- 20261022140000_coding_activity.sql when that file is in use: this migration
-- widens activity_kind, and the coding migration will not narrow it again.
--
-- Rollback:
--   drop index if exists public.observations_user_learning_occurred_idx;
--   alter table public.observations drop constraint if exists observations_lesson_label_valid;
--   alter table public.observations drop constraint if exists observations_course_label_valid;
--   alter table public.observations drop constraint if exists observations_page_title_valid;
--   alter table public.observations drop constraint if exists observations_site_host_valid;
--   alter table public.observations drop constraint if exists observations_activity_kind_valid;
--   alter table public.observations
--     add constraint observations_activity_kind_valid
--     check (activity_kind is null or activity_kind in ('coding'));
--   alter table public.observations
--     drop column if exists lesson_label,
--     drop column if exists course_label,
--     drop column if exists page_title,
--     drop column if exists site_host;

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
alter table public.observations add column if not exists site_host text;
alter table public.observations add column if not exists page_title text;
alter table public.observations add column if not exists course_label text;
alter table public.observations add column if not exists lesson_label text;

alter table public.observations drop constraint if exists observations_activity_kind_valid;
alter table public.observations
  add constraint observations_activity_kind_valid
  check (activity_kind is null or activity_kind in ('coding', 'learning'));

alter table public.observations drop constraint if exists observations_site_host_valid;
alter table public.observations
  add constraint observations_site_host_valid
  check (
    site_host is null
    or (
      char_length(site_host) between 1 and 253
      and site_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
    )
  );

alter table public.observations drop constraint if exists observations_page_title_valid;
alter table public.observations
  add constraint observations_page_title_valid
  check (
    page_title is null
    or (
      char_length(page_title) between 1 and 180
      and page_title !~ '[[:cntrl:]]'
      and position('://' in page_title) = 0
    )
  );

alter table public.observations drop constraint if exists observations_course_label_valid;
alter table public.observations
  add constraint observations_course_label_valid
  check (
    course_label is null
    or (
      char_length(course_label) between 1 and 160
      and course_label !~ '[[:cntrl:]]'
      and position('://' in course_label) = 0
    )
  );

alter table public.observations drop constraint if exists observations_lesson_label_valid;
alter table public.observations
  add constraint observations_lesson_label_valid
  check (
    lesson_label is null
    or (
      char_length(lesson_label) between 1 and 160
      and lesson_label !~ '[[:cntrl:]]'
      and position('://' in lesson_label) = 0
    )
  );

create index if not exists observations_user_learning_occurred_idx
  on public.observations (user_id, occurred_at desc)
  where activity_kind = 'learning';

comment on column public.observations.activity_kind is
  'Which activity stream produced the row. NULL means an observation that is not coding or learning. ''coding'' is a Cursor/VS Code heartbeat. ''learning'' is active time on an allowlisted learning site. Missing is NULL, never a fake kind.';
comment on column public.observations.site_host is
  'Allowlist host for a learning heartbeat, such as freecodecamp.org. Not a URL, path, or query string. NULL on every other observation.';
comment on column public.observations.page_title is
  'Page title for a learning heartbeat when the title is safe to keep. A URL is not stored here. NULL when there is no title.';
comment on column public.observations.course_label is
  'Course name parsed from a known learning site, such as a freeCodeCamp superblock. NULL when the page has no course.';
comment on column public.observations.lesson_label is
  'Lesson or page name for a learning heartbeat. Not a URL path.';

commit;
