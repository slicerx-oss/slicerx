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
    -- coalesce: with no updatedAt, jsonb_typeof is null, and a null check would let the row in
    or (fact - 'updatedAt' = '{"deleted": true}'::jsonb and coalesce(jsonb_typeof(fact -> 'updatedAt') = 'number', false)))
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

-- The account export (0001_auth.sql) gains the person's synced memory, tombstones included: the same function with
-- one more section, which it skips when the table is gone (drop_mimir_proxy.sql). Replacing it keeps its grants.
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result jsonb;
  section record;
  rows jsonb;
begin
  if uid is null then
    raise exception 'sign in to export your data' using errcode = '42501';
  end if;
  result := jsonb_build_object(
    'format', 'slicerx-account-export',
    'version', 1,
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u where u.id = uid),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'api_tokens', (select coalesce(jsonb_agg(public.export_row(to_jsonb(t)) order by t.created_at), '[]'::jsonb)
                   from public.api_tokens t where t.user_id = uid),
    'account_deletion', (select to_jsonb(d) from public.account_deletions d where d.user_id = uid)
  );
  for section in
    select * from (values
      ('paired_devices', 'paired_devices', 'user_id'),
      ('likes', 'likes', 'user_id'),
      ('downloads', 'downloads', 'user_id'),
      ('follows', 'follows', 'user_id'),
      ('comments', 'comments', 'user_id'),
      ('makes', 'makes', 'user_id'),
      ('collections', 'collections', 'owner_id'),
      ('creator_page', 'creators', 'owner_id'),
      ('cloud_devices', 'cloud_devices', 'user_id'),
      ('sync_profiles', 'sync_profiles', 'user_id'),
      ('sync_printers', 'sync_printers', 'user_id'),
      ('sync_fleets', 'sync_fleets', 'user_id'),
      ('cloud_jobs', 'cloud_jobs', 'user_id'),
      ('cloud_deliveries', 'cloud_deliveries', 'user_id'),
      ('mimir_memory', 'mimir_memory', 'user_id')
    ) as s(name, tbl, col)
  loop
    if to_regclass('public.' || section.tbl) is not null then
      execute format('select coalesce(jsonb_agg(public.export_row(to_jsonb(t))), ''[]''::jsonb) from public.%I t where t.%I = $1', section.tbl, section.col)
        into rows using uid;
      result := result || jsonb_build_object(section.name, rows);
    end if;
  end loop;
  if to_regclass('public.collection_items') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(i)), ''[]''::jsonb) from public.collection_items i
             join public.collections c on c.id = i.collection_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('collection_items', rows);
  end if;
  if to_regclass('public.listings') is not null then
    -- The member's uploads, with the review note each one carries.
    execute 'select coalesce(jsonb_agg(public.export_row(to_jsonb(l)) order by l.created_at), ''[]''::jsonb)
             from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('listings', rows);
    execute 'select coalesce(jsonb_agg(public.export_row(to_jsonb(v)) order by v.created_at), ''[]''::jsonb)
             from public.listing_versions v join public.listings l on l.id = v.listing_id
             join public.creators c on c.id = l.creator_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('listing_versions', rows);
    execute 'select coalesce(jsonb_agg(to_jsonb(k)), ''[]''::jsonb)
             from public.creator_links k join public.creators c on c.id = k.creator_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('creator_links', rows);
  end if;
  return result;
end;
$$;

revoke execute on function public.export_my_data() from anon, public;
grant execute on function public.export_my_data() to authenticated;
