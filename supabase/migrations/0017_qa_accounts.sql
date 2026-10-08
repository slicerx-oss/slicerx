-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- QA accounts: the release gate's test accounts, at @qa.slicerx.app addresses.
-- They can do everything a member can (sign in, upload, like, save, follow,
-- download), but what they do stays out of what everyone else sees counted and
-- ranked, and their uploads stay out of the library's lists:
--
--   counts       likes, makes, member downloads and followers leave out QA
--                accounts (listing_stats, creator_dashboard, creator_followers)
--   rankings     trending_listings, recommended_listings and new_creators leave
--                out QA activity and QA creators' listings
--   the Feed     library_listings is the listings table without QA creators'
--                listings; the Vault's grid and rows read it
--
-- The caller's own activity and uploads always count and show for the caller,
-- so a QA account sees the library as a member would. A QA listing still opens
-- by its address and downloads like any other. Signed-out downloads carry no
-- account and are counted as before.
--
-- The flag is a row in qa_accounts, set at sign-up (and when an account's
-- address changes to one) by a trigger on auth.users, and never cleared by it.
-- Only the service role reads or changes it. The table is part of the auth
-- module; library_listings and creator_listed go with the store
-- (modules/drop_store.sql).

create table public.qa_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  flagged_at timestamptz not null default now()
);
alter table public.qa_accounts enable row level security;
-- No policies: clients can neither read nor write it.
revoke all on public.qa_accounts from anon, authenticated, public;
grant select, insert, update, delete on public.qa_accounts to service_role;

create function public.is_qa_email(p_email text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(lower(btrim(p_email)) ~ '@qa\.slicerx\.app$', false);
$$;

create function public.flag_qa_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_qa_email(new.email) then
    insert into public.qa_accounts (user_id) values (new.id) on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger on_auth_user_qa
  after insert or update of email on auth.users
  for each row execute function public.flag_qa_account();

-- Service role only: flags every account with a QA address that is not
-- flagged yet, and returns how many it flagged. Runs once below; running it
-- again also flags back an account the service role cleared.
create function public.backfill_qa_accounts() returns integer
language sql volatile security definer set search_path = '' as $$
  with done as (
    insert into public.qa_accounts (user_id)
    select u.id from auth.users u where public.is_qa_email(u.email)
    on conflict (user_id) do nothing
    returning 1
  )
  select count(*)::integer from done;
$$;
select public.backfill_qa_accounts();

-- True for a QA account other than the caller: its activity is left out of
-- what the caller sees counted and ranked.
create function public.qa_hidden(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is distinct from (select auth.uid())
    and exists (select 1 from public.qa_accounts q where q.user_id = p_user);
$$;

revoke execute on function public.is_qa_email(text), public.backfill_qa_accounts(), public.qa_hidden(uuid)
from anon, authenticated, public;
grant execute on function public.backfill_qa_accounts() to service_role;

-- Store --------------------------------------------------------------------------------

-- False for a creator page that belongs to a QA account other than the caller:
-- its listings stay out of the library's lists.
create function public.creator_listed(p_creator uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.creators c
    join public.qa_accounts q on q.user_id = c.owner_id
    where c.id = p_creator and c.owner_id is distinct from (select auth.uid())
  );
$$;
revoke execute on function public.creator_listed(uuid) from public;
grant execute on function public.creator_listed(uuid) to anon, authenticated, service_role;

-- The Feed: listings as the caller may read them, without QA creators' listings.
create view public.library_listings with (security_invoker = on) as
select l.* from public.listings l
where public.creator_listed(l.creator_id);
revoke all on public.library_listings from anon, authenticated;
grant select on public.library_listings to anon, authenticated, service_role;

-- Counts for listing cards, without QA accounts' likes, makes and downloads.
create or replace function public.listing_stats(p_ids uuid[])
returns table (listing_id uuid, likes bigint, makes bigint, comments bigint, downloads bigint)
language sql stable security definer set search_path = '' as $$
  select l.id,
    (select count(*) from public.likes x where x.listing_id = l.id and not public.qa_hidden(x.user_id)),
    (select count(*) from public.makes x where x.listing_id = l.id and not public.qa_hidden(x.user_id)),
    (select count(*) from public.comments x where x.listing_id = l.id and x.deleted_at is null),
    (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id and not public.qa_hidden(x.user_id))
      + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id)
  from public.listings l
  where l.id = any (p_ids) and public.listing_visible(l.id);
$$;

create or replace function public.creator_dashboard()
returns table (listing_id uuid, title text, status text, likes bigint, comments bigint, makes bigint, downloads bigint)
language sql stable security definer set search_path = '' as $$
  select l.id, l.title, l.status,
    (select count(*) from public.likes x where x.listing_id = l.id and not public.qa_hidden(x.user_id)),
    (select count(*) from public.comments x where x.listing_id = l.id and x.deleted_at is null),
    (select count(*) from public.makes x where x.listing_id = l.id and not public.qa_hidden(x.user_id)),
    (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id and not public.qa_hidden(x.user_id))
      + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id)
  from public.listings l
  join public.creators c on c.id = l.creator_id
  where c.owner_id = (select auth.uid())
  order by l.created_at desc;
$$;

create or replace function public.creator_followers(p_ids uuid[])
returns table (creator_id uuid, followers bigint)
language sql stable security definer set search_path = '' as $$
  select c.id, (select count(*) from public.follows f where f.creator_id = c.id and not public.qa_hidden(f.user_id))
  from public.creators c
  where c.id = any (p_ids)
    and ((c.status = 'active' and not public.user_banned(c.owner_id)) or c.owner_id = (select auth.uid()) or public.is_staff());
$$;

-- As in 0013_creator_pages, without QA activity and QA creators' listings.
create or replace function public.trending_listings(p_days integer default 7, p_limit integer default 24)
returns table (listing_id uuid, score bigint)
language sql stable security definer set search_path = '' as $$
  with w as (select now() - make_interval(days => least(greatest(p_days, 1), 90)) as since)
  select s.id, s.score from (
    select l.id, l.published_at,
      3 * (select count(*) from public.likes x where x.listing_id = l.id and x.created_at >= w.since and not public.qa_hidden(x.user_id))
      + 5 * (select count(*) from public.makes x where x.listing_id = l.id and x.created_at >= w.since and not public.qa_hidden(x.user_id))
      + (select count(*) from public.downloads x where x.listing_id = l.id and x.last_at >= w.since and not public.qa_hidden(x.user_id))
      + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id and x.day >= w.since::date)
      as score
    from public.listings l, w
    where l.status = 'approved' and public.listing_visible(l.id) and public.creator_listed(l.creator_id)
  ) s
  where s.score > 0
  order by s.score desc, s.published_at desc, s.id
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.new_creators(p_days integer default 30, p_limit integer default 12)
returns table (creator_id uuid, first_published_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, min(l.published_at)
  from public.creators c
  join public.listings l on l.creator_id = c.id and l.status = 'approved'
  where c.status = 'active' and not public.user_banned(c.owner_id) and public.creator_listed(c.id)
  group by c.id
  having min(l.published_at) >= now() - make_interval(days => least(greatest(p_days, 1), 365))
  order by min(l.published_at) desc, c.id
  limit least(greatest(p_limit, 1), 50);
$$;

create or replace function public.recommended_listings(p_limit integer default 24)
returns table (listing_id uuid, score bigint)
language sql stable security definer set search_path = '' as $$
  with liked as (
    select l.id, l.creator_id, l.tags
    from public.likes k join public.listings l on l.id = k.listing_id
    where k.user_id = (select auth.uid())
  ),
  tag_weight as (select t, count(*) as n from liked, unnest(liked.tags) as t group by t),
  creator_weight as (select creator_id, count(*) as n from liked group by creator_id),
  scored as (
    select l.id, l.published_at,
      coalesce((select sum(tw.n) from tag_weight tw where tw.t = any (l.tags)), 0)
      + 2 * coalesce((select cw.n from creator_weight cw where cw.creator_id = l.creator_id), 0) as score
    from public.listings l
    where l.status = 'approved' and public.listing_visible(l.id) and public.creator_listed(l.creator_id)
      and not exists (select 1 from liked where liked.id = l.id)
      and not exists (select 1 from public.creators c where c.id = l.creator_id and c.owner_id = (select auth.uid()))
  )
  select id, score::bigint from scored
  where score > 0
  order by score desc, published_at desc, id
  limit least(greatest(p_limit, 1), 100);
$$;
