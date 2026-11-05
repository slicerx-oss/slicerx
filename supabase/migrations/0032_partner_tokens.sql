-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Partner app tokens. A person issues an sxk_ token to a named partner app
-- (a phone or desktop app someone else makes) so the app can slice in the
-- cloud on the person's own account, within the account's daily limits. The
-- token has the cloud_slice scope and nothing else, always expires, lists
-- with the person's other tokens under the app's name, and is revoked like
-- any token. resolve_api_token now also returns the app's name, so the cloud
-- service lets a partner token see only the jobs it queued and never send a
-- job to a printer.

alter table public.api_tokens
  add column partner_app text
    check (partner_app is null or (char_length(partner_app) between 1 and 60 and partner_app = btrim(partner_app) and partner_app !~ '[[:cntrl:]]')),
  add constraint api_tokens_partner_scope_check check (partner_app is null or scopes = array['cloud_slice']),
  add constraint api_tokens_partner_expiry_check check (partner_app is null or expires_at is not null);

grant select (partner_app) on public.api_tokens to authenticated;

-- Creates a partner app token for the signed-in user and returns it once.
-- The checks of create_api_token apply (signed in, not banned, not being
-- deleted, at most 20 active tokens).
create function public.create_partner_token(p_partner_app text, p_expires_in_days integer default 90)
returns table (id uuid, token text, prefix text, expires_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app text := btrim(coalesce(p_partner_app, ''));
  r record;
begin
  if char_length(v_app) not between 1 and 60 or v_app ~ '[[:cntrl:]]' then
    raise exception 'name the partner app in 1 to 60 characters' using errcode = '23514';
  end if;
  if p_expires_in_days is null or p_expires_in_days < 1 or p_expires_in_days > 365 then
    raise exception 'partner app tokens expire after 1 to 365 days' using errcode = '23514';
  end if;
  select * into r from public.create_api_token(v_app, array['cloud_slice'], p_expires_in_days, 60);
  update public.api_tokens t set partner_app = v_app where t.id = r.id;
  return query select r.id, r.token, r.prefix, r.expires_at;
end;
$$;

revoke execute on function public.create_partner_token(text, integer) from anon, public;
grant execute on function public.create_partner_token(text, integer) to authenticated;

-- resolve_api_token of 0001_auth.sql with partner_app added to its answer.
-- Changing the columns of a function's result needs a new function.
drop function public.resolve_api_token(text, inet, boolean);

create function public.resolve_api_token(p_token text, p_ip inet default null, p_report_limit boolean default false)
returns table (user_id uuid, token_id uuid, scopes text[], allowed boolean, limit_per_minute integer, remaining integer, retry_after_s integer, partner_app text)
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
      else greatest(1, ceil(extract(epoch from (w + interval '1 minute' - now()))))::integer end,
    t.partner_app;
end;
$$;

revoke execute on function public.resolve_api_token(text, inet, boolean) from anon, authenticated, public;
grant execute on function public.resolve_api_token(text, inet, boolean) to service_role;
