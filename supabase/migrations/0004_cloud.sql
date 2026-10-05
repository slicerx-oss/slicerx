-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud module: profile sync (printer, filament and process profiles, printers
-- and fleets), the user's devices, the cloud slicing queue and deliveries of
-- sliced jobs to printers through the user's sx-link bridge. Depends only on
-- the auth module and can be dropped with modules/drop_cloud.sql.

-- Sync ---------------------------------------------------------------------------
-- Every synced row carries a revision from one sequence. The stamp trigger takes
-- a per-user transaction lock before drawing the revision, so one user's
-- revisions are assigned in commit order and a client that pulls everything
-- above its last seen revision never skips a row that commits later.
create sequence public.sync_revision_seq;

create table public.cloud_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('link', 'desktop', 'web', 'mobile')),
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create index cloud_devices_user_idx on public.cloud_devices (user_id);

create table public.sync_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('printer', 'filament', 'process')),
  name text not null check (char_length(name) between 1 and 120),
  -- The profile this one is based on, such as a vendor profile id.
  inherits text check (char_length(inherits) <= 200),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 262144),
  deleted boolean not null default false,
  updated_by uuid references public.cloud_devices (id) on delete set null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create index sync_profiles_user_rev_idx on public.sync_profiles (user_id, revision);

-- Printers carry no credentials and no network addresses. Those stay in the OS
-- keychain and the bridge's own config on the machine that reaches the printer.
create table public.sync_printers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  driver text check (driver ~ '^[a-z0-9_-]{1,40}$'),
  model text check (char_length(model) <= 120),
  printer_profile_id uuid references public.sync_profiles (id) on delete set null,
  -- The bridge that reaches this printer, and the printer's id on that bridge.
  device_id uuid references public.cloud_devices (id) on delete set null,
  local_id text check (char_length(local_id) between 1 and 120),
  settings jsonb not null default '{}' check (
    jsonb_typeof(settings) = 'object'
    and pg_column_size(settings) <= 65536
    and not (settings ?| array['access_code', 'api_key', 'password', 'secret', 'token', 'host', 'ip', 'address', 'serial'])
  ),
  deleted boolean not null default false,
  updated_by uuid references public.cloud_devices (id) on delete set null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (device_id, local_id)
);
create index sync_printers_user_rev_idx on public.sync_printers (user_id, revision);

create table public.sync_fleets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  printer_ids uuid[] not null default '{}' check (cardinality(printer_ids) <= 200),
  deleted boolean not null default false,
  updated_by uuid references public.cloud_devices (id) on delete set null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create index sync_fleets_user_rev_idx on public.sync_fleets (user_id, revision);

create function public.sync_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'a synced row cannot change owner' using errcode = '42501';
  end if;
  if new.updated_by is not null and not exists (
    select 1 from public.cloud_devices d where d.id = new.updated_by and d.user_id = new.user_id
  ) then
    raise exception 'updated_by must be one of the owner''s devices' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sx_sync:' || new.user_id::text, 0));
  new.revision := nextval('public.sync_revision_seq');
  new.updated_at := now();
  return new;
end;
$$;

create trigger sync_profiles_stamp before insert or update on public.sync_profiles
  for each row execute function public.sync_stamp();
create trigger sync_printers_stamp before insert or update on public.sync_printers
  for each row execute function public.sync_stamp();
create trigger sync_fleets_stamp before insert or update on public.sync_fleets
  for each row execute function public.sync_stamp();

-- The linked printer profile must be the owner's printer profile.
create function public.check_printer_profile() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.printer_profile_id is not null and not exists (
    select 1 from public.sync_profiles p
    where p.id = new.printer_profile_id and p.user_id = new.user_id and p.kind = 'printer'
  ) then
    raise exception 'printer_profile_id must be one of the owner''s printer profiles' using errcode = '23503';
  end if;
  if new.device_id is not null and not exists (
    select 1 from public.cloud_devices d where d.id = new.device_id and d.user_id = new.user_id
  ) then
    raise exception 'device_id must be one of the owner''s devices' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger sync_printers_check before insert or update on public.sync_printers
  for each row execute function public.check_printer_profile();

create function public.check_fleet_members() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.sync_printers p where p.id = any (new.printer_ids) and p.user_id = new.user_id)
     <> (select count(distinct x) from unnest(new.printer_ids) x) then
    raise exception 'a fleet can hold only the owner''s printers' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger sync_fleets_check before insert or update on public.sync_fleets
  for each row execute function public.check_fleet_members();

alter table public.cloud_devices enable row level security;
alter table public.sync_profiles enable row level security;
alter table public.sync_printers enable row level security;
alter table public.sync_fleets enable row level security;
revoke all on public.cloud_devices, public.sync_profiles, public.sync_printers, public.sync_fleets from anon;
revoke delete, truncate on public.sync_profiles, public.sync_printers, public.sync_fleets from authenticated;

create policy cloud_devices_own on public.cloud_devices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Rows are never deleted by clients; `deleted` is a tombstone other devices pull.
create policy sync_profiles_read on public.sync_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy sync_profiles_insert on public.sync_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy sync_profiles_update on public.sync_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sync_printers_read on public.sync_printers for select to authenticated
  using (user_id = (select auth.uid()));
create policy sync_printers_insert on public.sync_printers for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy sync_printers_update on public.sync_printers for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sync_fleets_read on public.sync_fleets for select to authenticated
  using (user_id = (select auth.uid()));
create policy sync_fleets_insert on public.sync_fleets for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy sync_fleets_update on public.sync_fleets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Pull: the caller's synced rows above a revision, oldest first. Runs with the
-- caller's rights, so row level security limits it to their own rows.
create function public.sync_pull(p_since bigint default 0, p_limit integer default 500)
returns table (entity text, revision bigint, row_data jsonb)
language sql stable security invoker set search_path = '' as $$
  select * from (
    select 'profile'::text, p.revision, to_jsonb(p) from public.sync_profiles p where p.revision > p_since
    union all
    select 'printer'::text, r.revision, to_jsonb(r) from public.sync_printers r where r.revision > p_since
    union all
    select 'fleet'::text, f.revision, to_jsonb(f) from public.sync_fleets f where f.revision > p_since
  ) s
  order by 2
  limit least(greatest(p_limit, 1), 1000);
$$;

-- Push: applies a batch of changes with optimistic concurrency. Each change is
-- {entity, row, baseRevision}. A null baseRevision creates the row; otherwise
-- the row is updated only if its revision still equals baseRevision. Returns
-- one result per change: applied with the stored row, conflict with the
-- current row (null when it does not exist or is not the caller's), or
-- rejected with the error code and message when the row breaks a rule. A
-- rejected change does not stop the rest of the batch.
create function public.sync_push(p_changes jsonb, p_device uuid default null)
returns table (idx integer, status text, row_data jsonb)
language plpgsql volatile security invoker set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  c jsonb;
  i integer := 0;
  r jsonb;
  base bigint;
  rid uuid;
  ent text;
  stored jsonb;
  result_status text;
begin
  if uid is null then
    raise exception 'sign in to sync' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 200 then
    raise exception 'changes must be an array of at most 200 items' using errcode = '22023';
  end if;
  for c in select * from jsonb_array_elements(p_changes) loop
    begin
      r := coalesce(c -> 'row', '{}');
      ent := c ->> 'entity';
      base := (c ->> 'baseRevision')::bigint;
      rid := coalesce((r ->> 'id')::uuid, gen_random_uuid());
      stored := null;
      if ent = 'profile' then
        if base is null then
          insert into public.sync_profiles (id, user_id, kind, name, inherits, settings, deleted, updated_by)
          values (rid, uid, r ->> 'kind', r ->> 'name', r ->> 'inherits', coalesce(r -> 'settings', '{}'),
                  coalesce((r ->> 'deleted')::boolean, false), p_device)
          on conflict (id) do nothing
          returning to_jsonb(sync_profiles.*) into stored;
        else
          update public.sync_profiles p set
            name = coalesce(r ->> 'name', p.name),
            inherits = case when r ? 'inherits' then r ->> 'inherits' else p.inherits end,
            settings = coalesce(r -> 'settings', p.settings),
            deleted = coalesce((r ->> 'deleted')::boolean, p.deleted),
            updated_by = p_device
          where p.id = rid and p.revision = base
          returning to_jsonb(p.*) into stored;
        end if;
        if stored is null then
          select to_jsonb(p.*) into stored from public.sync_profiles p where p.id = rid;
          result_status := 'conflict';
        else
          result_status := 'applied';
        end if;
      elsif ent = 'printer' then
        if base is null then
          insert into public.sync_printers (id, user_id, name, driver, model, printer_profile_id, settings, deleted, updated_by)
          values (rid, uid, r ->> 'name', r ->> 'driver', r ->> 'model', (r ->> 'printer_profile_id')::uuid,
                  coalesce(r -> 'settings', '{}'), coalesce((r ->> 'deleted')::boolean, false), p_device)
          on conflict (id) do nothing
          returning to_jsonb(sync_printers.*) into stored;
        else
          update public.sync_printers p set
            name = coalesce(r ->> 'name', p.name),
            driver = case when r ? 'driver' then r ->> 'driver' else p.driver end,
            model = case when r ? 'model' then r ->> 'model' else p.model end,
            printer_profile_id = case when r ? 'printer_profile_id' then (r ->> 'printer_profile_id')::uuid else p.printer_profile_id end,
            settings = coalesce(r -> 'settings', p.settings),
            deleted = coalesce((r ->> 'deleted')::boolean, p.deleted),
            updated_by = p_device
          where p.id = rid and p.revision = base
          returning to_jsonb(p.*) into stored;
        end if;
        if stored is null then
          select to_jsonb(p.*) into stored from public.sync_printers p where p.id = rid;
          result_status := 'conflict';
        else
          result_status := 'applied';
        end if;
      elsif ent = 'fleet' then
        if base is null then
          insert into public.sync_fleets (id, user_id, name, printer_ids, deleted, updated_by)
          values (rid, uid, r ->> 'name',
                  coalesce(array(select jsonb_array_elements_text(r -> 'printer_ids'))::uuid[], '{}'),
                  coalesce((r ->> 'deleted')::boolean, false), p_device)
          on conflict (id) do nothing
          returning to_jsonb(sync_fleets.*) into stored;
        else
          update public.sync_fleets f set
            name = coalesce(r ->> 'name', f.name),
            printer_ids = case when r ? 'printer_ids'
              then array(select jsonb_array_elements_text(r -> 'printer_ids'))::uuid[] else f.printer_ids end,
            deleted = coalesce((r ->> 'deleted')::boolean, f.deleted),
            updated_by = p_device
          where f.id = rid and f.revision = base
          returning to_jsonb(f.*) into stored;
        end if;
        if stored is null then
          select to_jsonb(f.*) into stored from public.sync_fleets f where f.id = rid;
          result_status := 'conflict';
        else
          result_status := 'applied';
        end if;
      else
        raise exception 'unknown entity %', ent using errcode = '22023';
      end if;
    exception when others then
      result_status := 'rejected';
      stored := jsonb_build_object('code', sqlstate, 'message', sqlerrm);
    end;
    idx := i;
    status := result_status;
    row_data := stored;
    return next;
    i := i + 1;
  end loop;
end;
$$;

revoke execute on function public.sync_pull(bigint, integer) from anon, public;
revoke execute on function public.sync_push(jsonb, uuid) from anon, public;
grant execute on function public.sync_pull(bigint, integer) to authenticated;
grant execute on function public.sync_push(jsonb, uuid) to authenticated;

-- Cloud slicing queue --------------------------------------------------------------
-- Jobs are created by the cloud service after it checks the caller's token and
-- the request. Workers claim them with claim_cloud_job. Members read their own
-- jobs and can cancel them.
create table public.cloud_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token_id uuid references public.api_tokens (id) on delete set null,
  name text not null check (char_length(name) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  progress real not null default 0 check (progress between 0 and 1),
  stage text check (char_length(stage) <= 40),
  -- A SliceRequest whose object meshes are SHA-256 references into cloud-inputs.
  request jsonb not null check (jsonb_typeof(request) = 'object' and pg_column_size(request) <= 262144),
  target_printer_id uuid references public.sync_printers (id) on delete set null,
  result jsonb,
  gcode_path text,
  preview_path text,
  error text check (char_length(error) <= 1000),
  attempts integer not null default 0,
  worker text,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index cloud_jobs_user_idx on public.cloud_jobs (user_id, created_at desc);
create index cloud_jobs_queue_idx on public.cloud_jobs (created_at) where status in ('queued', 'running');

create function public.check_cloud_job() returns trigger
language plpgsql set search_path = '' as $$
begin
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
create trigger cloud_jobs_check before insert on public.cloud_jobs
  for each row execute function public.check_cloud_job();

-- A finished job stays finished, so a late worker cannot overwrite a cancel.
create function public.guard_cloud_job() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status in ('succeeded', 'failed', 'canceled') and new.status is distinct from old.status then
    raise exception 'job % has already finished', old.id using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger cloud_jobs_guard before update on public.cloud_jobs
  for each row execute function public.guard_cloud_job();

alter table public.cloud_jobs enable row level security;
revoke all on public.cloud_jobs from anon, authenticated;
grant select on public.cloud_jobs to authenticated;
create policy cloud_jobs_read_own on public.cloud_jobs for select to authenticated
  using (user_id = (select auth.uid()));

create function public.cancel_cloud_job(p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.cloud_jobs set status = 'canceled', finished_at = now()
    where id = p_id and user_id = (select auth.uid()) and status in ('queued', 'running')
    returning 1
  )
  select exists (select 1 from done);
$$;

-- Claims the oldest queued job, or a running job whose worker stopped sending
-- heartbeats. A job that has been claimed three times fails instead.
create function public.claim_cloud_job(p_worker text, p_stale_seconds integer default 120)
returns setof public.cloud_jobs
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.cloud_jobs set status = 'failed', error = 'the job stopped responding three times', finished_at = now()
  where status = 'running' and attempts >= 3 and heartbeat_at < now() - make_interval(secs => p_stale_seconds);
  update public.cloud_deliveries set state = 'expired', updated_at = now()
  where state in ('offered', 'downloaded', 'awaiting_approval') and expires_at < now();
  return query
  update public.cloud_jobs j set
    status = 'running', worker = p_worker, heartbeat_at = now(),
    started_at = coalesce(j.started_at, now()), attempts = j.attempts + 1
  where j.id = (
    select q.id from public.cloud_jobs q
    where q.status = 'queued'
       or (q.status = 'running' and q.attempts < 3 and q.heartbeat_at < now() - make_interval(secs => p_stale_seconds))
    order by q.created_at
    for update skip locked
    limit 1
  )
  returning j.*;
end;
$$;

-- Delivery to a printer -------------------------------------------------------------
-- When a job with a target printer succeeds, a delivery is offered to the bridge
-- that reaches the printer. The bridge pulls it over an outbound connection,
-- checks the file hash and asks the user for approval locally before anything
-- reaches the printer. The cloud records the states the bridge reports and never
-- holds or relays approval tokens.
create table public.cloud_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  job_id uuid not null references public.cloud_jobs (id) on delete cascade,
  printer_id uuid not null references public.sync_printers (id) on delete cascade,
  device_id uuid not null references public.cloud_devices (id) on delete cascade,
  state text not null default 'offered' check (state in (
    'offered', 'downloaded', 'awaiting_approval', 'approved', 'declined',
    'uploaded', 'printing', 'failed', 'expired', 'canceled')),
  message text check (char_length(message) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 day',
  unique (job_id, printer_id)
);
create index cloud_deliveries_device_idx on public.cloud_deliveries (device_id, state);

create function public.guard_delivery_state() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.state = old.state then
    return new;
  end if;
  if not (
    (old.state = 'offered' and new.state in ('downloaded', 'declined', 'failed', 'expired', 'canceled'))
    or (old.state = 'downloaded' and new.state in ('awaiting_approval', 'declined', 'failed', 'expired', 'canceled'))
    or (old.state = 'awaiting_approval' and new.state in ('approved', 'declined', 'failed', 'expired', 'canceled'))
    or (old.state = 'approved' and new.state in ('uploaded', 'failed'))
    or (old.state = 'uploaded' and new.state in ('printing', 'failed'))
  ) then
    raise exception 'a delivery cannot go from % to %', old.state, new.state using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger cloud_deliveries_guard before update on public.cloud_deliveries
  for each row execute function public.guard_delivery_state();

create function public.offer_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'succeeded' and old.status is distinct from 'succeeded' and new.target_printer_id is not null then
    insert into public.cloud_deliveries (user_id, job_id, printer_id, device_id)
    select new.user_id, new.id, p.id, p.device_id
    from public.sync_printers p
    where p.id = new.target_printer_id and p.user_id = new.user_id and not p.deleted and p.device_id is not null
    on conflict (job_id, printer_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger cloud_jobs_offer after update of status on public.cloud_jobs
  for each row execute function public.offer_delivery();

alter table public.cloud_deliveries enable row level security;
revoke all on public.cloud_deliveries from anon, authenticated;
grant select on public.cloud_deliveries to authenticated;
create policy cloud_deliveries_read_own on public.cloud_deliveries for select to authenticated
  using (user_id = (select auth.uid()));

create function public.cancel_cloud_delivery(p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.cloud_deliveries set state = 'canceled'
    where id = p_id and user_id = (select auth.uid()) and state in ('offered', 'downloaded', 'awaiting_approval')
    returning 1
  )
  select exists (select 1 from done);
$$;

revoke execute on function public.cancel_cloud_job(uuid) from anon, public;
revoke execute on function public.cancel_cloud_delivery(uuid) from anon, public;
revoke execute on function public.claim_cloud_job(text, integer) from anon, authenticated, public;
grant execute on function public.cancel_cloud_job(uuid) to authenticated;
grant execute on function public.cancel_cloud_delivery(uuid) to authenticated;
grant execute on function public.claim_cloud_job(text, integer) to service_role;

-- Storage ----------------------------------------------------------------------------
-- cloud-inputs holds uploaded meshes at <user id>/<sha256>; cloud-results holds
-- <user id>/<job id>/slice.gcode and slice.sxpv. The service writes both with the
-- service role; members read their own folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('cloud-inputs', 'cloud-inputs', false, 52428800), ('cloud-results', 'cloud-results', false, 209715200);

create policy cloud_files_read_own on storage.objects for select to authenticated
  using (bucket_id in ('cloud-inputs', 'cloud-results') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Realtime: clients may subscribe to their own jobs, deliveries and synced rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.cloud_jobs, public.cloud_deliveries, public.sync_profiles, public.sync_printers, public.sync_fleets;
  end if;
end;
$$;
