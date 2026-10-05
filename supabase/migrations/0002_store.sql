-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module: the free, moderated model library. Creator pages with links and
-- featured models, listings that start pending and become visible when staff
-- approve them, immutable versions that pass the upload scan, likes, comments,
-- makes, collections, downloads and the two storage buckets
-- (uploads-quarantine and listing-files). Depends only on the auth module
-- (profiles, roles, bans, audit log). supabase/modules/drop_store.sql removes it.

-- Library settings: one row. The edition config (library.moderation) is the
-- source of these values; apply_library_settings copies them in, and the
-- owner can change the mode later with set_moderation_mode.
--   owner-approves-all  only the owner approves
--   moderators          owner and moderators approve
--   trusted-creators    as moderators, and a clean upload from a creator the
--                       owner marked trusted is approved at once
--   auto-after-scan     a clean upload from anyone is approved at once;
--                       staff review afterwards and can remove it
create table public.library_settings (
  id boolean primary key default true check (id),
  moderation_mode text not null default 'owner-approves-all'
    check (moderation_mode in ('owner-approves-all', 'moderators', 'trusted-creators', 'auto-after-scan')),
  max_file_mb integer not null default 100 check (max_file_mb between 1 and 500),
  allowed_formats text[] not null default array['3mf', 'sx3mf', 'stl']
    check (cardinality(allowed_formats) > 0 and allowed_formats <@ array['3mf', 'sx3mf', 'stl']),
  updated_at timestamptz not null default now()
);
insert into public.library_settings default values;

create table public.creators (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  handle text not null unique check (
    handle ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'
    and handle not in ('admin', 'api', 'new', 'me', 'settings', 'login', 'dashboard', 'creators', 'studio', 'moderation', 'support', 'slicerx', 'library')
  ),
  display_name text not null check (char_length(display_name) between 1 and 80),
  tagline text check (char_length(tagline) <= 140),
  bio text check (char_length(bio) <= 4000),
  location text check (char_length(location) <= 80),
  logo_url text check (char_length(logo_url) <= 500 and logo_url ~* '^https://[^\s<>"'']{4,}$'),
  status text not null default 'active' check (status in ('active', 'paused')),
  -- Set by the owner. Under moderation mode 'trusted-creators', clean uploads go live at once.
  trusted boolean not null default false,
  created_at timestamptz not null default now()
);

-- A member who makes a creator page becomes a creator.
create function public.promote_creator() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set role = 'creator' where id = new.owner_id and role = 'member';
  return new;
end;
$$;
create trigger creators_promote after insert on public.creators
  for each row execute function public.promote_creator();

-- Clients cannot set the trusted flag or move a page to another owner.
create function public.guard_creator_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.owner_id is distinct from old.owner_id then
      raise exception 'a creator page cannot change owner' using errcode = '42501';
    end if;
    if new.trusted is distinct from old.trusted then
      raise exception 'only the owner marks a creator trusted' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger creators_guard before update on public.creators
  for each row execute function public.guard_creator_update();

create function public.guard_creator_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.trusted := false;
  end if;
  return new;
end;
$$;
create trigger creators_guard_insert before insert on public.creators
  for each row execute function public.guard_creator_insert();

-- Links on a creator page. Only https URLs; the named services must be on
-- their own domain, so a "Patreon" link cannot point somewhere else.
create table public.creator_links (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators (id) on delete cascade,
  kind text not null check (kind in (
    'website', 'patreon', 'makerworld', 'printables', 'thingiverse', 'cults3d', 'youtube',
    'instagram', 'tiktok', 'x', 'discord', 'github', 'kofi', 'buymeacoffee', 'other'
  )),
  label text check (char_length(label) between 1 and 60),
  url text not null check (
    char_length(url) <= 300
    and url ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(:[0-9]{1,5})?([/?#][^\s<>"''\\]*)?$'
  ),
  position integer not null default 0 check (position between 0 and 99),
  created_at timestamptz not null default now(),
  unique (creator_id, url)
);
create index creator_links_creator_idx on public.creator_links (creator_id, position);

create function public.check_creator_link() returns trigger
language plpgsql set search_path = '' as $$
declare
  host text := regexp_replace(lower(substring(new.url from '^https://([^/:?#]+)')), '^www\.', '');
  domains text[] := case new.kind
    when 'patreon' then array['patreon.com']
    when 'makerworld' then array['makerworld.com']
    when 'printables' then array['printables.com']
    when 'thingiverse' then array['thingiverse.com']
    when 'cults3d' then array['cults3d.com']
    when 'youtube' then array['youtube.com', 'youtu.be']
    when 'instagram' then array['instagram.com']
    when 'tiktok' then array['tiktok.com']
    when 'x' then array['x.com', 'twitter.com']
    when 'discord' then array['discord.gg', 'discord.com']
    when 'github' then array['github.com']
    when 'kofi' then array['ko-fi.com']
    when 'buymeacoffee' then array['buymeacoffee.com']
    else null
  end;
begin
  if domains is not null and not exists (
    select 1 from unnest(domains) d where host = d or host like '%.' || d
  ) then
    raise exception 'a % link must point to %', new.kind, array_to_string(domains, ' or ') using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.creator_links k where k.creator_id = new.creator_id) >= 12 then
    raise exception 'a creator page has at most 12 links' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger creator_links_check before insert or update on public.creator_links
  for each row execute function public.check_creator_link();

create table public.follows (
  user_id uuid not null references public.profiles (id) on delete cascade,
  creator_id uuid not null references public.creators (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, creator_id)
);
create index follows_creator_idx on public.follows (creator_id);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  title text not null check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 8000),
  -- The terms the model is shared under.
  license text not null default 'cc-by' check (license in (
    'cc0', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd', 'custom'
  )),
  -- pending: waiting for review; approved: public; rejected: sent back with a
  -- note; archived: hidden by its creator; removed: taken down by staff.
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'archived', 'removed')),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  cover_url text check (char_length(cover_url) <= 500 and cover_url ~* '^https://[^\s<>"'']{4,}$'),
  -- The reason shown to the creator after a rejection or takedown.
  review_note text check (char_length(review_note) <= 1000),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'approved' or published_at is not null)
);
create index listings_creator_idx on public.listings (creator_id);
create index listings_published_idx on public.listings (published_at desc) where status = 'approved';
create index listings_pending_idx on public.listings (created_at) where status = 'pending';

-- Versions are immutable once written, apart from the changelog. The scan
-- fields belong to the upload pipeline and review_status to moderation.
-- storage_path is the object name in both buckets: <listing id>/<version id>/<file name>.
create table public.listing_versions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  version text not null check (version ~ '^\d+\.\d+\.\d+$'),
  changelog text check (char_length(changelog) <= 4000),
  storage_path text not null check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/\\]{1,200}\.(3mf|sx3mf|stl)$'),
  -- Declared by the uploader; the scan replaces them with the measured values.
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  format text not null check (format in ('3mf', 'sx3mf', 'stl')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 524288000),
  -- uploading: row made, file going to quarantine; queued: waiting for the scan;
  -- scanning: claimed by a worker; clean: passed, file is in listing-files;
  -- rejected: failed a check, file deleted.
  scan_status text not null default 'uploading' check (scan_status in ('uploading', 'queued', 'scanning', 'clean', 'rejected')),
  scan_report jsonb,
  scan_worker text,
  scan_attempts integer not null default 0,
  scan_started_at timestamptz,
  scanned_at timestamptz,
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  unique (listing_id, version),
  check (review_status <> 'approved' or scan_status = 'clean'),
  check (scan_status not in ('clean', 'rejected') or scanned_at is not null)
);

create function public.guard_version_change() returns trigger
language plpgsql set search_path = '' as $$
declare
  settings public.library_settings%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.storage_path not like new.listing_id::text || '/' || new.id::text || '/%' then
      raise exception 'storage_path must be <listing id>/<version id>/<file name>' using errcode = '23514';
    end if;
    if current_user in ('authenticated', 'anon') then
      select * into settings from public.library_settings;
      if new.size_bytes > settings.max_file_mb::bigint * 1048576 then
        raise exception 'files can be at most % MB', settings.max_file_mb using errcode = '23514';
      end if;
      if not (new.format = any (settings.allowed_formats)) then
        raise exception 'this format is not accepted here' using errcode = '23514';
      end if;
      new.scan_attempts := 0;
      new.scan_status := 'uploading';
      new.scan_report := null;
      new.scan_worker := null;
      new.scan_started_at := null;
      new.scanned_at := null;
      new.review_status := 'pending';
    end if;
    return new;
  end if;
  -- The scan may rename the file (a converted upload) on the scanning to clean transition, only under the same prefix.
  if new.storage_path is distinct from old.storage_path
     and not (current_user not in ('authenticated', 'anon') and old.scan_status = 'scanning' and new.scan_status = 'clean'
              and new.storage_path like new.listing_id::text || '/' || new.id::text || '/%') then
    raise exception 'listing versions are immutable; publish a new version' using errcode = 'P0001';
  end if;
  if (new.listing_id, new.version, new.created_at) is distinct from (old.listing_id, old.version, old.created_at) then
    raise exception 'listing versions are immutable; publish a new version' using errcode = 'P0001';
  end if;
  if old.scan_status in ('clean', 'rejected')
     and (new.sha256, new.format, new.size_bytes, new.scan_status) is distinct from (old.sha256, old.format, old.size_bytes, old.scan_status) then
    raise exception 'a scanned version cannot change; publish a new version' using errcode = 'P0001';
  end if;
  if current_user in ('authenticated', 'anon')
     and (new.sha256, new.format, new.size_bytes, new.scan_status, new.scan_report, new.scan_worker,
          new.scan_started_at, new.scanned_at, new.review_status)
         is distinct from
         (old.sha256, old.format, old.size_bytes, old.scan_status, old.scan_report, old.scan_worker,
          old.scan_started_at, old.scanned_at, old.review_status) then
    raise exception 'only the changelog can be edited' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger listing_versions_guard before insert or update on public.listing_versions
  for each row execute function public.guard_version_change();

-- The verified file manifest, written by the scan from what it found.
create table public.listing_files (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.listing_versions (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  role text not null check (role in ('model', 'plate', 'image', 'readme')),
  format text check (format in ('3mf', 'sx3mf', 'stl')),
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$')
);
create index listing_files_version_idx on public.listing_files (version_id);

create table public.print_profiles (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.listing_versions (id) on delete cascade,
  printer_model text not null,
  process text not null,
  filament text not null,
  layer_height_mm numeric(4, 2) check (layer_height_mm > 0 and layer_height_mm <= 1),
  nozzle_mm numeric(3, 2) check (nozzle_mm > 0),
  time_s integer check (time_s >= 0),
  grams numeric(8, 1) check (grams >= 0),
  plates integer check (plates >= 1),
  notes text check (char_length(notes) <= 2000)
);
create index print_profiles_version_idx on public.print_profiles (version_id);

-- Featured models on a creator page: up to six of the creator's approved listings.
create table public.creator_featured (
  creator_id uuid not null references public.creators (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  position integer not null check (position between 1 and 6),
  primary key (creator_id, listing_id),
  unique (creator_id, position)
);

create function public.check_featured() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.listings l where l.id = new.listing_id and l.creator_id = new.creator_id and l.status = 'approved'
  ) then
    raise exception 'feature only your own approved models' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger creator_featured_check before insert or update on public.creator_featured
  for each row execute function public.check_featured();

-- A listing that leaves the approved state stops being featured.
create function public.unfeature_listing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'approved' and new.status <> 'approved' then
    delete from public.creator_featured where listing_id = new.id;
  end if;
  return new;
end;
$$;

create table public.likes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);
create index likes_listing_idx on public.likes (listing_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  -- Null once the author deletes their account; the comment stays for its replies.
  user_id uuid references public.profiles (id) on delete set null,
  parent_id uuid references public.comments (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index comments_listing_idx on public.comments (listing_id, created_at);

-- Clients edit only the body. deleted_at changes through delete_comment.
create function public.guard_comment_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (new.listing_id, new.user_id, new.parent_id, new.created_at, new.deleted_at)
       is distinct from (old.listing_id, old.user_id, old.parent_id, old.created_at, old.deleted_at) then
      raise exception 'only the body of a comment can be edited' using errcode = '42501';
    end if;
    if new.body is distinct from old.body then
      new.edited_at := now();
    end if;
  end if;
  return new;
end;
$$;
create trigger comments_guard before update on public.comments
  for each row execute function public.guard_comment_update();

create table public.makes (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  caption text check (char_length(caption) <= 1000),
  photo_url text check (char_length(photo_url) <= 500 and photo_url ~* '^https://[^\s<>"'']{4,}$'),
  printer_model text check (char_length(printer_model) <= 80),
  created_at timestamptz not null default now()
);
create index makes_listing_idx on public.makes (listing_id, created_at);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);
create index collections_owner_idx on public.collections (owner_id);

create table public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, listing_id)
);

-- One row per member and listing, counting downloads. Written by record_download.
create table public.downloads (
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  count integer not null default 1 check (count >= 1),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);
create index downloads_listing_idx on public.downloads (listing_id);

-- Files to remove from storage after rows are deleted (a listing, or every
-- listing of a deleted account). The service that owns the buckets consumes
-- this table with the service role and sets done_at.
create table public.storage_cleanup (
  id bigint generated always as identity primary key,
  bucket text not null,
  prefix text not null,
  queued_at timestamptz not null default now(),
  done_at timestamptz
);
create index storage_cleanup_open_idx on public.storage_cleanup (queued_at) where done_at is null;

create function public.queue_listing_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_cleanup (bucket, prefix)
  values ('uploads-quarantine', old.id::text || '/'), ('listing-files', old.id::text || '/');
  return old;
end;
$$;
create trigger listings_cleanup after delete on public.listings
  for each row execute function public.queue_listing_cleanup();

-- Listing integrity triggers ---------------------------------------------------------
-- Clients (roles authenticated and anon) get the rules below. The moderation
-- functions run as their owner and the service role is trusted, so neither is
-- limited by them.

create function public.guard_listing_change() returns trigger
language plpgsql set search_path = '' as $$
declare
  client boolean := current_user in ('authenticated', 'anon');
  content_changed boolean;
begin
  if tg_op = 'INSERT' then
    if client then
      new.status := 'pending';
      new.review_note := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
      new.published_at := null;
      if (select count(*) from public.listings l where l.creator_id = new.creator_id and l.status = 'pending') >= 20 then
        raise exception 'you have 20 models waiting for review; wait for a decision first' using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

  if new.creator_id is distinct from old.creator_id then
    raise exception 'a listing cannot move to another creator' using errcode = 'P0001';
  end if;
  if not client then
    return new;
  end if;
  if (new.reviewed_by, new.reviewed_at, new.review_note, new.published_at)
     is distinct from (old.reviewed_by, old.reviewed_at, old.review_note, old.published_at) then
    raise exception 'review fields are set by moderation' using errcode = '42501';
  end if;
  content_changed := (new.slug, new.title, new.description, new.license, new.tags, new.cover_url)
                     is distinct from (old.slug, old.title, old.description, old.license, old.tags, old.cover_url);
  if new.status is distinct from old.status then
    if not ((old.status, new.status) in (('approved', 'archived'), ('archived', 'approved'), ('rejected', 'pending'))) then
      raise exception 'a % listing cannot become %', old.status, new.status using errcode = '42501';
    end if;
  end if;
  -- Edits to a public or archived listing go back through review.
  if content_changed and old.status in ('approved', 'archived') then
    new.status := 'pending';
  end if;
  return new;
end;
$$;
create trigger listings_guard before insert or update on public.listings
  for each row execute function public.guard_listing_change();
create trigger listings_unfeature after update of status on public.listings
  for each row execute function public.unfeature_listing();

-- Policy helpers. Security definer so policies can look across tables
-- without recursing into each other's policies. Each one only answers yes or no.

create function public.is_creator_owner(p_creator uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.creators c where c.id = p_creator and c.owner_id = (select auth.uid())
  );
$$;

-- Owner of the listing's creator page, and not banned.
create function public.can_edit_listing(p_listing uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.listings l
    join public.creators c on c.id = l.creator_id
    where l.id = p_listing and c.owner_id = (select auth.uid())
  ) and public.is_active_user();
$$;

-- Who may see a listing: staff, its creator, and everyone once it is approved
-- (unless its creator is banned or has paused their page).
create function public.listing_visible(p_listing uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() or exists (
    select 1 from public.listings l
    join public.creators c on c.id = l.creator_id
    join public.profiles p on p.id = c.owner_id
    where l.id = p_listing
      and (
        c.owner_id = (select auth.uid())
        or (l.status = 'approved' and c.status = 'active' and p.banned_at is null)
      )
  );
$$;

create function public.version_listing(p_version uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select listing_id from public.listing_versions where id = p_version;
$$;

create function public.owns_collection(p_collection uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.collections where id = p_collection and owner_id = (select auth.uid())
  );
$$;

create function public.collection_visible(p_collection uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.collections
    where id = p_collection and (is_public or owner_id = (select auth.uid()))
  );
$$;

-- Owner only in mode owner-approves-all; owner or moderator otherwise.
create function public.can_moderate() returns boolean
language sql stable security definer set search_path = '' as $$
  select case (select moderation_mode from public.library_settings)
    when 'owner-approves-all' then public.is_owner()
    else public.is_staff()
  end;
$$;

-- Row level security -------------------------------------------------------------

alter table public.library_settings enable row level security;
alter table public.creators enable row level security;
alter table public.creator_links enable row level security;
alter table public.creator_featured enable row level security;
alter table public.follows enable row level security;
alter table public.listings enable row level security;
alter table public.listing_versions enable row level security;
alter table public.listing_files enable row level security;
alter table public.print_profiles enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.makes enable row level security;
alter table public.collections enable row level security;
alter table public.collection_items enable row level security;
alter table public.downloads enable row level security;
alter table public.storage_cleanup enable row level security;

-- Removing client write grants is a second line of defense behind the policies.
revoke insert, update, delete, truncate on
  public.creators, public.creator_links, public.creator_featured, public.follows, public.listings,
  public.listing_versions, public.listing_files, public.print_profiles, public.likes, public.comments,
  public.makes, public.collections, public.collection_items
from anon;
revoke all on public.library_settings, public.downloads, public.storage_cleanup from anon, authenticated;
revoke insert, update, delete, truncate on public.listing_files from authenticated;
grant select on public.library_settings to anon, authenticated;
grant select on public.downloads to authenticated;

-- Everyone can see the moderation mode; only set_moderation_mode changes it.
create policy library_settings_read on public.library_settings for select to anon, authenticated using (true);

create policy creators_read on public.creators for select to anon, authenticated
  using (
    (status = 'active' and not public.user_banned(owner_id))
    or owner_id = (select auth.uid())
    or public.is_staff()
  );
create policy creators_insert_own on public.creators for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.is_active_user());
create policy creators_update_own on public.creators for update to authenticated
  using (owner_id = (select auth.uid()) and public.is_active_user())
  with check (owner_id = (select auth.uid()));

create policy creator_links_read on public.creator_links for select to anon, authenticated
  using (
    exists (select 1 from public.creators c where c.id = creator_id)
  );
create policy creator_links_insert_owner on public.creator_links for insert to authenticated
  with check (public.is_creator_owner(creator_id) and public.is_active_user());
create policy creator_links_update_owner on public.creator_links for update to authenticated
  using (public.is_creator_owner(creator_id) and public.is_active_user())
  with check (public.is_creator_owner(creator_id));
create policy creator_links_delete_owner on public.creator_links for delete to authenticated
  using (public.is_creator_owner(creator_id));

create policy creator_featured_read on public.creator_featured for select to anon, authenticated
  using (public.listing_visible(listing_id));
create policy creator_featured_insert_owner on public.creator_featured for insert to authenticated
  with check (public.is_creator_owner(creator_id) and public.is_active_user());
create policy creator_featured_update_owner on public.creator_featured for update to authenticated
  using (public.is_creator_owner(creator_id) and public.is_active_user())
  with check (public.is_creator_owner(creator_id));
create policy creator_featured_delete_owner on public.creator_featured for delete to authenticated
  using (public.is_creator_owner(creator_id));

-- follows: private to the follower; counts come from creator_followers().
create policy follows_read_own on public.follows for select to authenticated using (user_id = (select auth.uid()));
create policy follows_insert_own on public.follows for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user());
create policy follows_delete_own on public.follows for delete to authenticated using (user_id = (select auth.uid()));

-- Listings: approved ones are public, the rest are visible to their creator and staff.
-- Staff change listings only through the moderation functions.
create policy listings_read on public.listings for select to anon, authenticated
  using (public.listing_visible(id));
create policy listings_insert_owner on public.listings for insert to authenticated
  with check (public.is_creator_owner(creator_id) and public.is_active_user());
create policy listings_update_owner on public.listings for update to authenticated
  using (public.is_creator_owner(creator_id) and public.is_active_user())
  with check (public.is_creator_owner(creator_id));
create policy listings_delete_owner on public.listings for delete to authenticated
  using (status in ('pending', 'rejected', 'archived') and public.is_creator_owner(creator_id));

-- Versions are readable once approved (and by the creator and staff at any
-- stage). Files and print profiles follow their version.
create policy versions_read on public.listing_versions for select to anon, authenticated
  using (
    public.listing_visible(listing_id)
    and (review_status = 'approved' or public.can_edit_listing(listing_id) or public.is_staff())
  );
create policy versions_insert_owner on public.listing_versions for insert to authenticated
  with check (public.can_edit_listing(listing_id));
create policy versions_update_owner on public.listing_versions for update to authenticated
  using (public.can_edit_listing(listing_id)) with check (public.can_edit_listing(listing_id));

create function public.version_visible(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.listing_versions v
    where v.id = p_version
      and public.listing_visible(v.listing_id)
      and (v.review_status = 'approved' or public.can_edit_listing(v.listing_id) or public.is_staff())
  );
$$;

create policy files_read on public.listing_files for select to anon, authenticated
  using (public.version_visible(version_id));

create policy print_profiles_read on public.print_profiles for select to anon, authenticated
  using (public.version_visible(version_id));
create policy print_profiles_insert_owner on public.print_profiles for insert to authenticated
  with check (public.can_edit_listing(public.version_listing(version_id)));
create policy print_profiles_update_owner on public.print_profiles for update to authenticated
  using (public.can_edit_listing(public.version_listing(version_id)))
  with check (public.can_edit_listing(public.version_listing(version_id)));
create policy print_profiles_delete_owner on public.print_profiles for delete to authenticated
  using (public.can_edit_listing(public.version_listing(version_id)));

-- likes are public (they drive counts); written by the member.
create policy likes_read on public.likes for select to anon, authenticated using (public.listing_visible(listing_id));
create policy likes_insert_own on public.likes for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user() and public.listing_visible(listing_id));
create policy likes_delete_own on public.likes for delete to authenticated using (user_id = (select auth.uid()));

-- comments: authors edit the body; deletion is soft, through delete_comment,
-- which authors and staff can call. There is no delete policy.
create policy comments_read on public.comments for select to anon, authenticated
  using (deleted_at is null and public.listing_visible(listing_id));
create policy comments_insert_own on public.comments for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user() and public.listing_visible(listing_id));
create policy comments_update_own on public.comments for update to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user()) with check (user_id = (select auth.uid()));

create policy makes_read on public.makes for select to anon, authenticated using (public.listing_visible(listing_id));
create policy makes_insert_own on public.makes for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user() and public.listing_visible(listing_id));
create policy makes_delete_own on public.makes for delete to authenticated using (user_id = (select auth.uid()));
create policy makes_delete_staff on public.makes for delete to authenticated using (public.is_staff());

create policy collections_read on public.collections for select to anon, authenticated
  using (is_public or owner_id = (select auth.uid()));
create policy collections_insert_own on public.collections for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.is_active_user());
create policy collections_update_own on public.collections for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy collections_delete_own on public.collections for delete to authenticated using (owner_id = (select auth.uid()));

create policy collection_items_read on public.collection_items for select to anon, authenticated
  using (public.collection_visible(collection_id) and public.listing_visible(listing_id));
create policy collection_items_insert_own on public.collection_items for insert to authenticated
  with check (public.owns_collection(collection_id) and public.is_active_user() and public.listing_visible(listing_id));
create policy collection_items_delete_own on public.collection_items for delete to authenticated
  using (public.owns_collection(collection_id));

create policy downloads_read_own on public.downloads for select to authenticated using (user_id = (select auth.uid()));

-- Moderation ----------------------------------------------------------------------

-- The review queue. Only staff get rows. A row is a pending listing, or an
-- approved listing with a new version waiting. ready is true when the listing
-- has a usable file and every waiting version has passed the scan.
create view public.moderation_queue with (security_invoker = on) as
select
  l.id as listing_id,
  l.slug,
  l.title,
  l.status,
  l.created_at as submitted_at,
  c.id as creator_id,
  c.handle as creator_handle,
  c.trusted as creator_trusted,
  c.owner_id as uploader_id,
  p.banned_at is not null as uploader_banned,
  (select count(*) from public.listings o where o.creator_id = c.id and o.status = 'approved') as creator_approved_count,
  (select count(*) from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending') as waiting_versions,
  (exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status <> 'rejected')
    and not exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending' and v.scan_status <> 'clean')) as ready
from public.listings l
join public.creators c on c.id = l.creator_id
join public.profiles p on p.id = c.owner_id
where public.is_staff()
  and (
    l.status = 'pending'
    or (l.status = 'approved' and exists (
      select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending'
    ))
  )
order by l.created_at;
revoke all on public.moderation_queue from anon;
grant select on public.moderation_queue to authenticated;

-- Approves a listing and every version waiting on it. Every waiting version
-- must have passed the scan.
create function public.approve_listing(p_listing uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.listings%rowtype;
begin
  if not public.can_moderate() then
    raise exception 'you cannot approve uploads in the current moderation mode' using errcode = '42501';
  end if;
  select * into l from public.listings where id = p_listing for update;
  if not found then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;
  if l.status not in ('pending', 'approved') then
    raise exception 'a % listing is not waiting for review', l.status using errcode = 'P0001';
  end if;
  if public.is_creator_owner(l.creator_id) and not public.is_owner() then
    raise exception 'another staff member has to review your own upload' using errcode = '42501';
  end if;
  -- A pending listing needs a file that was not rejected. An approved one needs a waiting version.
  if not exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status <> 'rejected')
     or (l.status = 'approved' and not exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending')) then
    raise exception 'nothing is waiting for review' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.listing_versions v
    where v.listing_id = l.id and v.review_status = 'pending' and v.scan_status <> 'clean'
  ) then
    raise exception 'a file has not passed the upload scan yet' using errcode = 'P0001';
  end if;
  update public.listing_versions set review_status = 'approved' where listing_id = l.id and review_status = 'pending';
  update public.listings set
    status = 'approved',
    review_note = null,
    reviewed_by = (select auth.uid()),
    reviewed_at = now(),
    published_at = coalesce(published_at, now())
  where id = l.id;
  perform public.audit('approve', 'listing', l.id, p_note, jsonb_build_object('title', l.title));
end;
$$;

-- Rejects a pending listing, or the waiting versions of an approved one. The
-- reason is required and shown to the creator.
create function public.reject_listing(p_listing uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.listings%rowtype;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.can_moderate() then
    raise exception 'you cannot reject uploads in the current moderation mode' using errcode = '42501';
  end if;
  if char_length(reason) < 3 then
    raise exception 'give the creator a reason' using errcode = '23514';
  end if;
  select * into l from public.listings where id = p_listing for update;
  if not found then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;
  if l.status not in ('pending', 'approved') then
    raise exception 'a % listing is not waiting for review', l.status using errcode = 'P0001';
  end if;
  if public.is_creator_owner(l.creator_id) and not public.is_owner() then
    raise exception 'another staff member has to review your own upload' using errcode = '42501';
  end if;
  update public.listing_versions set review_status = 'rejected' where listing_id = l.id and review_status = 'pending';
  if l.status = 'pending' then
    update public.listings set status = 'rejected', review_note = reason, reviewed_by = (select auth.uid()), reviewed_at = now()
    where id = l.id;
  end if;
  perform public.audit('reject', 'listing', l.id, reason, jsonb_build_object('title', l.title, 'was', l.status));
end;
$$;

-- Takes an approved listing down, with a reason the creator sees.
create function public.remove_listing(p_listing uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.listings%rowtype;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.can_moderate() then
    raise exception 'you cannot remove listings in the current moderation mode' using errcode = '42501';
  end if;
  if char_length(reason) < 3 then
    raise exception 'give the creator a reason' using errcode = '23514';
  end if;
  select * into l from public.listings where id = p_listing for update;
  if not found then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;
  if l.status = 'removed' then
    return;
  end if;
  update public.listings set status = 'removed', review_note = reason, reviewed_by = (select auth.uid()), reviewed_at = now()
  where id = l.id;
  perform public.audit('remove', 'listing', l.id, reason, jsonb_build_object('title', l.title, 'was', l.status));
end;
$$;

-- Owner only.
create function public.set_moderation_mode(p_mode text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  old_mode text;
begin
  if not public.is_owner() then
    raise exception 'only the owner can change the moderation mode' using errcode = '42501';
  end if;
  if p_mode not in ('owner-approves-all', 'moderators', 'trusted-creators', 'auto-after-scan') then
    raise exception 'unknown moderation mode' using errcode = '23514';
  end if;
  select moderation_mode into old_mode from public.library_settings;
  update public.library_settings set moderation_mode = p_mode, updated_at = now();
  perform public.audit('set_moderation_mode', 'setting', null, null, jsonb_build_object('from', old_mode, 'to', p_mode));
end;
$$;

-- Owner only.
create function public.set_creator_trusted(p_creator uuid, p_trusted boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_owner() then
    raise exception 'only the owner can mark a creator trusted' using errcode = '42501';
  end if;
  update public.creators set trusted = p_trusted where id = p_creator;
  if not found then
    raise exception 'no such creator' using errcode = 'P0002';
  end if;
  perform public.audit(case when p_trusted then 'trust' else 'untrust' end, 'creator', p_creator, null, '{}'::jsonb);
end;
$$;

-- Upload scan pipeline ------------------------------------------------------------
-- The client makes the listing and a version row, uploads the file to the
-- quarantine bucket, then calls submit_version. The scan service (service
-- role) claims queued versions, checks them, copies clean files to the
-- listing-files bucket and calls finish_scan. Clients never write to
-- listing-files.

create function public.submit_version(p_version uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.listing_versions%rowtype;
begin
  select * into v from public.listing_versions where id = p_version for update;
  if not found or not public.can_edit_listing(v.listing_id) then
    raise exception 'no such version' using errcode = 'P0002';
  end if;
  if v.scan_status <> 'uploading' then
    raise exception 'this version was already submitted' using errcode = 'P0001';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'uploads-quarantine' and o.name = v.storage_path) then
    raise exception 'upload the file to uploads-quarantine first' using errcode = 'P0001';
  end if;
  update public.listing_versions set scan_status = 'queued' where id = v.id;
end;
$$;

-- Service role. Returns the next queued version, marking it scanning.
create function public.claim_scan(p_worker text) returns setof public.listing_versions
language sql volatile security definer set search_path = '' as $$
  update public.listing_versions set scan_status = 'scanning', scan_worker = left(p_worker, 80), scan_started_at = now()
  where id = (
    select id from public.listing_versions where scan_status = 'queued'
    order by created_at limit 1 for update skip locked
  )
  returning *;
$$;

-- Service role. Puts scans that a dead worker left behind back in the queue.
create function public.requeue_stale_scans(p_older_than interval default interval '15 minutes') returns integer
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.listing_versions set scan_status = 'queued', scan_worker = null, scan_started_at = null
    where scan_status = 'scanning' and scan_started_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer from done;
$$;

-- Service role. Records a scan result. On success the caller has already
-- copied the file to listing-files; p_parts is the verified manifest, an
-- array of {name, role, format, size_bytes, sha256}. On failure the version
-- is rejected, and a pending listing with nothing left to review is rejected
-- too. Under 'trusted-creators' a clean upload from a trusted creator is
-- approved at once; under 'auto-after-scan', any clean upload is.
create function public.finish_scan(
  p_version uuid, p_ok boolean, p_report jsonb, p_sha256 text default null, p_size_bytes bigint default null, p_parts jsonb default '[]'::jsonb,
  p_storage_path text default null, p_format text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.listing_versions%rowtype;
  l public.listings%rowtype;
  c public.creators%rowtype;
begin
  select * into v from public.listing_versions where id = p_version for update;
  if not found then
    raise exception 'no such version' using errcode = 'P0002';
  end if;
  if v.scan_status <> 'scanning' then
    raise exception 'this version is not being scanned' using errcode = 'P0001';
  end if;
  select * into l from public.listings where id = v.listing_id;
  select * into c from public.creators where id = l.creator_id;
  if p_ok then
    update public.listing_versions set
      scan_status = 'clean',
      scan_report = p_report,
      scanned_at = now(),
      sha256 = coalesce(p_sha256, sha256),
      size_bytes = coalesce(p_size_bytes, size_bytes),
      -- A converted file (an STL stored as sx3mf) is renamed and retyped here.
      storage_path = coalesce(p_storage_path, storage_path),
      format = coalesce(p_format, format)
    where id = v.id;
    delete from public.listing_files where version_id = v.id;
    insert into public.listing_files (version_id, name, role, format, size_bytes, sha256)
    select v.id, e ->> 'name', e ->> 'role', e ->> 'format', (e ->> 'size_bytes')::bigint, e ->> 'sha256'
    from jsonb_array_elements(coalesce(p_parts, '[]'::jsonb)) e;
    if ((select moderation_mode from public.library_settings) = 'auto-after-scan'
        or ((select moderation_mode from public.library_settings) = 'trusted-creators' and c.trusted))
       and not public.user_banned(c.owner_id)
       and not exists (
         select 1 from public.listing_versions x
         where x.listing_id = l.id and x.review_status = 'pending' and x.scan_status <> 'clean'
       ) then
      update public.listing_versions set review_status = 'approved' where listing_id = l.id and review_status = 'pending';
      update public.listings set status = 'approved', review_note = null, reviewed_at = now(), published_at = coalesce(published_at, now())
      where id = l.id and status in ('pending', 'approved');
      insert into public.audit_log (actor_id, action, target_kind, target_id, detail)
      values (null, 'auto_approve', 'listing', l.id, jsonb_build_object('title', l.title, 'creator', c.handle));
    end if;
  else
    update public.listing_versions set
      scan_status = 'rejected', review_status = 'rejected', scan_report = p_report, scanned_at = now()
    where id = v.id;
    if l.status = 'pending' and not exists (
      select 1 from public.listing_versions x where x.listing_id = l.id and x.review_status <> 'rejected'
    ) then
      update public.listings set
        status = 'rejected', review_note = 'A file failed the upload checks. See the scan report on the version.', reviewed_at = now()
      where id = l.id;
    end if;
    insert into public.audit_log (actor_id, action, target_kind, target_id, reason, detail)
    values (null, 'scan_reject', 'version', v.id,
      left(coalesce(p_report ->> 'reason', (
        select coalesce(x ->> 'detail', x ->> 'code', x ->> 'check')
        from jsonb_array_elements(coalesce(p_report -> 'checks', '[]'::jsonb)) x
        where x ->> 'passed' = 'false' limit 1)), 1000),
      jsonb_build_object('listing', l.id));
  end if;
end;
$$;

-- Service role. The scanner itself failed (not the file): try again, and give
-- up after three attempts by rejecting the version with the error recorded.
create function public.retry_scan(p_version uuid, p_error text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.listing_versions%rowtype;
begin
  select * into v from public.listing_versions where id = p_version for update;
  if not found or v.scan_status <> 'scanning' then
    raise exception 'this version is not being scanned' using errcode = 'P0001';
  end if;
  if v.scan_attempts + 1 < 3 then
    update public.listing_versions
    set scan_status = 'queued', scan_attempts = scan_attempts + 1, scan_worker = null, scan_started_at = null
    where id = v.id;
  else
    perform public.finish_scan(v.id, false,
      jsonb_build_object('verdict', 'error', 'reason', 'The scanner could not check this file: ' || left(coalesce(p_error, 'unknown error'), 300)));
  end if;
end;
$$;

-- Service role. Copies the edition's library settings (moderation mode, file
-- size limit, allowed formats) into the database and onto the buckets.
create function public.apply_library_settings(p_mode text, p_max_file_mb integer, p_formats text[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.library_settings
  set moderation_mode = p_mode, max_file_mb = p_max_file_mb, allowed_formats = p_formats, updated_at = now();
  update storage.buckets set file_size_limit = p_max_file_mb::bigint * 1048576
  where id in ('uploads-quarantine', 'listing-files');
  insert into public.audit_log (actor_id, action, target_kind, detail)
  values (null, 'apply_library_settings', 'setting',
    jsonb_build_object('moderation_mode', p_mode, 'max_file_mb', p_max_file_mb, 'allowed_formats', p_formats));
end;
$$;

-- The scan report is visible to the creator and staff only, through this
-- function, because it can name internal scanner details.
create function public.version_scan_report(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select v.scan_report from public.listing_versions v
  where v.id = p_version and (public.can_edit_listing(v.listing_id) or public.is_staff());
$$;

-- Functions the store client calls --------------------------------------------------

-- Counts for listing cards. Only listings the caller can see are returned.
create function public.listing_stats(p_ids uuid[])
returns table (listing_id uuid, likes bigint, makes bigint, comments bigint, downloads bigint)
language sql stable security definer set search_path = '' as $$
  select l.id,
    (select count(*) from public.likes x where x.listing_id = l.id),
    (select count(*) from public.makes x where x.listing_id = l.id),
    (select count(*) from public.comments x where x.listing_id = l.id and x.deleted_at is null),
    (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id)
  from public.listings l
  where l.id = any (p_ids) and public.listing_visible(l.id);
$$;

create function public.creator_followers(p_ids uuid[])
returns table (creator_id uuid, followers bigint)
language sql stable security definer set search_path = '' as $$
  select c.id, (select count(*) from public.follows f where f.creator_id = c.id)
  from public.creators c
  where c.id = any (p_ids)
    and ((c.status = 'active' and not public.user_banned(c.owner_id)) or c.owner_id = (select auth.uid()) or public.is_staff());
$$;

-- Soft-deletes a comment: its author, or staff (which is logged). The text
-- goes with it; replies keep their thread.
create function public.delete_comment(p_comment uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.comments%rowtype;
begin
  select * into c from public.comments where id = p_comment and deleted_at is null for update;
  if not found then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;
  if c.user_id is not distinct from (select auth.uid()) and public.is_active_user() then
    update public.comments set deleted_at = now(), body = '[deleted]' where id = c.id;
  elsif public.is_staff() then
    update public.comments set deleted_at = now(), body = '[deleted]' where id = c.id;
    perform public.audit('delete_comment', 'comment', c.id, null, jsonb_build_object('listing', c.listing_id, 'author', c.user_id));
  else
    raise exception 'you cannot delete this comment' using errcode = '42501';
  end if;
end;
$$;

-- Counts a download for the signed-in member. Approved listings only.
create function public.record_download(p_listing uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null or not public.is_active_user() then
    raise exception 'sign in to download' using errcode = '42501';
  end if;
  if not exists (select 1 from public.listings l where l.id = p_listing and l.status = 'approved') or not public.listing_visible(p_listing) then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;
  insert into public.downloads as d (user_id, listing_id) values (uid, p_listing)
  on conflict (user_id, listing_id) do update set count = d.count + 1, last_at = now();
end;
$$;

-- What the creator dashboard shows: totals per listing for the signed-in creator.
create function public.creator_dashboard()
returns table (listing_id uuid, title text, status text, likes bigint, comments bigint, makes bigint, downloads bigint)
language sql stable security definer set search_path = '' as $$
  select l.id, l.title, l.status,
    (select count(*) from public.likes x where x.listing_id = l.id),
    (select count(*) from public.comments x where x.listing_id = l.id and x.deleted_at is null),
    (select count(*) from public.makes x where x.listing_id = l.id),
    (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id)
  from public.listings l
  join public.creators c on c.id = l.creator_id
  where c.owner_id = (select auth.uid())
  order by l.created_at desc;
$$;

revoke execute on function
  public.approve_listing(uuid, text), public.reject_listing(uuid, text), public.remove_listing(uuid, text),
  public.set_moderation_mode(text), public.set_creator_trusted(uuid, boolean), public.submit_version(uuid),
  public.version_scan_report(uuid), public.record_download(uuid), public.creator_dashboard(), public.delete_comment(uuid)
from anon, public;
-- Supabase grants new functions to every API role, so the service-only ones
-- are revoked from authenticated by name.
revoke execute on function
  public.claim_scan(text), public.requeue_stale_scans(interval), public.finish_scan(uuid, boolean, jsonb, text, bigint, jsonb, text, text),
  public.retry_scan(uuid, text), public.apply_library_settings(text, integer, text[])
from anon, authenticated, public;
grant execute on function
  public.approve_listing(uuid, text), public.reject_listing(uuid, text), public.remove_listing(uuid, text),
  public.set_moderation_mode(text), public.set_creator_trusted(uuid, boolean), public.submit_version(uuid),
  public.version_scan_report(uuid), public.record_download(uuid), public.creator_dashboard(), public.delete_comment(uuid)
to authenticated;
grant execute on function
  public.claim_scan(text), public.requeue_stale_scans(interval),
  public.finish_scan(uuid, boolean, jsonb, text, bigint, jsonb, text, text),
  public.retry_scan(uuid, text), public.apply_library_settings(text, integer, text[])
to service_role;

-- Storage ------------------------------------------------------------------------
-- uploads-quarantine: where clients upload. Object names are <listing id>/<version id>/<file name>.
-- Only the scan service reads it. A client may add a file only for a version
-- row it made and has not submitted yet, and only with an allowed extension.
-- listing-files: clean files, written by the service role only. Signed-in
-- members download approved files; creators and staff read their own and all.
insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads-quarantine', 'uploads-quarantine', false, 104857600), ('listing-files', 'listing-files', false, 104857600)
on conflict (id) do update set file_size_limit = excluded.file_size_limit, public = false;

create function public.path_listing(p_path text) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when split_part(p_path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_path, '/', 1)::uuid
  end;
$$;

-- The object name must be exactly a version row's storage_path, and that
-- version must still be uploading and belong to a listing the caller edits.
create function public.can_upload_quarantine(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    exists (
      select 1 from public.listing_versions v
      where v.storage_path = p_path and v.scan_status = 'uploading' and public.can_edit_listing(v.listing_id)
    ),
    false
  );
$$;

create function public.can_download(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    public.is_active_user() and (
      public.is_staff()
      or public.can_edit_listing(public.path_listing(p_path))
      or exists (
        select 1 from public.listing_versions v
        where v.storage_path = p_path and v.review_status = 'approved' and v.scan_status = 'clean'
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

create policy uploads_quarantine_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads-quarantine' and public.can_upload_quarantine(name));
create policy uploads_quarantine_replace on storage.objects for delete to authenticated
  using (bucket_id = 'uploads-quarantine' and public.can_upload_quarantine(name));
create policy listing_files_download on storage.objects for select to authenticated
  using (bucket_id = 'listing-files' and public.can_download(name));
