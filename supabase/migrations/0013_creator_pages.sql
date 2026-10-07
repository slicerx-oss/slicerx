-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module, creator pages and library rows: a banner on creator pages, the
-- public creator-media bucket for banners and logos, a private Saved list per
-- member (a collection of kind 'saved'), and the ranked reads behind the
-- library's rows: trending this week, new creators and picks based on the
-- member's likes. supabase/modules/drop_store.sql removes it with the store.

alter table public.creators add column banner_url text
  check (char_length(banner_url) <= 500 and banner_url ~* '^https://[^\s<>"'']{4,}$');

-- Tags staff set on a creator page, such as "Builds SlicerX" or "N3D team".
-- Shown under the handle; the creator cannot change them.
alter table public.creators add column badges text[] not null default '{}'
  check (cardinality(badges) <= 4 and array_to_string(badges, '') !~ '[<>]');

create or replace function public.guard_creator_badges() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and new.badges is distinct from (case when tg_op = 'INSERT' then '{}'::text[] else old.badges end) then
    raise exception 'only staff set the tags on a creator page' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger creators_guard_badges before insert or update on public.creators
  for each row execute function public.guard_creator_badges();

-- The handle is the creator page's address, so it is locked after the first
-- save: links to the page keep working. Staff may still change it (a support
-- request, an impersonation report), as may the service role.
create function public.guard_creator_handle() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and new.handle is distinct from old.handle and not public.is_staff() then
    raise exception 'the handle cannot change after the creator page is made' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger creators_guard_handle before update of handle on public.creators
  for each row execute function public.guard_creator_handle();

-- Owner only: sets the tags on a creator page. Each is 1 to 24 characters.
create function public.set_creator_badges(p_creator uuid, p_badges text[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_owner() then
    raise exception 'only the owner sets creator tags' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(p_badges) b where char_length(btrim(b)) not between 1 and 24) then
    raise exception 'a tag is 1 to 24 characters' using errcode = '22023';
  end if;
  update public.creators set badges = p_badges where id = p_creator;
  if not found then
    raise exception 'no such creator page' using errcode = 'P0002';
  end if;
  perform public.audit('creator_badges', 'creator', p_creator, null, jsonb_build_object('badges', to_jsonb(p_badges)));
end;
$$;
revoke execute on function public.set_creator_badges(uuid, text[]) from public;
grant execute on function public.set_creator_badges(uuid, text[]) to authenticated, service_role;

-- Saved designs: one private collection per member, made on the first save.
alter table public.collections add column kind text not null default 'custom' check (kind in ('custom', 'saved'));
alter table public.collections add constraint collections_saved_private check (kind <> 'saved' or not is_public);
create unique index collections_saved_idx on public.collections (owner_id) where kind = 'saved';

-- Saves or unsaves a listing the caller can see. Returns whether it is saved now.
create function public.set_saved(p_listing uuid, p_saved boolean) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  coll uuid;
begin
  if uid is null then
    raise exception 'sign in to save designs' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception 'this account cannot save designs' using errcode = '42501';
  end if;
  select id into coll from public.collections where owner_id = uid and kind = 'saved';
  if p_saved then
    if not public.listing_visible(p_listing) then
      raise exception 'no such listing' using errcode = 'P0002';
    end if;
    if coll is null then
      insert into public.collections (owner_id, name, kind) values (uid, 'Saved', 'saved')
      on conflict (owner_id) where kind = 'saved' do update set name = excluded.name
      returning id into coll;
    end if;
    insert into public.collection_items (collection_id, listing_id) values (coll, p_listing)
    on conflict do nothing;
  elsif coll is not null then
    delete from public.collection_items where collection_id = coll and listing_id = p_listing;
  end if;
  return p_saved;
end;
$$;

-- The caller's saved listings they can still see, newest save first.
create function public.saved_listings() returns table (listing_id uuid, saved_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.listing_id, i.added_at
  from public.collection_items i
  join public.collections c on c.id = i.collection_id
  where c.owner_id = (select auth.uid()) and c.kind = 'saved' and public.listing_visible(i.listing_id)
  order by i.added_at desc;
$$;

-- Trending: approved listings ranked by what happened in the last p_days days.
-- A like counts 3, a make 5, a member's download 1 (once per member) and each
-- signed-out download 1. Listings with nothing in the window are left out.
create function public.trending_listings(p_days integer default 7, p_limit integer default 24)
returns table (listing_id uuid, score bigint)
language sql stable security definer set search_path = '' as $$
  with w as (select now() - make_interval(days => least(greatest(p_days, 1), 90)) as since)
  select s.id, s.score from (
    select l.id, l.published_at,
      3 * (select count(*) from public.likes x where x.listing_id = l.id and x.created_at >= w.since)
      + 5 * (select count(*) from public.makes x where x.listing_id = l.id and x.created_at >= w.since)
      + (select count(*) from public.downloads x where x.listing_id = l.id and x.last_at >= w.since)
      + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id and x.day >= w.since::date)
      as score
    from public.listings l, w
    where l.status = 'approved' and public.listing_visible(l.id)
  ) s
  where s.score > 0
  order by s.score desc, s.published_at desc, s.id
  limit least(greatest(p_limit, 1), 100);
$$;

-- New creators: visible creators whose first approved listing went live in the
-- last p_days days, newest first.
create function public.new_creators(p_days integer default 30, p_limit integer default 12)
returns table (creator_id uuid, first_published_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, min(l.published_at)
  from public.creators c
  join public.listings l on l.creator_id = c.id and l.status = 'approved'
  where c.status = 'active' and not public.user_banned(c.owner_id)
  group by c.id
  having min(l.published_at) >= now() - make_interval(days => least(greatest(p_days, 1), 365))
  order by min(l.published_at) desc, c.id
  limit least(greatest(p_limit, 1), 50);
$$;

-- Based on your likes: approved listings that share tags or a creator with the
-- caller's likes. Each shared tag adds how often the caller liked it; the same
-- creator adds twice the likes the caller gave them. Liked listings and the
-- caller's own uploads are left out. Empty when signed out or without likes.
create function public.recommended_listings(p_limit integer default 24)
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
    where l.status = 'approved' and public.listing_visible(l.id)
      and not exists (select 1 from liked where liked.id = l.id)
      and not exists (select 1 from public.creators c where c.id = l.creator_id and c.owner_id = (select auth.uid()))
  )
  select id, score::bigint from scored
  where score > 0
  order by score desc, published_at desc, id
  limit least(greatest(p_limit, 1), 100);
$$;

revoke execute on function
  public.set_saved(uuid, boolean), public.saved_listings(), public.trending_listings(integer, integer),
  public.new_creators(integer, integer), public.recommended_listings(integer)
from public;
grant execute on function public.trending_listings(integer, integer), public.new_creators(integer, integer), public.recommended_listings(integer)
  to anon, authenticated, service_role;
grant execute on function public.set_saved(uuid, boolean), public.saved_listings() to authenticated, service_role;

-- creator-media: banners and logos, public to read. Object names are
-- <owner id>/<file name>; a member with a creator page writes only under their
-- own id. PNG, JPEG and WebP up to 5 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creator-media', 'creator-media', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create function public.can_write_creator_media(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    split_part(p_path, '/', 1) = (select auth.uid())::text
      and p_path ~ '^[0-9a-f-]{36}/[a-z0-9][a-z0-9._-]{0,80}\.(png|jpe?g|webp)$'
      and public.is_active_user()
      and exists (select 1 from public.creators c where c.owner_id = (select auth.uid())),
    false
  );
$$;
grant execute on function public.can_write_creator_media(text) to authenticated;

create policy creator_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'creator-media' and public.can_write_creator_media(name));
-- Storage needs select on the object to delete it.
create policy creator_media_select_own on storage.objects for select to authenticated
  using (bucket_id = 'creator-media' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy creator_media_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'creator-media' and split_part(name, '/', 1) = (select auth.uid())::text);

-- A deleted creator page leaves its images for the cleanup service.
create function public.queue_creator_media_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_cleanup (bucket, prefix) values ('creator-media', old.owner_id::text || '/');
  return old;
end;
$$;
create trigger creators_media_cleanup after delete on public.creators
  for each row execute function public.queue_creator_media_cleanup();

-- Vault files leave only as .sx3mf. The upload scan stores every clean upload
-- as an .sx3mf; a model file in any other format (one stored before that, or
-- put there by hand) is handed out only to its creator and staff. Preview
-- images are unchanged.
create function public.is_sealed_path(p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_path ~* '\.sx3mf$', false);
$$;
grant execute on function public.is_sealed_path(text) to anon, authenticated, service_role;

-- The file a download gets: the newest approved, clean .sx3mf version of a
-- public listing; for its creator and staff, the newest approved, clean
-- version in any format.
create or replace function public.public_download_path(p_listing uuid) returns text
language sql stable security definer set search_path = '' as $$
  select v.storage_path
  from public.listing_versions v
  join public.listings l on l.id = v.listing_id
  join public.creators c on c.id = l.creator_id
  join public.profiles p on p.id = c.owner_id
  where v.listing_id = p_listing
    and l.status = 'approved' and c.status = 'active' and p.banned_at is null
    and v.review_status = 'approved' and v.scan_status = 'clean'
    and (public.is_sealed_path(v.storage_path) or public.can_edit_listing(p_listing) or public.is_staff())
  order by string_to_array(v.version, '.')::int[] desc, v.created_at desc
  limit 1;
$$;

-- Visitors: an .sx3mf of an approved, clean version of a public listing, or
-- one of its preview images.
create or replace function public.is_public_file(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(exists (
    select 1
    from public.listing_versions v
    join public.listings l on l.id = v.listing_id
    join public.creators c on c.id = l.creator_id
    join public.profiles p on p.id = c.owner_id
    where v.listing_id = public.path_listing(p_path)
      and l.status = 'approved' and c.status = 'active' and p.banned_at is null
      and v.review_status = 'approved' and v.scan_status = 'clean'
      and (
        (v.storage_path = p_path and public.is_sealed_path(p_path))
        or exists (
          select 1 from public.listing_files f
          where f.version_id = v.id and f.role = 'image'
            and v.listing_id::text || '/' || v.id::text || '/' || f.name = p_path
        )
      )
  ), false);
$$;

-- Members: as before, but another member's model file only as an .sx3mf.
create or replace function public.can_download(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    public.is_active_user() and (
      public.is_staff()
      or public.can_edit_listing(public.path_listing(p_path))
      or exists (
        select 1 from public.listing_versions v
        where v.storage_path = p_path and public.is_sealed_path(p_path)
          and v.review_status = 'approved' and v.scan_status = 'clean'
          and public.listing_visible(v.listing_id)
          and exists (select 1 from public.listings l where l.id = v.listing_id and l.status = 'approved')
      )
      -- Preview images the scan wrote for an approved version.
      or exists (
        select 1 from public.listing_files f join public.listing_versions v on v.id = f.version_id
        where f.role = 'image' and v.listing_id::text || '/' || v.id::text || '/' || f.name = p_path
          and v.review_status = 'approved' and v.scan_status = 'clean'
          and public.listing_visible(v.listing_id)
          and exists (select 1 from public.listings l where l.id = v.listing_id and l.status = 'approved')
      )
    ),
    false
  );
$$;
