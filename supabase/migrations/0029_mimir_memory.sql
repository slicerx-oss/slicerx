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
  primary key (user_id, edition, id),
  -- a tombstone carries exactly its two keys
  constraint mimir_memory_tombstone check (
    not (fact ? 'deleted')
    or (fact - 'updatedAt' = '{"deleted": true}'::jsonb and jsonb_typeof(fact -> 'updatedAt') = 'number'))
);

-- Newer wins on the server too, so two devices that sync at once cannot put an older fact back. A
-- write dated more than a day ahead is skipped, so a fast clock cannot freeze a fact forever (skipped
-- rather than refused, so one such fact does not fail the rest of a sync). An edition holds at most
-- 2000 live facts per person: tombstones do not count, and a fact written over a tombstone takes a
-- slot again.
create function public.mimir_memory_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.updated_at > now() + interval '1 day' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.updated_at <= old.updated_at then
      return null;
    end if;
    if (old.fact ? 'deleted') and not (new.fact ? 'deleted')
        and (select count(*) from public.mimir_memory m
             where m.user_id = new.user_id and m.edition = new.edition and not (m.fact ? 'deleted')) >= 2000 then
      raise exception 'too many facts' using errcode = '54000', hint = 'limit';
    end if;
  elsif not (new.fact ? 'deleted')
      -- an insert over an existing id becomes an update, which checks for itself
      and not exists (select 1 from public.mimir_memory m where m.user_id = new.user_id and m.edition = new.edition and m.id = new.id)
      and (select count(*) from public.mimir_memory m
           where m.user_id = new.user_id and m.edition = new.edition and not (m.fact ? 'deleted')) >= 2000 then
    raise exception 'too many facts' using errcode = '54000', hint = 'limit';
  end if;
  return new;
end;
$$;
revoke execute on function public.mimir_memory_guard() from public, anon, authenticated;

create trigger mimir_memory_guard before insert or update on public.mimir_memory
  for each row execute function public.mimir_memory_guard();

-- After each insert (the app writes by upsert), the writer's old tombstones go: those older than 90
-- days, and per edition all but the newest 8000, so tombstones cannot pile up. A device that stays
-- away longer than 90 days can bring a deleted fact back; that is the price of not keeping
-- tombstones forever. It runs on write, with no cron, and as the owner since clients cannot delete.
create function public.mimir_memory_prune() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return null;
  end if;
  delete from public.mimir_memory m
  where m.user_id = uid and (m.fact ? 'deleted')
    and (m.updated_at < now() - interval '90 days'
      or (m.edition, m.id) in (
        select t.edition, t.id from (
          select o.edition, o.id, row_number() over (partition by o.edition order by o.updated_at desc, o.id) as n
          from public.mimir_memory o where o.user_id = uid and (o.fact ? 'deleted')) t
        where t.n > 8000));
  return null;
end;
$$;
revoke execute on function public.mimir_memory_prune() from public, anon, authenticated;

create trigger mimir_memory_prune after insert on public.mimir_memory
  for each statement execute function public.mimir_memory_prune();

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
