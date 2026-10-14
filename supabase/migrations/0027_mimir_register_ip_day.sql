-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir_register's per-address and per-network limits count the installs made in the last 24 hours,
-- not every install ever made there, so a shared or carrier NAT address is not refused for good once
-- it reaches the limit. The rest of the function is as in 0020.

-- a busy shared address keeps many old installs, so the counts read a range of
-- (address, created_at); these replace 0020's single-column indexes, which they cover
create index mimir_installs_ip_created_idx on public.mimir_installs (created_ip_hash, created_at);
create index mimir_installs_net_created_idx on public.mimir_installs (created_net_hash, created_at) where created_net_hash is not null;
drop index public.mimir_installs_ip_idx;
drop index public.mimir_installs_net_idx;

create or replace function public.mimir_register(p_edition text, p_ip text, p_key text)
returns table (install_id uuid, token text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_lim public.mimir_limits;
  v_ip text := public.mimir_ip_hash(p_ip);
  v_net text := public.mimir_net_hash(p_ip);
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  select * into v_lim from public.mimir_limits where edition = p_edition;
  if not found then
    raise exception 'unknown edition' using errcode = '22023', hint = 'invalid';
  end if;
  if v_lim.register_key_hash is null
    or public.mimir_token_hash(p_key) not in (v_lim.register_key_hash, coalesce(v_lim.register_key_prev_hash, '')) then
    raise exception 'wrong registration key' using errcode = 'P0001', hint = 'register_key';
  end if;
  if not v_lim.enabled then
    raise exception 'mimir is paused' using errcode = 'P0001', hint = 'paused';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.mimir_register'));
  if (select count(*) from public.mimir_installs where created_ip_hash = v_ip
      and created_at > now() - interval '24 hours') >= v_lim.registers_per_ip_day then
    raise exception 'too many new installs from this address today' using errcode = 'P0001', hint = 'register_limit';
  end if;
  if v_net is not null and (select count(*) from public.mimir_installs where created_net_hash = v_net
      and created_at > now() - interval '24 hours') >= v_lim.registers_per_net_day then
    raise exception 'too many new installs from this network today' using errcode = 'P0001', hint = 'register_limit';
  end if;
  if (select count(*) from public.mimir_installs i where i.edition = p_edition
      and i.created_at >= public.mimir_day_start()) >= v_lim.registers_per_day then
    raise exception 'too many new installs for this edition today' using errcode = 'P0001', hint = 'edition_register_limit';
  end if;
  -- installs that never made a call go after 7 days, and idle ones without shared sessions
  -- after 30 (their calls go with them), a few at a time; the app registers again on
  -- unknown_install
  delete from public.mimir_installs where id in (
    select i.id from public.mimir_installs i where i.last_call_at is null and i.created_at < now() - interval '7 days' limit 100);
  delete from public.mimir_installs where id in (
    select i.id from public.mimir_installs i where i.last_call_at < now() - interval '30 days'
      and not exists (select 1 from public.mimir_sessions s where s.install_id = i.id) limit 100);
  insert into public.mimir_installs (edition, token_hash, created_ip_hash, created_net_hash)
  values (p_edition, public.mimir_token_hash(v_token), v_ip, v_net)
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;
