-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module, part 2: downloading approved files without signing in.
--
-- A visitor calls request_download(listing). It checks that the listing and
-- the file are public, counts the download against a per-IP limit and
-- returns a grant: a random token, valid for one file for a short time
-- (library_settings.grant_seconds). The visitor then reads the file straight
-- from the listing-files bucket with the anon key and the token in the
-- x-sx-download-grant header. The storage policy accepts the token only for
-- direct reads (storage.operation get_authenticated or info_authenticated),
-- never for signing, so a grant cannot be turned into a long-lived URL.
--
-- Client IPs are never stored. The limit counts by an HMAC of the IP and the
-- current day under a private salt, so counts cannot be linked across days.
-- Rows older than two days are pruned as new downloads come in.
--
-- Which header holds the client IP depends on the proxy in front of the API
-- (library_settings.client_ip_source):
--   x-forwarded-for-last  the hop the API gateway appended (local Kong; default)
--   x-real-ip             set by the gateway from the connection
--   cf-connecting-ip      only behind Cloudflare, which overwrites it
--   x-forwarded-for-first only behind a proxy that strips client-sent values
-- Choosing a header the client can set lets a visitor pick their own bucket.
-- Removed together with the store by modules/drop_store.sql.

alter table public.library_settings
  add column anon_downloads boolean not null default true,
  add column anon_per_hour integer not null default 20 check (anon_per_hour between 1 and 1000),
  add column anon_per_day integer not null default 60 check (anon_per_day between 1 and 10000),
  add column grant_seconds integer not null default 120 check (grant_seconds between 10 and 900),
  add column client_ip_source text not null default 'x-forwarded-for-last'
    check (client_ip_source in ('x-forwarded-for-last', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-for-first')),
  add constraint library_settings_anon_limits check (anon_per_hour <= anon_per_day);

-- The salt for IP hashes. One row, no client access, read only by the
-- security definer functions below.
create table public.download_secret (
  id boolean primary key default true check (id),
  salt bytea not null default extensions.gen_random_bytes(32)
);
insert into public.download_secret default values;

-- Anonymous downloads per IP hash and hour. The hash already includes the
-- day, so a day's total is the sum of that hash's rows.
create table public.anon_download_usage (
  ip_hash text not null,
  hour timestamptz not null,
  count integer not null default 1 check (count >= 1),
  primary key (ip_hash, hour)
);
create index anon_download_usage_hour_idx on public.anon_download_usage (hour);

-- Anonymous downloads per listing and day, for listing cards and the creator dashboard.
create table public.anon_downloads (
  listing_id uuid not null references public.listings (id) on delete cascade,
  day date not null,
  count integer not null default 1 check (count >= 1),
  primary key (listing_id, day)
);

-- Short-lived grants. Only the SHA-256 of the token is kept.
create table public.download_grants (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  storage_path text not null,
  listing_id uuid not null references public.listings (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index download_grants_expires_idx on public.download_grants (expires_at);

alter table public.download_secret enable row level security;
alter table public.anon_download_usage enable row level security;
alter table public.anon_downloads enable row level security;
alter table public.download_grants enable row level security;
revoke all on public.download_secret, public.anon_download_usage, public.anon_downloads, public.download_grants
  from anon, authenticated, public;

-- The client IP from the PostgREST or storage request headers, by the
-- configured source. Null when the header is missing.
create function public.client_ip() returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  src text := (select client_ip_source from public.library_settings);
  xff text[];
  ip text;
begin
  if src in ('x-forwarded-for-last', 'x-forwarded-for-first') then
    xff := regexp_split_to_array(coalesce(h ->> 'x-forwarded-for', ''), '\s*,\s*');
    ip := case src when 'x-forwarded-for-last' then xff[cardinality(xff)] else xff[1] end;
  else
    ip := h ->> src;
  end if;
  return nullif(btrim(coalesce(ip, '')), '');
end;
$$;

-- HMAC of the IP and today's date. Requests with no IP share one bucket, so a
-- misconfigured proxy limits everyone together instead of no one.
create function public.client_ip_hash() returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(
    convert_to(coalesce(public.client_ip(), 'unknown') || '|' || current_date::text, 'UTF8'),
    (select salt from public.download_secret),
    'sha256'), 'hex');
$$;

-- The file a download gets: the newest approved, clean version of a public
-- listing. Null when the listing is not public or has no such version.
create function public.public_download_path(p_listing uuid) returns text
language sql stable security definer set search_path = '' as $$
  select v.storage_path
  from public.listing_versions v
  join public.listings l on l.id = v.listing_id
  join public.creators c on c.id = l.creator_id
  join public.profiles p on p.id = c.owner_id
  where v.listing_id = p_listing
    and l.status = 'approved' and c.status = 'active' and p.banned_at is null
    and v.review_status = 'approved' and v.scan_status = 'clean'
  order by string_to_array(v.version, '.')::int[] desc, v.created_at desc
  limit 1;
$$;

-- True when this object is a model file or preview image of an approved,
-- clean version of a public listing. Checked again at read time, so a
-- takedown also stops grants already handed out.
create function public.is_public_file(p_path text) returns boolean
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
        v.storage_path = p_path
        or exists (
          select 1 from public.listing_files f
          where f.version_id = v.id and f.role = 'image'
            and v.listing_id::text || '/' || v.id::text || '/' || f.name = p_path
        )
      )
  ), false);
$$;

create function public.is_public_image(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(exists (
    select 1
    from public.listing_files f
    join public.listing_versions v on v.id = f.version_id
    where f.role = 'image' and v.listing_id::text || '/' || v.id::text || '/' || f.name = p_path
  ), false) and public.is_public_file(p_path);
$$;

-- Starts a download for anyone. Signed-in members are counted as before
-- (downloads table, no limit) and get no grant: they read the file with their
-- own session. Visitors are counted per IP hash and get a grant.
-- Returns { path, version_id, version, grant, expires_at }.
create function public.request_download(p_listing uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  s public.library_settings%rowtype;
  v_path text;
  v public.listing_versions%rowtype;
  v_hash text;
  v_hour integer;
  v_day integer;
  v_token text;
  v_expires timestamptz;
begin
  if uid is not null then
    perform public.record_download(p_listing);
    v_path := public.public_download_path(p_listing);
    if v_path is null then
      raise exception 'no such listing' using errcode = 'P0002';
    end if;
    select * into v from public.listing_versions where storage_path = v_path;
    return jsonb_build_object('path', v_path, 'version_id', v.id, 'version', v.version, 'grant', null, 'expires_at', null);
  end if;

  select * into s from public.library_settings;
  if not s.anon_downloads then
    raise exception 'sign in to download' using errcode = '42501';
  end if;
  v_path := public.public_download_path(p_listing);
  if v_path is null then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;

  v_hash := public.client_ip_hash();
  -- Serialize requests from one IP so two at once cannot both pass the limit.
  perform pg_advisory_xact_lock(hashtextextended('anon-download:' || v_hash, 0));
  select coalesce(sum(count) filter (where hour = date_trunc('hour', now())), 0), coalesce(sum(count), 0)
    into v_hour, v_day
  from public.anon_download_usage where ip_hash = v_hash;
  if v_hour >= s.anon_per_hour or v_day >= s.anon_per_day then
    raise exception 'too many downloads from this network; try again later or sign in'
      using errcode = 'P0001', hint = 'rate_limited';
  end if;

  insert into public.anon_download_usage as u (ip_hash, hour) values (v_hash, date_trunc('hour', now()))
  on conflict (ip_hash, hour) do update set count = u.count + 1;
  insert into public.anon_downloads as d (listing_id, day) values (p_listing, current_date)
  on conflict (listing_id, day) do update set count = d.count + 1;

  v_token := 'sxg_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_expires := now() + make_interval(secs => s.grant_seconds);
  insert into public.download_grants (token_hash, storage_path, listing_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_path, p_listing, v_expires);

  -- Housekeeping, bounded so one request never does much of it.
  delete from public.download_grants where token_hash in (
    select token_hash from public.download_grants where expires_at < now() - interval '5 minutes' limit 200);
  delete from public.anon_download_usage where (ip_hash, hour) in (
    select ip_hash, hour from public.anon_download_usage where hour < now() - interval '2 days' limit 200);

  select * into v from public.listing_versions where storage_path = v_path;
  return jsonb_build_object('path', v_path, 'version_id', v.id, 'version', v.version, 'grant', v_token, 'expires_at', v_expires);
end;
$$;

-- Storage check for visitors: preview images of public versions always; a
-- model file only with a live grant for exactly that path, and only on a
-- direct read, never when signing a URL.
create function public.can_download_anon(p_path text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  op text := coalesce(current_setting('storage.operation', true), '');
  token text := h ->> 'x-sx-download-grant';
begin
  if not (select anon_downloads from public.library_settings) then
    return false;
  end if;
  if public.is_public_image(p_path) then
    return true;
  end if;
  if token is null or op not in ('storage.object.get_authenticated', 'storage.object.info_authenticated') then
    return false;
  end if;
  return exists (
    select 1 from public.download_grants g
    where g.token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
      and g.storage_path = p_path and g.expires_at > now()
  ) and public.is_public_file(p_path);
end;
$$;

create policy listing_files_download_anon on storage.objects for select to anon
  using (bucket_id = 'listing-files' and public.can_download_anon(name));

-- The owner turns anonymous downloads on or off and sets the limits.
create function public.set_anon_downloads(p_enabled boolean, p_per_hour integer, p_per_day integer) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  old jsonb;
begin
  if not public.is_owner() or not public.is_active_user() then
    raise exception 'only the owner can change download limits' using errcode = '42501';
  end if;
  select jsonb_build_object('enabled', anon_downloads, 'per_hour', anon_per_hour, 'per_day', anon_per_day) into old from public.library_settings;
  update public.library_settings
  set anon_downloads = p_enabled, anon_per_hour = p_per_hour, anon_per_day = p_per_day, updated_at = now();
  perform public.audit('set_anon_downloads', 'setting', null, null, jsonb_build_object('from', old,
    'to', jsonb_build_object('enabled', p_enabled, 'per_hour', p_per_hour, 'per_day', p_per_day)));
end;
$$;

-- Counts now include anonymous downloads. Same signatures as before.
create or replace function public.listing_stats(p_ids uuid[])
returns table (listing_id uuid, likes bigint, makes bigint, comments bigint, downloads bigint)
language sql stable security definer set search_path = '' as $$
  select l.id,
    (select count(*) from public.likes x where x.listing_id = l.id),
    (select count(*) from public.makes x where x.listing_id = l.id),
    (select count(*) from public.comments x where x.listing_id = l.id and x.deleted_at is null),
    (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id)
      + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id)
  from public.listings l
  where l.id = any (p_ids) and public.listing_visible(l.id);
$$;

create or replace function public.creator_dashboard()
returns table (listing_id uuid, title text, status text, likes bigint, comments bigint, makes bigint, downloads bigint)
language sql stable security definer set search_path = '' as $$
  select l.id, l.title, l.status,
    (select count(*) from public.likes x where x.listing_id = l.id),
    (select count(*) from public.comments x where x.listing_id = l.id and x.deleted_at is null),
    (select count(*) from public.makes x where x.listing_id = l.id),
    (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id)
      + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id)
  from public.listings l
  join public.creators c on c.id = l.creator_id
  where c.owner_id = (select auth.uid())
  order by l.created_at desc;
$$;

-- Helpers are internal; only request_download and the owner setting are callable.
revoke execute on function
  public.client_ip(), public.client_ip_hash(), public.public_download_path(uuid),
  public.is_public_file(text), public.is_public_image(text)
from anon, authenticated, public;
-- The storage policy runs as the caller, so anon needs the policy function.
revoke execute on function public.can_download_anon(text) from public;
grant execute on function public.can_download_anon(text) to anon;
revoke execute on function public.set_anon_downloads(boolean, integer, integer) from anon, public;
grant execute on function public.set_anon_downloads(boolean, integer, integer) to authenticated;
grant execute on function public.request_download(uuid) to anon, authenticated;
