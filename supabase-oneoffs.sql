-- =====================================================================
-- Daily Checklist — "Just today" list
-- Paste all of this into Supabase → SQL Editor → New query, then Run.
-- Only needed once. Safe to run more than once.
-- =====================================================================

create table if not exists public.oneoffs (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  text       text not null,
  day        date not null,          -- the day it was added for
  done_on    date,                   -- the day it was ticked (empty = still to do, carries over)
  position   int  not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists oneoffs_user_idx on public.oneoffs (user_id);

-- Security: each signed-in person can only see and change their own
alter table public.oneoffs enable row level security;

drop policy if exists "own oneoffs" on public.oneoffs;
create policy "own oneoffs" on public.oneoffs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Live updates between phone and computer
alter table public.oneoffs replica identity full;
do $$
begin
  begin alter publication supabase_realtime add table public.oneoffs; exception when duplicate_object then null; end;
end $$;
