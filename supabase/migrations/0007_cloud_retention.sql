-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud retention: uploaded meshes and sliced results are kept for a limited
-- number of days, so a hosted project stays inside its storage allowance.
-- The service calls expire_cloud_files from its purge loop, deletes the files
-- it returns through the Storage API, and the jobs keep their rows and
-- reports without download paths. Part of the cloud module
-- (modules/drop_cloud.sql removes it).

-- Clears the download paths of jobs finished more than p_days ago and returns
-- up to p_limit cloud files older than that, oldest first, for the caller to
-- delete. A mesh still referenced by a queued or running job is kept.
create function public.expire_cloud_files(p_days integer default 7, p_limit integer default 1000)
returns table (bucket text, path text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  update public.cloud_jobs set gcode_path = null, preview_path = null
  where finished_at < cutoff and (gcode_path is not null or preview_path is not null);
  return query
  select o.bucket_id::text, o.name::text
  from storage.objects o
  where o.bucket_id in ('cloud-inputs', 'cloud-results')
    and o.created_at < cutoff
    and not (o.bucket_id = 'cloud-inputs' and exists (
      select 1 from public.cloud_jobs j
      where j.status in ('queued', 'running')
        and j.user_id::text = (storage.foldername(o.name))[1]
        and j.request -> 'plate' -> 'objects' @> jsonb_build_array(jsonb_build_object('mesh', storage.filename(o.name)))
    ))
  order by o.created_at
  limit greatest(p_limit, 1);
end;
$$;

revoke execute on function public.expire_cloud_files(integer, integer) from anon, authenticated, public;
grant execute on function public.expire_cloud_files(integer, integer) to service_role;
