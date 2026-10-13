-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir cloud for the browser build: its own edition, slicerx-web, for signed-in users only. Nothing registers
-- for it: the proxy checks the user's session, and the user's install row (one per user, made on first use)
-- stands where a desktop install would, so every per-install cap is a per-user cap. Its caps are tighter than
-- slicerx's, and the proxy calls the provider with its own key, so the web's spend is apart from the desktop's.
alter table public.mimir_limits
  add column signed_in boolean not null default false,
  -- a signed-in edition never takes a registration key
  add constraint mimir_limits_signed_in_no_key check (not signed_in or (register_key_hash is null and register_key_prev_hash is null));

-- the user an install belongs to, in a signed-in edition; deleting the account deletes its install, calls and
-- shared sessions
alter table public.mimir_installs
  add column user_id uuid references auth.users (id) on delete cascade,
  add constraint mimir_installs_edition_user_key unique (edition, user_id);

-- per user: $0.25 a day and 10 calls a minute; per address $1, per IPv6 /48 $3, 30 calls a minute; the edition
-- $5 a day. In flight: 2 per user, 6 per address, 12 per /48, 100 in all.
insert into public.mimir_limits (
  edition, signed_in, edition_daily_micros, install_daily_micros, ip_daily_micros, net_daily_micros,
  install_per_minute, ip_per_minute, install_in_flight, ip_in_flight, net_in_flight, edition_in_flight,
  install_store_daily_bytes
) values (
  'slicerx-web', true, 5000000, 250000, 1000000, 3000000,
  10, 30, 2, 6, 12, 100,
  4194304
)
on conflict (edition) do nothing;

-- The install token of user p_user in signed-in edition p_edition, making the install on first use. The token is
-- an HMAC of the user's id under the server's secret, so it is the same on every call and never stored; only the
-- proxy sees it. Calls then go through mimir_reserve, mimir_quota and mimir_forget like any install's.
create function public.mimir_user_token(p_edition text, p_user uuid, p_ip text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_lim public.mimir_limits;
  v_token text;
begin
  select * into v_lim from public.mimir_limits where edition = p_edition;
  if not found or not v_lim.signed_in or p_user is null then
    raise exception 'not a signed-in edition' using errcode = '22023', hint = 'invalid';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'unknown user' using errcode = 'P0001', hint = 'sign_in';
  end if;
  v_token := encode(extensions.hmac(convert_to('mimir-user|' || p_edition || '|' || p_user::text, 'UTF8'),
    (select salt from public.mimir_secret), 'sha256'), 'hex');
  insert into public.mimir_installs (edition, token_hash, created_ip_hash, created_net_hash, user_id)
  values (p_edition, public.mimir_token_hash(v_token), public.mimir_ip_hash(p_ip), public.mimir_net_hash(p_ip), p_user)
  on conflict (edition, user_id) do nothing;
  return v_token;
end;
$$;

revoke execute on function public.mimir_user_token(text, uuid, text) from public, anon, authenticated;
grant execute on function public.mimir_user_token(text, uuid, text) to service_role;
