-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Locked projects (.sxlock, packages/sx3mf/SPEC-sxlock.md): a project file
-- only the exporting account can open.
--
-- Each account has a 32-byte secret that never leaves the database. A file's
-- content key is HMAC-SHA256(secret, 'sxlock/v1' || owner || key id || salt),
-- with the owner, key id and a random salt taken from the file's header. The
-- app asks for a fresh key when it exports (sxlock_seal) and for the same key
-- again when it opens (sxlock_open). Both need a signed-in session of the
-- owning account. An integrator acting for the owner calls
-- sxlock_open_with_token with an sxk_ token that has the sxlock_open scope.
--
-- Rotation retires the active secret: files made with it still open, new
-- exports use a new one. Revoking a secret makes every file made with it
-- unopenable for good. Deleting the account deletes its secrets.

create schema if not exists sxlock;
revoke all on schema sxlock from public, anon, authenticated;

create table sxlock.account_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  secret bytea not null check (octet_length(secret) = 32),
  created_at timestamptz not null default now(),
  -- Set when a newer key took over; files under this key still open.
  retired_at timestamptz,
  -- Set when the owner revoked it; files under this key no longer open.
  revoked_at timestamptz
);
create index account_keys_user_idx on sxlock.account_keys (user_id);
-- At most one key per account signs new exports.
create unique index account_keys_active_idx on sxlock.account_keys (user_id) where retired_at is null and revoked_at is null;
revoke all on sxlock.account_keys from public, anon, authenticated;

-- The token scope integrators use to open a locked file for its owner.
alter table public.api_tokens drop constraint api_tokens_scopes_check;
alter table public.api_tokens add constraint api_tokens_scopes_check
  check (cardinality(scopes) > 0 and scopes <@ array['read', 'mcp', 'cli', 'cloud_slice', 'link', 'sxlock_open']);

-- The content key for one file, as 64 hex digits. Internal.
create function sxlock.derive(p_secret bytea, p_owner uuid, p_key uuid, p_salt text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.hmac(convert_to('sxlock/v1', 'UTF8') || uuid_send(p_owner) || uuid_send(p_key) || decode(p_salt, 'hex'), p_secret, 'sha256'), 'hex');
$$;

-- Checks the request and returns the content key of a file owned by p_user.
-- Internal: callers have already established that p_user is the caller.
create function sxlock.open_for(p_user uuid, p_owner uuid, p_key uuid, p_salt text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  k sxlock.account_keys%rowtype;
begin
  if p_salt is null or p_salt !~ '^[0-9a-f]{64}$' then
    raise exception 'the locked project header is not valid' using errcode = '22023', hint = 'invalid';
  end if;
  if p_owner is distinct from p_user then
    raise exception 'this locked project belongs to another SlicerX account' using errcode = '42501', hint = 'wrong_account';
  end if;
  select * into k from sxlock.account_keys a where a.id = p_key and a.user_id = p_user;
  if not found then
    raise exception 'the key this project was locked with no longer exists' using errcode = 'P0002', hint = 'unknown_key';
  end if;
  if k.revoked_at is not null then
    raise exception 'the key this project was locked with was revoked' using errcode = '42501', hint = 'revoked';
  end if;
  return sxlock.derive(k.secret, p_owner, k.id, p_salt);
end;
$$;

-- Export: a content key for a new file, under the account's active key (made
-- on first use). The salt is 32 random bytes the caller chose, as hex.
create function public.sxlock_seal(p_salt text)
returns table (owner uuid, key_id uuid, content_key text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  uid uuid := (select auth.uid());
  k sxlock.account_keys%rowtype;
begin
  if uid is null then
    raise exception 'sign in to export a locked project' using errcode = '42501', hint = 'signed_out';
  end if;
  if public.user_banned(uid) then
    raise exception 'this account is banned' using errcode = '42501', hint = 'banned';
  end if;
  if p_salt is null or p_salt !~ '^[0-9a-f]{64}$' then
    raise exception 'the salt must be 32 bytes as hex' using errcode = '22023', hint = 'invalid';
  end if;
  insert into sxlock.account_keys (user_id, secret) values (uid, extensions.gen_random_bytes(32))
  on conflict (user_id) where retired_at is null and revoked_at is null do nothing;
  select * into k from sxlock.account_keys a where a.user_id = uid and a.retired_at is null and a.revoked_at is null;
  return query select uid, k.id, sxlock.derive(k.secret, uid, k.id, p_salt);
end;
$$;

-- Open, signed in as the owner.
create function public.sxlock_open(p_owner uuid, p_key_id uuid, p_salt text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'sign in to open a locked project' using errcode = '42501', hint = 'signed_out';
  end if;
  if public.user_banned(uid) then
    raise exception 'this account is banned' using errcode = '42501', hint = 'banned';
  end if;
  return sxlock.open_for(uid, p_owner, p_key_id, p_salt);
end;
$$;

-- Open for an integrator, with the owner's sxk_ token. The token needs the
-- sxlock_open scope and counts against its per-minute limit.
create function public.sxlock_open_with_token(p_token text, p_owner uuid, p_key_id uuid, p_salt text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
begin
  select * into t from public.resolve_api_token(coalesce(p_token, ''), null, true);
  if not found then
    raise exception 'the API token is not valid' using errcode = '42501', hint = 'signed_out';
  end if;
  if not t.allowed then
    raise exception 'too many requests with this token; try again in % s', t.retry_after_s using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if not ('sxlock_open' = any (t.scopes)) then
    raise exception 'the API token does not have the sxlock_open scope' using errcode = '42501', hint = 'missing_scope';
  end if;
  return sxlock.open_for(t.user_id, p_owner, p_key_id, p_salt);
end;
$$;

-- The signed-in account's keys, without their secrets.
create function public.sxlock_keys()
returns table (id uuid, created_at timestamptz, retired_at timestamptz, revoked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.id, a.created_at, a.retired_at, a.revoked_at from sxlock.account_keys a
  where a.user_id = (select auth.uid()) order by a.created_at desc;
$$;

-- Retires the active key and makes a new one. Files locked before still open.
create function public.rotate_sxlock_key()
returns table (id uuid, created_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501', hint = 'signed_out';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sxlock-rotate:' || uid::text, 0));
  update sxlock.account_keys a set retired_at = now() where a.user_id = uid and a.retired_at is null and a.revoked_at is null;
  return query insert into sxlock.account_keys as a (user_id, secret) values (uid, extensions.gen_random_bytes(32)) returning a.id, a.created_at;
end;
$$;

-- Revokes one key. Files locked with it can no longer be opened by anyone.
create function public.revoke_sxlock_key(p_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$
  with done as (
    update sxlock.account_keys a set revoked_at = now()
    where a.id = p_id and a.user_id = (select auth.uid()) and a.revoked_at is null
    returning 1
  )
  select exists (select 1 from done);
$$;

revoke execute on function sxlock.derive(bytea, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function sxlock.open_for(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.sxlock_seal(text) from anon, public;
revoke execute on function public.sxlock_open(uuid, uuid, text) from anon, public;
revoke execute on function public.sxlock_open_with_token(text, uuid, uuid, text) from public;
revoke execute on function public.sxlock_keys() from anon, public;
revoke execute on function public.rotate_sxlock_key() from anon, public;
revoke execute on function public.revoke_sxlock_key(uuid) from anon, public;
grant execute on function public.sxlock_seal(text) to authenticated;
grant execute on function public.sxlock_open(uuid, uuid, text) to authenticated;
grant execute on function public.sxlock_open_with_token(text, uuid, uuid, text) to anon, authenticated;
grant execute on function public.sxlock_keys() to authenticated;
grant execute on function public.rotate_sxlock_key() to authenticated;
grant execute on function public.revoke_sxlock_key(uuid) to authenticated;
