-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud jobs that slice several plates of a 3MF project (`options.plates` in
-- the request). A job still counts once among the five queued or running, and
-- each plate it slices counts against the account's daily slices: a job whose
-- plates are more than the slices left today is refused before it runs.
-- plate_count comes from the request, whoever inserts the row; plate_index is
-- the number of the plate the worker is slicing. Part of the cloud module
-- (modules/drop_cloud.sql removes it with the table).

alter table public.cloud_jobs
  add column plate_count integer not null default 1 check (plate_count between 1 and 32),
  add column plate_index integer check (plate_index >= 1);

-- The jobs check of 0006_cloud_access.sql, counting plates for the daily limit.
create or replace function public.check_cloud_job() returns trigger
language plpgsql set search_path = '' as $$
declare
  per_day integer;
  used integer;
  plates jsonb := new.request -> 'options' -> 'plates';
begin
  perform pg_advisory_xact_lock(hashtextextended('cloud_jobs:' || new.user_id::text, 0));
  new.plate_count := case when jsonb_typeof(plates) = 'array' then greatest(jsonb_array_length(plates), 1) else 1 end;
  if not public.has_cloud_access(new.user_id) then
    raise exception 'cloud slicing is invite only, and this account is not on the list' using errcode = '42501';
  end if;
  select a.jobs_per_day into per_day from public.cloud_access a where a.user_id = new.user_id;
  select coalesce(sum(j.plate_count), 0)::integer into used from public.cloud_jobs j
  where j.user_id = new.user_id and j.created_at > now() - interval '1 day';
  if used >= per_day then
    raise exception 'this account has used its % cloud slices for the last 24 hours', per_day using errcode = 'P0001';
  end if;
  if used + new.plate_count > per_day then
    raise exception 'this job slices % plates, and this account can slice % more % today',
      new.plate_count, per_day - used, case when per_day - used = 1 then 'plate' else 'plates' end
      using errcode = 'P0001';
  end if;
  if (select count(*) from public.cloud_jobs j where j.user_id = new.user_id and j.status in ('queued', 'running')) >= 5 then
    raise exception 'five jobs are already queued or running; wait for one to finish' using errcode = 'P0001';
  end if;
  if new.target_printer_id is not null and not exists (
    select 1 from public.sync_printers p
    where p.id = new.target_printer_id and p.user_id = new.user_id and not p.deleted and p.device_id is not null
  ) then
    raise exception 'the target printer must be one of the owner''s printers on a bridge' using errcode = '23503';
  end if;
  return new;
end;
$$;

-- The account's limits and today's use, or no row when it has no access.
-- jobs_today counts every plate of every job created in the last 24 hours,
-- canceled ones too.
create or replace function public.cloud_quota(p_user uuid)
returns table (jobs_per_day integer, jobs_today integer, max_upload_bytes bigint)
language sql stable security definer set search_path = '' as $$
  select
    a.jobs_per_day,
    (select coalesce(sum(j.plate_count), 0)::integer from public.cloud_jobs j
      where j.user_id = a.user_id and j.created_at > now() - interval '1 day'),
    a.max_upload_mb::bigint * 1048576
  from public.cloud_access a
  join public.profiles p on p.id = a.user_id
  where a.user_id = p_user and p.banned_at is null;
$$;
