-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Locked projects, part 2: integrators may lock files too. An sxk_ token
-- with the new sxlock_seal scope gets content keys for new files of its own
-- account through sxlock_seal_with_token, the counterpart of
-- sxlock_open_with_token (0010_sxlock.sql), counted against the token's
-- per-minute limit. Opening and locking stay separate grants.

alter table public.api_tokens drop constraint api_tokens_scopes_check;
alter table public.api_tokens add constraint api_tokens_scopes_check
  check (cardinality(scopes) > 0 and scopes <@ array['read', 'mcp', 'cli', 'cloud_slice', 'link', 'sxlock_open', 'sxlock_seal']);

-- The account behind a token, when the token has p_scope. Internal.
create function sxlock.token_user(p_token text, p_scope text) returns uuid
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
  if not (p_scope = any (t.scopes)) then
    raise exception 'the API token does not have the % scope', p_scope using errcode = '42501', hint = 'missing_scope';
  end if;
  if public.user_banned(t.user_id) then
    raise exception 'this account is banned' using errcode = '42501', hint = 'banned';
  end if;
  return t.user_id;
end;
$$;

-- Export for an integrator, with the account's sxk_ token. The file is
-- always locked to the token's own account, under its active key.
create function public.sxlock_seal_with_token(p_token text, p_salt text)
returns table (owner uuid, key_id uuid, content_key text)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  uid uuid := sxlock.token_user(p_token, 'sxlock_seal');
  k sxlock.account_keys%rowtype;
begin
  if p_salt is null or p_salt !~ '^[0-9a-f]{64}$' then
    raise exception 'the salt must be 32 bytes as hex' using errcode = '22023', hint = 'invalid';
  end if;
  insert into sxlock.account_keys (user_id, secret) values (uid, extensions.gen_random_bytes(32))
  on conflict (user_id) where retired_at is null and revoked_at is null do nothing;
  select * into k from sxlock.account_keys a where a.user_id = uid and a.retired_at is null and a.revoked_at is null;
  return query select uid, k.id, sxlock.derive(k.secret, uid, k.id, p_salt);
end;
$$;

-- open by token goes through the same checks, so a banned account is refused here too.
create or replace function public.sxlock_open_with_token(p_token text, p_owner uuid, p_key_id uuid, p_salt text) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  return sxlock.open_for(sxlock.token_user(p_token, 'sxlock_open'), p_owner, p_key_id, p_salt);
end;
$$;

revoke execute on function sxlock.token_user(text, text) from public, anon, authenticated;
revoke execute on function public.sxlock_seal_with_token(text, text) from public;
grant execute on function public.sxlock_seal_with_token(text, text) to anon, authenticated;
