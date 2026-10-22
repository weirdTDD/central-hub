-- Central Hub — Grok chat history and task reminders
-- Date: 2026-10-22
-- Target: Supabase PostgreSQL (apply via Supabase SQL Editor or `supabase db push`)
--
-- grok_conversations  one chat, owned by the signed-in user
-- grok_messages       the turns of that chat, including tool calls
-- task_alerts         a reminder for one of the owner's tasks
--
-- The xAI key is not stored here. Chat requests go through the grok-chat
-- Edge Function, which holds XAI_API_KEY. These tables only hold the owner's
-- own words, the model's replies, and the reminders.
--
-- A reminder's delivery is a row in public.notifications (kind = task_alert).
-- The browser notification is this device showing that row. The notifications
-- channel check stays in_app, because no push service is configured.
--
-- Requires public.tasks (Phase 3). ai_preferences (Phase 7) is optional: the
-- grok_model column is added only when that table already exists.
--
-- Rollback:
--   drop trigger if exists grok_messages_same_owner on public.grok_messages;
--   drop trigger if exists task_alerts_same_owner on public.task_alerts;
--   drop table if exists public.grok_messages;
--   drop table if exists public.grok_conversations;
--   drop table if exists public.task_alerts;
--   alter table public.ai_preferences drop constraint if exists ai_preferences_grok_model_valid;
--   alter table public.ai_preferences drop column if exists grok_model;

begin;

do $$
begin
  if to_regclass('public.tasks') is null then
    raise exception
      'public.tasks does not exist. Apply supabase/migrations/20261020091000_tasks_phase3.sql before this migration.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Conversations
-- ---------------------------------------------------------------------------
create table if not exists public.grok_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null default 'New chat',
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint grok_conversations_title_valid
    check (char_length(title) between 1 and 120),
  constraint grok_conversations_model_valid
    check (model is null or model ~ '^grok-[A-Za-z0-9._-]{1,64}$')
);

comment on table public.grok_conversations is
  'One Grok chat. The model column is the model that last answered, or null when the server default was used and not yet recorded.';

-- ---------------------------------------------------------------------------
-- 2. Messages
-- ---------------------------------------------------------------------------
create table if not exists public.grok_messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversation_id  uuid not null references public.grok_conversations(id) on delete cascade,
  role             text not null,
  content          text not null default '',
  tool_calls       jsonb,
  tool_call_id     text,
  tool_name        text,
  created_at       timestamptz not null default now(),
  constraint grok_messages_role_valid
    check (role in ('user', 'assistant', 'tool')),
  constraint grok_messages_tool_shape
    check (role <> 'tool' or tool_call_id is not null),
  constraint grok_messages_content_length
    check (char_length(content) <= 20000)
);

comment on table public.grok_messages is
  'One turn in a Grok chat. role tool is the result of a function call. Deleting the conversation deletes its messages.';

-- ---------------------------------------------------------------------------
-- 3. Task alerts
-- ---------------------------------------------------------------------------
create table if not exists public.task_alerts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id        uuid not null references public.tasks(id) on delete cascade,
  title          text not null,
  note           text,
  due_at         timestamptz not null,
  timezone       text not null default 'UTC',
  repeat         text not null default 'none',
  status         text not null default 'scheduled',
  last_fired_at  timestamptz,
  created_by     text not null default 'user',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint task_alerts_title_valid
    check (char_length(title) between 1 and 200),
  constraint task_alerts_note_valid
    check (note is null or char_length(note) <= 500),
  constraint task_alerts_repeat_valid
    check (repeat in ('none', 'daily', 'weekly', 'weekdays')),
  constraint task_alerts_status_valid
    check (status in ('scheduled', 'paused', 'fired')),
  constraint task_alerts_created_by_valid
    check (created_by in ('user', 'grok')),
  constraint task_alerts_timezone_valid
    check (char_length(timezone) between 1 and 64)
);

comment on table public.task_alerts is
  'A reminder for one task. due_at is the next occurrence. After a one-shot reminder fires, status becomes fired. A repeat keeps status scheduled and moves due_at forward. last_fired_at is the occurrence that was already delivered, so opening the app again does not deliver it twice. Deleting the task deletes the reminder.';

comment on column public.task_alerts.last_fired_at is
  'The due instant that was last handed to the inbox. Null until the first delivery.';

-- ---------------------------------------------------------------------------
-- 4. Optional model preference
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ai_preferences') is not null then
    alter table public.ai_preferences add column if not exists grok_model text;
    alter table public.ai_preferences drop constraint if exists ai_preferences_grok_model_valid;
    alter table public.ai_preferences
      add constraint ai_preferences_grok_model_valid
      check (grok_model is null or grok_model ~ '^grok-[A-Za-z0-9._-]{1,64}$');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Same-owner guards
-- ---------------------------------------------------------------------------
-- A message can only sit in a conversation the same user owns. A reminder can
-- only point at a task the same user owns. The lookup runs as the caller, so
-- row-level security hides another person's rows and the write is refused.
create or replace function public.grok_messages_same_owner()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner uuid;
begin
  select user_id into owner
  from public.grok_conversations
  where id = new.conversation_id;

  if owner is null or owner <> new.user_id then
    raise exception 'A chat message can only be added to your own chat.';
  end if;
  return new;
end;
$$;

create or replace function public.task_alerts_same_owner()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner uuid;
begin
  select user_id into owner
  from public.tasks
  where id = new.task_id;

  if owner is null or owner <> new.user_id then
    raise exception 'A reminder can only point at a task you own.';
  end if;
  return new;
end;
$$;

drop trigger if exists grok_messages_same_owner on public.grok_messages;
create trigger grok_messages_same_owner
  before insert or update on public.grok_messages
  for each row
  execute function public.grok_messages_same_owner();

drop trigger if exists task_alerts_same_owner on public.task_alerts;
create trigger task_alerts_same_owner
  before insert or update on public.task_alerts
  for each row
  execute function public.task_alerts_same_owner();

-- ---------------------------------------------------------------------------
-- 6. updated_at
-- ---------------------------------------------------------------------------
create or replace function public.grok_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists grok_conversations_set_updated_at on public.grok_conversations;
create trigger grok_conversations_set_updated_at
  before update on public.grok_conversations
  for each row
  execute function public.grok_set_updated_at();

drop trigger if exists task_alerts_set_updated_at on public.task_alerts;
create trigger task_alerts_set_updated_at
  before update on public.task_alerts
  for each row
  execute function public.grok_set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Indexes
-- ---------------------------------------------------------------------------
create index if not exists grok_conversations_owner_updated_idx
  on public.grok_conversations (user_id, updated_at desc);

create index if not exists grok_messages_conversation_created_idx
  on public.grok_messages (conversation_id, created_at);

create index if not exists task_alerts_owner_due_idx
  on public.task_alerts (user_id, status, due_at);

-- ---------------------------------------------------------------------------
-- 8. Row level security
-- ---------------------------------------------------------------------------
alter table public.grok_conversations enable row level security;
alter table public.grok_messages      enable row level security;
alter table public.task_alerts        enable row level security;

do $$
declare
  policy_row record;
  table_name text;
begin
  foreach table_name in array array[
    'grok_conversations', 'grok_messages', 'task_alerts'
  ] loop
    for policy_row in
      select polname from pg_policy
      where polrelid = format('public.%I', table_name)::regclass
    loop
      execute format('drop policy if exists %I on public.%I', policy_row.polname, table_name);
    end loop;
  end loop;
end
$$;

create policy "grok_conversations_select_own"
  on public.grok_conversations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "grok_conversations_insert_own"
  on public.grok_conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "grok_conversations_update_own"
  on public.grok_conversations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "grok_conversations_delete_own"
  on public.grok_conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "grok_messages_select_own"
  on public.grok_messages for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "grok_messages_insert_own"
  on public.grok_messages for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "grok_messages_update_own"
  on public.grok_messages for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "grok_messages_delete_own"
  on public.grok_messages for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "task_alerts_select_own"
  on public.task_alerts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "task_alerts_insert_own"
  on public.task_alerts for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "task_alerts_update_own"
  on public.task_alerts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "task_alerts_delete_own"
  on public.task_alerts for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
revoke all on public.grok_conversations from anon, authenticated;
revoke all on public.grok_messages      from anon, authenticated;
revoke all on public.task_alerts        from anon, authenticated;

grant select, insert, update, delete on public.grok_conversations to authenticated;
grant select, insert, update, delete on public.grok_messages      to authenticated;
grant select, insert, update, delete on public.task_alerts        to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_alerts'
    ) then
      alter publication supabase_realtime add table public.task_alerts;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'grok_messages'
    ) then
      alter publication supabase_realtime add table public.grok_messages;
    end if;
  end if;
end
$$;

commit;
