-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module, listing size: how big a version prints, x, y and z in mm with Z up, shown on the listing as
-- "Size 30.0 x 12.0 x 8.0 mm". The upload scan measures it and finish_scan keeps it, so it is a scan field like
-- scan_report: clients never write it, and anyone who can read the version reads it (versions_read).
--
-- It comes from the scan report's boundsMm (max minus min), the bounds with every build item and component
-- transform applied. A 3MF report counts only when it names the plate it measured (boundsPlate): the scan writes it
-- since it measures a project on its largest plate, and an older scan measured the first plate, which is not the
-- model's size when it has more than one. An STL has one plate and no transforms, so its bounds always count.
-- Anything else stays null rather than show a wrong size.
-- supabase/modules/drop_store.sql removes the column with the table.

create function public.listing_size_mm(p_report jsonb) returns real[]
language plpgsql immutable set search_path = '' as $$
declare
  lo jsonb := p_report #> '{boundsMm,min}';
  hi jsonb := p_report #> '{boundsMm,max}';
  s numeric[] := '{}';
  d numeric;
begin
  if jsonb_typeof(p_report) is distinct from 'object'
     or not (p_report ? 'boundsPlate' or p_report ->> 'detectedType' = 'stl')
     or jsonb_typeof(lo) is distinct from 'array' or jsonb_typeof(hi) is distinct from 'array'
     or jsonb_array_length(lo) <> 3 or jsonb_array_length(hi) <> 3 then
    return null;
  end if;
  for i in 0..2 loop
    if jsonb_typeof(lo -> i) <> 'number' or jsonb_typeof(hi -> i) <> 'number' then
      return null;
    end if;
    d := round((hi ->> i)::numeric - (lo ->> i)::numeric, 3);
    -- The scan refuses a model over 10 m; anything past that, or inside out, is not a size.
    if d < 0 or d > 100000 then
      return null;
    end if;
    s := s || d;
  end loop;
  return s::real[];
end;
$$;
revoke execute on function public.listing_size_mm(jsonb) from public;
grant execute on function public.listing_size_mm(jsonb) to authenticated, service_role;

alter table public.listing_versions add column size_mm real[]
  constraint listing_versions_size_mm_check check (
    size_mm is null or (cardinality(size_mm) = 3 and array_ndims(size_mm) = 1 and 0 <= all (size_mm) and 100000 >= all (size_mm))
  );

-- As in 0002_store.sql, with size_mm guarded like scan_report: a client's insert starts without it and a client's
-- update cannot change it.
create or replace function public.guard_version_change() returns trigger
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
      new.size_mm := null;
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
     and (new.sha256, new.format, new.size_bytes, new.scan_status, new.scan_report, new.size_mm, new.scan_worker,
          new.scan_started_at, new.scanned_at, new.review_status)
         is distinct from
         (old.sha256, old.format, old.size_bytes, old.scan_status, old.scan_report, old.size_mm, old.scan_worker,
          old.scan_started_at, old.scanned_at, old.review_status) then
    raise exception 'only the changelog can be edited' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- As in 0002_store.sql, with the size kept from the report of a clean scan.
create or replace function public.finish_scan(
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
      size_mm = public.listing_size_mm(p_report),
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
      scan_status = 'rejected', review_status = 'rejected', scan_report = p_report, size_mm = null, scanned_at = now()
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

-- Versions scanned before this migration: only what their reports can vouch for (see the top).
update public.listing_versions
set size_mm = public.listing_size_mm(scan_report)
where scan_status = 'clean' and size_mm is null and public.listing_size_mm(scan_report) is not null;
