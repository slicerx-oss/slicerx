-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir's memory, kept in step across a signed-in person's devices when they turn sync on. Each
-- row is one fact of one edition (the app keeps a store per edition), written by the app with the
-- person's session; a deleted fact stays as a tombstone, fact = {"deleted": true, "updatedAt": ...},
-- so the deletion reaches the other devices. The newer updated_at wins: an update that is not newer
-- than the stored row changes nothing. Only the person reaches their rows (auth.uid()); anon and
-- the mimir session reader get nothing.

create table public.mimir_memory (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  edition text not null check (edition ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  id text not null check (char_length(id) between 1 and 120),
  fact jsonb not null check (jsonb_typeof(fact) = 'object' and octet_length(fact::text) <= 8192),
  updated_at timestamptz not null,
  primary key (user_id, edition, id)
);

-- Newer wins on the server too, so two devices that sync at once cannot put an older fact back,
-- and an edition holds at most 2000 facts per person.
create function public.mimir_memory_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at <= old.updated_at then
      return null;
    end if;
  elsif not exists (select 1 from public.mimir_memory m where m.user_id = new.user_id and m.edition = new.edition and m.id = new.id)
      and (select count(*) from public.mimir_memory m where m.user_id = new.user_id and m.edition = new.edition) >= 2000 then
    raise exception 'too many facts' using errcode = '54000', hint = 'limit';
  end if;
  return new;
end;
$$;
revoke execute on function public.mimir_memory_guard() from public, anon, authenticated;

create trigger mimir_memory_guard before insert or update on public.mimir_memory
  for each row execute function public.mimir_memory_guard();

alter table public.mimir_memory enable row level security;
revoke all on public.mimir_memory from public, anon, authenticated;
-- No delete: a deletion is a tombstone, and the account's rows go with its profile.
grant select, insert, update on public.mimir_memory to authenticated;
grant select, insert, update, delete on public.mimir_memory to service_role;

create policy mimir_memory_read on public.mimir_memory for select to authenticated
  using (user_id = (select auth.uid()));
create policy mimir_memory_insert on public.mimir_memory for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy mimir_memory_update on public.mimir_memory for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
