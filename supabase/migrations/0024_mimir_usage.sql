-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- What an install's usage page shows, as shares of its caps and never as money: today
-- against its cap (shrunk as the edition's day fills, as mimir_quota shows it), each of the
-- last 24 hours against the daily cap, and the last 7 days against 7 days' worth. Open calls
-- count at install_call_micros, as everywhere else. The proxy adds it to /quota as v2.
-- Also the edition an install belongs to, for the proxy's log lines.

create function public.mimir_usage(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_inst public.mimir_installs;
  v_lim public.mimir_limits;
  v_day date := public.mimir_day();
  v_reset timestamptz := (public.mimir_day() + 1)::timestamp at time zone 'Australia/Melbourne';
  v_hour timestamptz := date_trunc('hour', now());
  v_edition_used bigint;
  v_used bigint;
  v_cap bigint;
  v_week bigint;
  v_hourly jsonb;
begin
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where edition = v_inst.edition;
  select coalesce(sum(coalesce(cost_micros, least(reserved_micros, v_lim.install_call_micros))), 0) into v_edition_used
  from public.mimir_calls where edition = v_inst.edition and day = v_day;
  select coalesce(sum(coalesce(cost_micros, least(reserved_micros, v_lim.install_call_micros))), 0) into v_used
  from public.mimir_calls where install_id = v_inst.id and day = v_day;
  v_cap := public.mimir_install_cap(v_lim, v_edition_used);
  select coalesce(sum(coalesce(cost_micros, least(reserved_micros, v_lim.install_call_micros))), 0) into v_week
  from public.mimir_calls where install_id = v_inst.id and day > v_day - 7;
  -- oldest hour first; the last one is the hour now under way
  select jsonb_agg(round(least(1, coalesce(u.micros, 0)::numeric / greatest(v_lim.install_daily_micros, 1)), 4) order by h.start)
  into v_hourly
  from generate_series(v_hour - interval '23 hours', v_hour, interval '1 hour') as h(start)
  left join lateral (
    select sum(coalesce(cost_micros, least(reserved_micros, v_lim.install_call_micros))) as micros
    from public.mimir_calls
    where install_id = v_inst.id and created_at >= h.start and created_at < h.start + interval '1 hour'
  ) u on true;
  return jsonb_build_object(
    'day', jsonb_build_object('used', case when v_cap <= 0 then 1 else round(least(1, v_used::numeric / v_cap), 4) end,
      'resetsAt', to_char(v_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'week', jsonb_build_object('used', case when v_lim.install_daily_micros <= 0 then 1
        else round(least(1, v_week::numeric / (7 * v_lim.install_daily_micros)), 4) end,
      'resetsAt', to_char(v_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'hourly', v_hourly,
    'perMinute', jsonb_build_object('limit', v_lim.install_per_minute));
end;
$$;

create function public.mimir_install_edition(p_token text) returns text
language sql stable security definer set search_path = '' as $$
  select edition from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
$$;

revoke execute on function public.mimir_usage(text), public.mimir_install_edition(text) from public, anon, authenticated;
grant execute on function public.mimir_usage(text), public.mimir_install_edition(text) to service_role;
