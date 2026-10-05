-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud access: hosted cloud slicing is invite only. An account can upload
-- meshes, queue jobs and read results only while it has a cloud_access row and
-- is not banned. The row also sets the account's limits: jobs per rolling 24
-- hours and the largest mesh it may upload. Only the service role writes the
-- list, through grant_cloud_access and revoke_cloud_access. Part of the cloud
-- module (modules/drop_cloud.sql removes it).

create table public.cloud_access (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  jobs_per_day integer not null default 20 check (jobs_per_day between 1 and 10000),
  -- The cloud-inputs bucket refuses anything over 50 MB, so that is the ceiling.
  max_upload_mb integer not null default 25 check (max_upload_mb between 1 and 50),
  note text check (char_length(note) <= 200),
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cloud_access enable row level security;
revoke all on public.cloud_access from anon, authenticated;
grant select on public.cloud_access to authenticated;
-- Members can see their own row (the app shows the limits); nobody but the
-- service role can write.
create policy cloud_access_read_own on public.cloud_access for select to authenticated
  using (user_id = (select auth.uid()));

-- True when the account is on the list and not banned.
create function public.has_cloud_access(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.cloud_access a join public.profiles p on p.id = a.user_id
    where a.user_id = p_user and p.banned_at is null
  );
$$;

-- The account's limits and today's use, or no row when it has no access.
-- jobs_today counts every job created in the last 24 hours, canceled ones too.
create function public.cloud_quota(p_user uuid)
returns table (jobs_per_day integer, jobs_today integer, max_upload_bytes bigint)
language sql stable security definer set search_path = '' as $$
  select
    a.jobs_per_day,
    (select count(*)::integer from public.cloud_jobs j
      where j.user_id = a.user_id and j.created_at > now() - interval '1 day'),
    a.max_upload_mb::bigint * 1048576
  from public.cloud_access a
  join public.profiles p on p.id = a.user_id
  where a.user_id = p_user and p.banned_at is null;
$$;

-- The caller's own limits, for the app.
create function public.my_cloud_quota()
returns table (jobs_per_day integer, jobs_today integer, max_upload_bytes bigint)
language sql stable security definer set search_path = '' as $$
  select * from public.cloud_quota((select auth.uid()));
$$;

-- Adds an account by email, or updates its limits. The account must exist:
-- invite the person first (Authentication, Users, Invite user), then grant.
create function public.grant_cloud_access(
  p_email text,
  p_jobs_per_day integer default 20,
  p_max_upload_mb integer default 25,
  p_note text default null
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if uid is null then
    raise exception 'no account has the email %; invite the person first', p_email using errcode = '22023';
  end if;
  insert into public.cloud_access (user_id, jobs_per_day, max_upload_mb, note)
  values (uid, p_jobs_per_day, p_max_upload_mb, p_note)
  on conflict (user_id) do update set
    jobs_per_day = excluded.jobs_per_day,
    max_upload_mb = excluded.max_upload_mb,
    note = coalesce(excluded.note, public.cloud_access.note),
    updated_at = now();
  insert into public.audit_log (actor_id, action, target_kind, target_id, detail)
  values (null, 'cloud.grant', 'user', uid,
    jsonb_build_object('jobs_per_day', p_jobs_per_day, 'max_upload_mb', p_max_upload_mb));
  return uid;
end;
$$;

-- Removes an account from the list. Its queued jobs are canceled; a running
-- job finishes, and its files stay until the account is deleted.
create function public.revoke_cloud_access(p_email text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid;
  removed boolean;
begin
  select u.id into uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if uid is null then
    return false;
  end if;
  update public.cloud_jobs set status = 'canceled', finished_at = now()
  where user_id = uid and status = 'queued';
  delete from public.cloud_access where user_id = uid;
  removed := found;
  if removed then
    insert into public.audit_log (actor_id, action, target_kind, target_id)
    values (null, 'cloud.revoke', 'user', uid);
  end if;
  return removed;
end;
$$;

revoke execute on function public.has_cloud_access(uuid) from anon, public;
revoke execute on function public.cloud_quota(uuid) from anon, authenticated, public;
revoke execute on function public.my_cloud_quota() from anon, public;
revoke execute on function public.grant_cloud_access(text, integer, integer, text) from anon, authenticated, public;
revoke execute on function public.revoke_cloud_access(text) from anon, authenticated, public;
-- authenticated needs it for the storage policy below.
grant execute on function public.has_cloud_access(uuid) to authenticated, service_role;
grant execute on function public.cloud_quota(uuid) to service_role;
grant execute on function public.my_cloud_quota() to authenticated;
grant execute on function public.grant_cloud_access(text, integer, integer, text) to service_role;
grant execute on function public.revoke_cloud_access(text) to service_role;

-- Jobs: the database refuses a job for an account without access or over its
-- daily limit, whoever inserts it. A per-account lock keeps two concurrent
-- inserts from both passing the counts.
create or replace function public.check_cloud_job() returns trigger
language plpgsql set search_path = '' as $$
declare
  per_day integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('cloud_jobs:' || new.user_id::text, 0));
  if not public.has_cloud_access(new.user_id) then
    raise exception 'cloud slicing is invite only, and this account is not on the list' using errcode = '42501';
  end if;
  select a.jobs_per_day into per_day from public.cloud_access a where a.user_id = new.user_id;
  if (select count(*) from public.cloud_jobs j
      where j.user_id = new.user_id and j.created_at > now() - interval '1 day') >= per_day then
    raise exception 'this account has used its % cloud slices for the last 24 hours', per_day using errcode = 'P0001';
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
-- Storage: members read their own cloud files only while they have access.
drop policy cloud_files_read_own on storage.objects;
create policy cloud_files_read_own on storage.objects for select to authenticated
  using (
    bucket_id in ('cloud-inputs', 'cloud-results')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.has_cloud_access((select auth.uid())))
  );
