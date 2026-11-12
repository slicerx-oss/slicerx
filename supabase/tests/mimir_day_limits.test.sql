-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The desktop limits above an install's day (0035): the slicerx row gets $100 an edition day, $20 an
-- address day and $40 a network day, every other column of it keeps the value it had after 0034, and
-- the layermate and slicerx-web rows are unchanged. Run with `supabase test db` after
-- `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Each row as it stood after 0034, every column but edition. The slicerx row here already carries
-- 0035's three new days; everything else in it is unchanged.
create temp table want (edition text primary key, row jsonb not null) on commit drop;
insert into want values
  ('layermate', '{"enabled": true, "signed_in": false, "ip_in_flight": 10, "ip_per_minute": 60, "net_in_flight": 24,
    "share_default": false, "step_up_model": "claude-sonnet-5-5", "ip_daily_micros": 2000000, "net_daily_micros": 6000000,
    "call_open_seconds": 420, "edition_in_flight": 400, "install_in_flight": 3, "register_key_hash": null,
    "registers_per_day": 5000, "install_per_minute": 20, "install_call_micros": 50000, "edition_daily_micros": 20000000,
    "install_daily_micros": 1000000, "registers_per_ip_day": 3, "registers_per_net_day": 20,
    "register_key_prev_hash": null, "install_store_daily_bytes": 33554432}'),
  ('slicerx', '{"enabled": true, "signed_in": false, "ip_in_flight": 10, "ip_per_minute": 60, "net_in_flight": 24,
    "share_default": true, "step_up_model": "claude-sonnet-5-5", "ip_daily_micros": 20000000, "net_daily_micros": 40000000,
    "call_open_seconds": 420, "edition_in_flight": 400, "install_in_flight": 3, "register_key_hash": null,
    "registers_per_day": 5000, "install_per_minute": 20, "install_call_micros": 50000, "edition_daily_micros": 100000000,
    "install_daily_micros": 20000000, "registers_per_ip_day": 3, "registers_per_net_day": 20,
    "register_key_prev_hash": null, "install_store_daily_bytes": 33554432}'),
  ('slicerx-web', '{"enabled": true, "signed_in": true, "ip_in_flight": 6, "ip_per_minute": 30, "net_in_flight": 12,
    "share_default": false, "step_up_model": null, "ip_daily_micros": 1000000, "net_daily_micros": 3000000,
    "call_open_seconds": 420, "edition_in_flight": 100, "install_in_flight": 2, "register_key_hash": null,
    "registers_per_day": 5000, "install_per_minute": 10, "install_call_micros": 50000, "edition_daily_micros": 5000000,
    "install_daily_micros": 250000, "registers_per_ip_day": 3, "registers_per_net_day": 20,
    "register_key_prev_hash": null, "install_store_daily_bytes": 4194304}');
create function pg_temp.got(p_edition text) returns jsonb language sql as $$
  select to_jsonb(l) - 'edition' from public.mimir_limits l where l.edition = p_edition
$$;

select is((select edition_daily_micros from public.mimir_limits where edition = 'slicerx'), 100000000::bigint,
  'the slicerx edition gets $100 a day of free mimir');
select is((select ip_daily_micros from public.mimir_limits where edition = 'slicerx'), 20000000::bigint,
  'a slicerx address gets $20 a day');
select is((select net_daily_micros from public.mimir_limits where edition = 'slicerx'), 40000000::bigint,
  'a slicerx network gets $40 a day');
select is(pg_temp.got('slicerx') - array['edition_daily_micros', 'ip_daily_micros', 'net_daily_micros'],
  (select row - array['edition_daily_micros', 'ip_daily_micros', 'net_daily_micros'] from want where edition = 'slicerx'),
  'every other slicerx column is unchanged');
select is(pg_temp.got('slicerx'), (select row from want where edition = 'slicerx'), 'the whole slicerx row is as expected');
select is(pg_temp.got('layermate'), (select row from want where edition = 'layermate'), 'the layermate row is unchanged');
select is(pg_temp.got('slicerx-web'), (select row from want where edition = 'slicerx-web'), 'the slicerx-web row is unchanged');
select is((select array_agg(edition order by edition) from public.mimir_limits), array['layermate', 'slicerx', 'slicerx-web'],
  'no edition is added or removed');

select * from finish();
rollback;
