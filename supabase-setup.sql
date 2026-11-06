-- =====================================================================
-- Daily Checklist — Supabase setup
-- Paste all of this into Supabase → SQL Editor → New query, then Run.
-- Safe to run more than once.
-- =====================================================================

-- Your weekly lists (one row per person)
create table if not exists public.templates (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Which tasks you ticked on which date
create table if not exists public.ticks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day     date not null,
  idx     int  not null,
  primary key (user_id, day, idx)
);

-- Security: each signed-in person can only see and change their own rows
alter table public.templates enable row level security;
alter table public.ticks     enable row level security;

drop policy if exists "own templates" on public.templates;
create policy "own templates" on public.templates
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own ticks" on public.ticks;
create policy "own ticks" on public.ticks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Live updates: a tick on your phone appears on your computer straight away
alter table public.ticks replica identity full;
do $$
begin
  begin alter publication supabase_realtime add table public.templates; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.ticks;     exception when duplicate_object then null; end;
end $$;
