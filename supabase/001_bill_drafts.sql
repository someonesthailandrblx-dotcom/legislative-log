-- Already applied to the project by Claude. Kept here so the setup can be repeated.
-- Each signed-in user can only see and change their own rows.

create table if not exists public.bill_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bill_drafts_user_updated_idx
  on public.bill_drafts (user_id, updated_at desc);

alter table public.bill_drafts enable row level security;

create policy "bill_drafts_select_own" on public.bill_drafts
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "bill_drafts_insert_own" on public.bill_drafts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "bill_drafts_update_own" on public.bill_drafts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "bill_drafts_delete_own" on public.bill_drafts
  for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.bill_drafts from anon;
grant select, insert, update, delete on public.bill_drafts to authenticated;

create or replace function public.bill_drafts_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger bill_drafts_touch
  before update on public.bill_drafts
  for each row execute function public.bill_drafts_touch();
