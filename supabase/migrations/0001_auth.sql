-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Auth module: profiles with roles, bans, the audit log, personal API tokens
-- and paired devices. This module stands alone. The store module (0002)
-- builds on it and can be dropped without touching it
-- (supabase/modules/README.md).

-- Profiles: one row per auth user, created by trigger.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9_]{2,32}$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  avatar_url text,
  -- Roles: owner (one per deployment, set by the service role), moderator,
  -- creator (set when a creator page is made) and member. Clients never write it.
  role text not null default 'member' check (role in ('owner', 'moderator', 'creator', 'member')),
  banned_at timestamptz,
  ban_reason text check (char_length(ban_reason) <= 1000),
  created_at timestamptz not null default now(),
  check ((banned_at is null) = (ban_reason is null))
);
create unique index profiles_one_owner on public.profiles (role) where role = 'owner';

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  candidate text;
  n integer := 0;
begin
  base := regexp_replace(lower(coalesce(new.raw_user_meta_data ->> 'handle', split_part(coalesce(new.email, ''), '@', 1))), '[^a-z0-9_]', '', 'g');
  if char_length(base) < 2 then
    base := 'member';
  end if;
  base := left(base, 26);
  candidate := base;
  while exists (select 1 from public.profiles where handle = candidate) loop
    n := n + 1;
    candidate := base || '_' || n::text;
  end loop;
  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    candidate,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', candidate), 80)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
revoke insert, update, delete, truncate on public.profiles from anon;
-- Members edit only their own display fields. Role and ban columns change
-- through set_user_role, ban_user and unban_user.
revoke insert, update, delete, truncate on public.profiles from authenticated;
grant update (handle, display_name, avatar_url) on public.profiles to authenticated;

create policy profiles_read on public.profiles for select to anon, authenticated using (true);
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()) and banned_at is null) with check (id = (select auth.uid()));

-- Role helpers. Security definer so policies in any module can call them
-- without recursing into the profiles policies. Each answers one question.

-- The caller's role: 'banned' for a banned account, null when signed out.
create function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when p.banned_at is not null then 'banned' else p.role end
  from public.profiles p where p.id = (select auth.uid());
$$;

-- Signed in and not banned.
create function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() <> 'banned', false);
$$;

create function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() = 'owner', false);
$$;

-- Owner or moderator.
create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() in ('owner', 'moderator'), false);
$$;

create function public.user_banned(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select banned_at is not null from public.profiles where id = p_user), false);
$$;

-- Audit log ---------------------------------------------------------------------
-- Append-only record of role changes, bans and (in the store module)
-- moderation decisions. Written only by the functions below; staff read it.
-- actor_id is null for automatic actions and after the actor deletes their account.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) between 1 and 60),
  target_kind text not null check (target_kind in ('user', 'listing', 'version', 'creator', 'comment', 'setting')),
  target_id uuid,
  reason text check (char_length(reason) <= 1000),
  detail jsonb not null default '{}'::jsonb
);
create index audit_log_target_idx on public.audit_log (target_kind, target_id, at desc);
create index audit_log_at_idx on public.audit_log (at desc);

create function public.reject_audit_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.actor_id is not null and new.actor_id is null
     and (new.id, new.at, new.action, new.target_kind, new.target_id, new.reason, new.detail)
         is not distinct from (old.id, old.at, old.action, old.target_kind, old.target_id, old.reason, old.detail) then
    return new; -- the foreign key clearing a deleted actor
  end if;
  raise exception 'the audit log is append-only' using errcode = 'P0001';
end;
$$;
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function public.reject_audit_change();
create function public.reject_audit_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'the audit log is append-only' using errcode = 'P0001';
end;
$$;
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.reject_audit_truncate();

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
create policy audit_log_read_staff on public.audit_log for select to authenticated using (public.is_staff());

-- Writes one audit row for the signed-in caller. Not callable by clients.
create function public.audit(p_action text, p_kind text, p_target uuid, p_reason text default null, p_detail jsonb default '{}'::jsonb)
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, action, target_kind, target_id, reason, detail)
  values ((select auth.uid()), p_action, p_kind, p_target, p_reason, coalesce(p_detail, '{}'::jsonb));
$$;
revoke execute on function public.audit(text, text, uuid, text, jsonb) from anon, authenticated, public;

-- Roles and bans ------------------------------------------------------------------

-- Owner only. Assigns moderator, creator or member. The owner role itself is
-- set by the service role, and the owner's own role cannot change here.
create function public.set_user_role(p_user uuid, p_role text, p_reason text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  old_role text;
begin
  if not public.is_owner() then
    raise exception 'only the owner can change roles' using errcode = '42501';
  end if;
  if p_role not in ('moderator', 'creator', 'member') then
    raise exception 'roles that can be assigned: moderator, creator, member' using errcode = '23514';
  end if;
  select role into old_role from public.profiles where id = p_user;
  if not found then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if old_role = 'owner' then
    raise exception 'the owner role cannot be changed here' using errcode = '42501';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform public.audit('role_change', 'user', p_user, p_reason, jsonb_build_object('from', old_role, 'to', p_role));
end;
$$;

-- Owner or moderator. A moderator cannot ban the owner, another moderator or
-- themselves. Revokes the person's API tokens and sessions and blocks sign-in.
-- What a ban hides (their listings, creator page) follows from the banned flag.
create function public.ban_user(p_user uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  target_role text;
begin
  if not public.is_staff() then
    raise exception 'only staff can ban accounts' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'give a reason for the ban' using errcode = '23514';
  end if;
  select role into target_role from public.profiles where id = p_user;
  if not found then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if p_user = (select auth.uid()) or target_role = 'owner' or (target_role = 'moderator' and not public.is_owner()) then
    raise exception 'this account cannot be banned by you' using errcode = '42501';
  end if;
  update public.profiles set banned_at = now(), ban_reason = btrim(p_reason)
  where id = p_user and banned_at is null;
  update public.api_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
  update auth.users set banned_until = 'infinity' where id = p_user;
  delete from auth.sessions where user_id = p_user;
  perform public.audit('ban', 'user', p_user, btrim(p_reason), jsonb_build_object('role', target_role));
end;
$$;

create function public.unban_user(p_user uuid, p_reason text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_staff() then
    raise exception 'only staff can lift a ban' using errcode = '42501';
  end if;
  update public.profiles set banned_at = null, ban_reason = null where id = p_user and banned_at is not null;
  if found then
    update auth.users set banned_until = null where id = p_user;
    perform public.audit('unban', 'user', p_user, p_reason, '{}'::jsonb);
  end if;
end;
$$;

revoke execute on function public.set_user_role(uuid, text, text) from anon, public;
revoke execute on function public.ban_user(uuid, text) from anon, public;
revoke execute on function public.unban_user(uuid, text) from anon, public;
grant execute on function public.set_user_role(uuid, text, text) to authenticated;
grant execute on function public.ban_user(uuid, text) to authenticated;
grant execute on function public.unban_user(uuid, text) to authenticated;

-- Personal API tokens for integrations: the SlicerX MCP server, the CLI and
-- cloud features. Only a SHA-256 hash is stored; the token itself is shown
-- once, when it is created. Clients never read the hash column.
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  -- The first 12 characters, so people can tell their tokens apart.
  prefix text not null check (prefix ~ '^sxk_[0-9a-f]{8}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['read', 'mcp', 'cli', 'cloud_slice', 'link']),
  -- Requests allowed per calendar minute; resolve_api_token enforces it.
  rate_limit_per_minute integer not null default 60 check (rate_limit_per_minute between 1 and 600),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  -- The client address the service reported with the last accepted request.
  last_used_ip inet,
  revoked_at timestamptz
);
create index api_tokens_user_idx on public.api_tokens (user_id);

alter table public.api_tokens enable row level security;
revoke all on public.api_tokens from anon, authenticated;
grant select (id, user_id, name, prefix, scopes, rate_limit_per_minute, created_at, expires_at, last_used_at, last_used_ip, revoked_at)
  on public.api_tokens to authenticated;

create policy api_tokens_read_own on public.api_tokens for select to authenticated
  using (user_id = (select auth.uid()));

-- Request counts per token and minute, for the rate limit. Service side only.
create table public.api_token_usage (
  token_id uuid not null references public.api_tokens (id) on delete cascade,
  window_start timestamptz not null,
  requests integer not null default 0,
  primary key (token_id, window_start)
);
alter table public.api_token_usage enable row level security;
revoke all on public.api_token_usage from anon, authenticated;

-- Creates a token for the signed-in user and returns it once.
create function public.create_api_token(
  p_name text,
  p_scopes text[],
  p_expires_in_days integer default 90,
  p_rate_limit_per_minute integer default 60
)
returns table (id uuid, token text, prefix text, expires_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if uid is null then
    raise exception 'sign in to create a token' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception 'this account is banned' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_deletions d where d.user_id = uid and d.canceled_at is null and d.completed_at is null) then
    raise exception 'this account is scheduled for deletion' using errcode = 'P0001';
  end if;
  if p_expires_in_days is not null and (p_expires_in_days < 1 or p_expires_in_days > 365) then
    raise exception 'tokens expire after 1 to 365 days' using errcode = '23514';
  end if;
  if (select count(*) from public.api_tokens t where t.user_id = uid and t.revoked_at is null) >= 20 then
    raise exception 'token limit reached; revoke one first' using errcode = 'P0001';
  end if;
  v_token := 'sxk_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := case when p_expires_in_days is null then null else now() + make_interval(days => p_expires_in_days) end;
  insert into public.api_tokens (user_id, name, prefix, token_hash, scopes, expires_at, rate_limit_per_minute)
  values (uid, p_name, left(v_token, 12), encode(extensions.digest(v_token, 'sha256'), 'hex'), p_scopes, v_expires, p_rate_limit_per_minute)
  returning api_tokens.id into v_id;
  return query select v_id, v_token, left(v_token, 12), v_expires;
end;
$$;

create function public.revoke_api_token(p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.api_tokens set revoked_at = now()
    where id = p_id and user_id = (select auth.uid()) and revoked_at is null
    returning 1
  )
  select exists (select 1 from done);
$$;

-- Revokes every active token of the signed-in user; returns how many.
create function public.revoke_all_api_tokens() returns integer
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.api_tokens set revoked_at = now()
    where user_id = (select auth.uid()) and revoked_at is null
    returning 1
  )
  select count(*)::integer from done;
$$;

-- Server side only: the cloud endpoint behind the MCP server and the CLI
-- resolves a presented token to its user and scopes, and counts the request
-- against the token's per-minute limit. Pass the client address as p_ip.
--
-- Over the limit, the default call returns no row, so a caller that ignores
-- the limit fails closed. With p_report_limit it returns the row with
-- allowed = false and retry_after_s, so the service can answer 429.
create function public.resolve_api_token(p_token text, p_ip inet default null, p_report_limit boolean default false)
returns table (user_id uuid, token_id uuid, scopes text[], allowed boolean, limit_per_minute integer, remaining integer, retry_after_s integer)
language plpgsql volatile security definer set search_path = '' as $$
-- The output columns share names with table columns; the body means the table's.
#variable_conflict use_column
declare
  t public.api_tokens%rowtype;
  w timestamptz := date_trunc('minute', now());
  n integer;
begin
  select * into t from public.api_tokens a
  where a.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and a.revoked_at is null
    and (a.expires_at is null or a.expires_at > now());
  if not found then
    return;
  end if;
  insert into public.api_token_usage as u (token_id, window_start, requests) values (t.id, w, 1)
  on conflict (token_id, window_start) do update set requests = u.requests + 1
  returning u.requests into n;
  delete from public.api_token_usage u where u.token_id = t.id and u.window_start < w - interval '1 hour';
  if n <= t.rate_limit_per_minute then
    update public.api_tokens a set last_used_at = now(), last_used_ip = coalesce(p_ip, a.last_used_ip) where a.id = t.id;
  elsif not p_report_limit then
    return;
  end if;
  return query select t.user_id, t.id, t.scopes, n <= t.rate_limit_per_minute, t.rate_limit_per_minute,
    greatest(t.rate_limit_per_minute - n, 0),
    case when n <= t.rate_limit_per_minute then 0
      else greatest(1, ceil(extract(epoch from (w + interval '1 minute' - now()))))::integer end;
end;
$$;

revoke execute on function public.create_api_token(text, text[], integer, integer) from anon, public;
revoke execute on function public.revoke_api_token(uuid) from anon, public;
revoke execute on function public.revoke_all_api_tokens() from anon, public;
revoke execute on function public.resolve_api_token(text, inet, boolean) from anon, authenticated, public;
grant execute on function public.create_api_token(text, text[], integer, integer) to authenticated;
grant execute on function public.revoke_api_token(uuid) to authenticated;
grant execute on function public.revoke_all_api_tokens() to authenticated;
grant execute on function public.resolve_api_token(text, inet, boolean) to service_role;

-- Paired devices --------------------------------------------------------------------
-- Phones and other devices linked to the account by the pairing flow
-- (packages/pair). The device row holds only the public signing key. Revoke by
-- setting revoked_at; clients subscribe to it through Realtime so a revoked
-- phone learns at once. Members read, add and revoke only their own devices.
create table public.paired_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 8 and 128),
  name text not null check (char_length(name) between 1 and 80),
  platform text not null check (platform in ('ios', 'android', 'desktop', 'web')),
  -- Ed25519 public key, base64 or base64url text.
  sign_pub text not null check (sign_pub ~ '^[A-Za-z0-9_+/=-]{32,128}$'),
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, device_id),
  check (revoked_at is null or revoked_at >= linked_at)
);
create index paired_devices_user_idx on public.paired_devices (user_id);

-- A revoked device stays revoked, and only revoked_at can change.
create function public.guard_paired_device() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.user_id, new.device_id, new.name, new.platform, new.sign_pub, new.linked_at)
     is distinct from (old.id, old.user_id, old.device_id, old.name, old.platform, old.sign_pub, old.linked_at) then
    raise exception 'a paired device can only be revoked' using errcode = 'P0001';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'the device is already revoked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger paired_devices_guard before update on public.paired_devices
  for each row execute function public.guard_paired_device();

-- At most 10 active devices per account.
create function public.limit_paired_devices() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.paired_devices d where d.user_id = new.user_id and d.revoked_at is null) >= 10 then
    raise exception 'device limit reached; revoke one first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger paired_devices_limit before insert on public.paired_devices
  for each row execute function public.limit_paired_devices();

alter table public.paired_devices enable row level security;
revoke all on public.paired_devices from anon, authenticated;
grant select, insert on public.paired_devices to authenticated;
grant update (revoked_at) on public.paired_devices to authenticated;
create policy paired_devices_read_own on public.paired_devices for select to authenticated
  using (user_id = (select auth.uid()));
create policy paired_devices_insert_own on public.paired_devices for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user() and revoked_at is null);
create policy paired_devices_revoke_own on public.paired_devices for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.paired_devices;
  end if;
end;
$$;

-- Account self-service -----------------------------------------------------------
-- Export and deletion know about the other modules (store, cloud)
-- only by table name, and skip any that are not installed.

-- What deletion removes and what it keeps, shown to the member before they confirm.
create function public.account_deletion_policy() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'grace_days', 30,
    'removed', jsonb_build_array(
      'Your profile, handle and avatar',
      'Your email address and sign-in methods',
      'Your API tokens (revoked as soon as you ask)',
      'Your paired devices',
      'Your likes, follows, collections, downloads and makes',
      'Your creator page and every model you uploaded, with their files',
      'Your synced printer, filament and process profiles, printers, fleets and devices',
      'Your cloud slicing jobs and deliveries'
    ),
    'kept', jsonb_build_array(
      'Your comments, with your name and the text removed, so replies keep their thread',
      'Moderation audit entries about your account, with the actor and target ids only',
      'A record that this account id was deleted and when'
    )
  );
$$;

-- One row per deletion request. There is no foreign key on purpose: the row
-- outlives the account as the record that it was deleted.
create table public.account_deletions (
  user_id uuid primary key,
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  canceled_at timestamptz,
  completed_at timestamptz
);
alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from anon, authenticated;
grant select on public.account_deletions to authenticated;
create policy account_deletions_read_own on public.account_deletions for select to authenticated
  using (user_id = (select auth.uid()));

-- Drops keys that hold secrets or their hashes from an exported row.
create function public.export_row(r jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from jsonb_each(r) as e(k, v)
  where k !~ '(hash|secret)';
$$;

-- Everything stored about the signed-in member, as one JSON document.
create function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result jsonb;
  section record;
  rows jsonb;
begin
  if uid is null then
    raise exception 'sign in to export your data' using errcode = '42501';
  end if;
  result := jsonb_build_object(
    'format', 'slicerx-account-export',
    'version', 1,
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u where u.id = uid),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'api_tokens', (select coalesce(jsonb_agg(public.export_row(to_jsonb(t)) order by t.created_at), '[]'::jsonb)
                   from public.api_tokens t where t.user_id = uid),
    'account_deletion', (select to_jsonb(d) from public.account_deletions d where d.user_id = uid)
  );
  for section in
    select * from (values
      ('paired_devices', 'paired_devices', 'user_id'),
      ('likes', 'likes', 'user_id'),
      ('downloads', 'downloads', 'user_id'),
      ('follows', 'follows', 'user_id'),
      ('comments', 'comments', 'user_id'),
      ('makes', 'makes', 'user_id'),
      ('collections', 'collections', 'owner_id'),
      ('creator_page', 'creators', 'owner_id'),
      ('cloud_devices', 'cloud_devices', 'user_id'),
      ('sync_profiles', 'sync_profiles', 'user_id'),
      ('sync_printers', 'sync_printers', 'user_id'),
      ('sync_fleets', 'sync_fleets', 'user_id'),
      ('cloud_jobs', 'cloud_jobs', 'user_id'),
      ('cloud_deliveries', 'cloud_deliveries', 'user_id')
    ) as s(name, tbl, col)
  loop
    if to_regclass('public.' || section.tbl) is not null then
      execute format('select coalesce(jsonb_agg(public.export_row(to_jsonb(t))), ''[]''::jsonb) from public.%I t where t.%I = $1', section.tbl, section.col)
        into rows using uid;
      result := result || jsonb_build_object(section.name, rows);
    end if;
  end loop;
  if to_regclass('public.collection_items') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(i)), ''[]''::jsonb) from public.collection_items i
             join public.collections c on c.id = i.collection_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('collection_items', rows);
  end if;
  if to_regclass('public.listings') is not null then
    -- The member's uploads, with the review note each one carries.
    execute 'select coalesce(jsonb_agg(public.export_row(to_jsonb(l)) order by l.created_at), ''[]''::jsonb)
             from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('listings', rows);
    execute 'select coalesce(jsonb_agg(public.export_row(to_jsonb(v)) order by v.created_at), ''[]''::jsonb)
             from public.listing_versions v join public.listings l on l.id = v.listing_id
             join public.creators c on c.id = l.creator_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('listing_versions', rows);
    execute 'select coalesce(jsonb_agg(to_jsonb(k)), ''[]''::jsonb)
             from public.creator_links k join public.creators c on c.id = k.creator_id where c.owner_id = $1'
      into rows using uid;
    result := result || jsonb_build_object('creator_links', rows);
  end if;
  return result;
end;
$$;

-- Schedules deletion of the signed-in account after the grace period and
-- revokes its API tokens now. The owner account cannot be deleted; hand the
-- owner role over first.
create function public.request_account_deletion() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  policy jsonb := public.account_deletion_policy();
  v_after timestamptz;
begin
  if uid is null then
    raise exception 'sign in to delete your account' using errcode = '42501';
  end if;
  if public.is_owner() then
    raise exception 'the owner account cannot be deleted; transfer the owner role first' using errcode = 'P0001';
  end if;
  v_after := now() + make_interval(days => (policy ->> 'grace_days')::integer);
  insert into public.account_deletions (user_id, requested_at, purge_after)
  values (uid, now(), v_after)
  on conflict (user_id) do update set requested_at = now(), purge_after = v_after, canceled_at = null
  where public.account_deletions.completed_at is null;
  update public.api_tokens set revoked_at = now() where user_id = uid and revoked_at is null;
  return jsonb_build_object('purge_after', v_after) || policy;
end;
$$;

create function public.cancel_account_deletion() returns boolean
language sql volatile security definer set search_path = '' as $$
  with done as (
    update public.account_deletions set canceled_at = now()
    where user_id = (select auth.uid()) and canceled_at is null and completed_at is null
    returning 1
  )
  select exists (select 1 from done);
$$;

-- Service role only: removes one account now. Comments are anonymized first;
-- deleting the auth user then cascades to everything the member owns,
-- including the creator page and uploads. The store queues the storage
-- prefixes of deleted listings in storage_cleanup for the service to remove.
create function public.purge_account(p_user uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where id = p_user and role = 'owner') then
    raise exception 'account % holds the owner role; transfer it first', p_user using errcode = 'P0001';
  end if;
  if to_regclass('public.comments') is not null then
    -- Comments on the member's own listings go with those listings; deleting
    -- them first keeps the cascade from touching rows that are about to vanish.
    execute 'delete from public.comments where listing_id in (
               select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = $1)'
      using p_user;
    execute 'update public.comments set body = ''[deleted]'' where user_id = $1' using p_user;
  end if;
  delete from auth.users where id = p_user;
  insert into public.account_deletions (user_id, requested_at, purge_after, completed_at)
  values (p_user, now(), now(), now())
  on conflict (user_id) do update set completed_at = now();
end;
$$;

-- Service role only, run on a schedule: purges every request past its grace
-- period and returns the purged account ids, so the caller can remove files
-- the member stored under their id in storage buckets (uploads are queued in
-- storage_cleanup). A request that cannot be purged (the owner) is skipped.
create function public.purge_due_accounts() returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  done uuid[] := '{}';
begin
  for r in
    select user_id from public.account_deletions
    where purge_after <= now() and canceled_at is null and completed_at is null
  loop
    begin
      perform public.purge_account(r.user_id);
      done := done || r.user_id;
    exception when sqlstate 'P0001' then
      raise notice 'skipped %: %', r.user_id, sqlerrm;
    end;
  end loop;
  return done;
end;
$$;

revoke execute on function public.export_my_data() from anon, public;
revoke execute on function public.request_account_deletion() from anon, public;
revoke execute on function public.cancel_account_deletion() from anon, public;
revoke execute on function public.purge_account(uuid) from anon, authenticated, public;
revoke execute on function public.purge_due_accounts() from anon, authenticated, public;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.request_account_deletion() to authenticated;
grant execute on function public.cancel_account_deletion() to authenticated;
grant execute on function public.account_deletion_policy() to anon, authenticated;
grant execute on function public.purge_account(uuid) to service_role;
grant execute on function public.purge_due_accounts() to service_role;
