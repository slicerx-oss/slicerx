-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Animated banners: creator-media takes GIF as well, for banners only. A GIF
-- is stored as banner-<anything>.gif in the creator's own folder, and only
-- banner_url may point at one; logos and listing covers stay still images.
-- The 5 MB limit stays.

update storage.buckets
  set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  where id = 'creator-media';

create or replace function public.can_write_creator_media(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    split_part(p_path, '/', 1) = (select auth.uid())::text
      and (p_path ~ '^[0-9a-f-]{36}/[a-z0-9][a-z0-9._-]{0,80}\.(png|jpe?g|webp)$'
        or p_path ~ '^[0-9a-f-]{36}/banner[a-z0-9._-]{0,74}\.gif$')
      and public.is_active_user()
      and exists (select 1 from public.creators c where c.owner_id = (select auth.uid())),
    false
  );
$$;

-- True when the URL is a banner in the owner's creator-media folder: a still
-- image, or a GIF uploaded as a banner.
create function public.is_creator_banner_url(p_url text, p_owner uuid) returns boolean
language sql stable set search_path = '' as $$
  select public.is_creator_media_url(p_url, p_owner) or coalesce(
    starts_with(p_url, public.creator_media_prefix() || p_owner::text || '/')
      and substr(p_url, char_length(public.creator_media_prefix()) + 1) ~ '^[0-9a-f-]{36}/banner[a-z0-9._-]{0,74}\.gif$',
    false
  );
$$;
grant execute on function public.is_creator_banner_url(text, uuid) to authenticated, service_role;

create or replace function public.guard_creator_media() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_table_name = 'creators' then
    if new.logo_url is not null and (tg_op = 'INSERT' or new.logo_url is distinct from old.logo_url)
      and not public.is_creator_media_url(new.logo_url, new.owner_id) then
      raise exception 'upload the logo to your creator page first' using errcode = '23514';
    end if;
    if new.banner_url is not null and (tg_op = 'INSERT' or new.banner_url is distinct from old.banner_url)
      and not public.is_creator_banner_url(new.banner_url, new.owner_id) then
      raise exception 'upload the banner to your creator page first' using errcode = '23514';
    end if;
  elsif new.cover_url is not null and (tg_op = 'INSERT' or new.cover_url is distinct from old.cover_url)
    and not public.is_creator_media_url(new.cover_url, (select c.owner_id from public.creators c where c.id = new.creator_id)) then
    raise exception 'upload the cover to your creator page first' using errcode = '23514';
  end if;
  return new;
end;
$$;
