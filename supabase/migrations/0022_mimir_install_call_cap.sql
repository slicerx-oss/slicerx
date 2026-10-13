-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- A call reserves its worst case: every web search pass rereading the prompt, the results
-- and the whole reply allowance, all at the cache write rate. For a 55K token agent turn
-- with search on that is about $0.43, most of an install's $0.50 day, so an install was
-- refused with nearly all of its day left. Its own caps now count an open call at no more
-- than install_call_micros ($0.05, a tenth of the day). The address, network and edition
-- caps still count the whole worst case, so the money those caps guard is held exactly; an
-- install can pass its own cap by at most what its last calls cost past that, and
-- install_in_flight (3) bounds how many those are.
alter table public.mimir_limits
  add column install_call_micros bigint not null default 50000 check (install_call_micros >= 0);

create or replace function public.mimir_reserve(p_token text, p_ip text, p_model text, p_input bigint, p_output bigint,
  p_searches integer) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inst public.mimir_installs;
  v_lim public.mimir_limits;
  v_day date := public.mimir_day();
  v_ip text := public.mimir_ip_hash(p_ip);
  v_net text := public.mimir_net_hash(p_ip);
  v_id uuid;
  v_edition_used bigint;
  v_install_used bigint;
  p_max_micros bigint;
begin
  if p_input is null or p_input < 0 or p_output is null or p_output < 0 or p_searches is null or p_searches < 0 then
    raise exception 'bad reservation' using errcode = '22023', hint = 'invalid';
  end if;
  p_max_micros := public.mimir_cost(p_model, 0, p_input, 0, p_output, p_searches);
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where edition = v_inst.edition;
  if not v_lim.enabled then
    raise exception 'mimir is paused' using errcode = 'P0001', hint = 'paused';
  end if;
  -- Rates first and outside the lock, so refused traffic does not queue behind it. Refused
  -- requests count too (mimir_refused).
  if (select count(*) from public.mimir_calls
      where install_id = v_inst.id and created_at > now() - interval '1 minute')
    + (select count(*) from public.mimir_refusals
      where install_id = v_inst.id and created_at > now() - interval '1 minute') >= v_lim.install_per_minute then
    raise exception 'too many requests' using errcode = 'P0001', hint = 'install_rate';
  end if;
  if (select count(*) from public.mimir_calls
      where ip_hash = v_ip and created_at > now() - interval '1 minute')
    + (select count(*) from public.mimir_refusals
      where ip_hash = v_ip and created_at > now() - interval '1 minute') >= v_lim.ip_per_minute then
    raise exception 'too many requests from this address' using errcode = 'P0001', hint = 'ip_rate';
  end if;
  -- A /48 already at its calls at once or its day's spend is refused here, before the lock
  -- and with a hint that sends no exact count, since none could fit; the checks under the
  -- lock below are the exact ones.
  if v_net is not null then
    if (select count(*) from public.mimir_calls where net_hash = v_net and settled_at is null
        and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.net_in_flight then
      raise exception 'too many calls at once from this network' using errcode = 'P0001', hint = 'net_busy';
    end if;
    if (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
        where net_hash = v_net and day = v_day) >= v_lim.net_daily_micros then
      raise exception 'this network has used its daily limit' using errcode = 'P0001', hint = 'net_full';
    end if;
  end if;
  -- One reservation at a time, so two calls cannot both slip under a cap (the IP cap spans
  -- editions, so the lock does too).
  perform pg_advisory_xact_lock(hashtext('public.mimir_reserve'));
  -- A call that never settled stops counting as in flight after call_open_seconds; its
  -- reservation still counts against the caps.
  if (select count(*) from public.mimir_calls where install_id = v_inst.id and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.install_in_flight then
    raise exception 'too many calls at once' using errcode = 'P0001', hint = 'install_busy';
  end if;
  if (select count(*) from public.mimir_calls where ip_hash = v_ip and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.ip_in_flight then
    raise exception 'too many calls at once from this address' using errcode = 'P0001', hint = 'ip_busy';
  end if;
  if v_net is not null and (select count(*) from public.mimir_calls where net_hash = v_net and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.net_in_flight then
    raise exception 'too many calls at once from this network' using errcode = 'P0001', hint = 'net_busy';
  end if;
  if (select count(*) from public.mimir_calls where edition = v_inst.edition and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.edition_in_flight then
    raise exception 'too many calls at once for this edition' using errcode = 'P0001', hint = 'edition_busy';
  end if;
  select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) into v_edition_used from public.mimir_calls
  where edition = v_inst.edition and day = v_day;
  -- the install's own caps count an open call at no more than install_call_micros
  select coalesce(sum(coalesce(cost_micros, least(reserved_micros, v_lim.install_call_micros))), 0) into v_install_used
  from public.mimir_calls where install_id = v_inst.id and day = v_day;
  if v_install_used + least(p_max_micros, v_lim.install_call_micros) > v_lim.install_daily_micros then
    raise exception 'daily limit for this install reached' using errcode = 'P0001', hint = 'install_daily';
  end if;
  -- under its own cap but over the shrunken one: the edition's budget is what ran out
  if v_install_used + least(p_max_micros, v_lim.install_call_micros) > public.mimir_install_cap(v_lim, v_edition_used) then
    raise exception 'daily limit for this edition reached' using errcode = 'P0001', hint = 'edition_daily';
  end if;
  if (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where ip_hash = v_ip and day = v_day) + p_max_micros > v_lim.ip_daily_micros then
    raise exception 'daily limit for this address reached' using errcode = 'P0001', hint = 'ip_daily';
  end if;
  if v_net is not null and (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where net_hash = v_net and day = v_day) + p_max_micros > v_lim.net_daily_micros then
    raise exception 'daily limit for this network reached' using errcode = 'P0001', hint = 'net_daily';
  end if;
  if v_edition_used + p_max_micros > v_lim.edition_daily_micros then
    raise exception 'daily limit for this edition reached' using errcode = 'P0001', hint = 'edition_daily';
  end if;
  insert into public.mimir_calls (day, edition, install_id, ip_hash, net_hash, reserved_micros)
  values (v_day, v_inst.edition, v_inst.id, v_ip, v_net, p_max_micros)
  returning id into v_id;
  update public.mimir_installs set last_call_at = now() where id = v_inst.id;
  return v_id;
end;
$$;

-- what the app shows as used counts an open call the same way
create or replace function public.mimir_quota(p_token text, p_ip text)
returns table (edition text, day date, install_used bigint, install_cap bigint, ip_used bigint, ip_cap bigint,
  edition_open boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_inst public.mimir_installs;
  v_lim public.mimir_limits;
  v_day date := public.mimir_day();
  v_ip text := public.mimir_ip_hash(p_ip);
  v_edition_used bigint;
begin
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where mimir_limits.edition = v_inst.edition;
  select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) into v_edition_used from public.mimir_calls
  where mimir_calls.edition = v_inst.edition and mimir_calls.day = v_day;
  return query select v_inst.edition, v_day,
    (select coalesce(sum(coalesce(cost_micros, least(reserved_micros, v_lim.install_call_micros))), 0)::bigint
      from public.mimir_calls where install_id = v_inst.id and mimir_calls.day = v_day),
    public.mimir_install_cap(v_lim, v_edition_used),
    (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0)::bigint from public.mimir_calls
      where ip_hash = v_ip and mimir_calls.day = v_day),
    v_lim.ip_daily_micros,
    v_lim.enabled and v_edition_used < v_lim.edition_daily_micros;
end;
$$;
