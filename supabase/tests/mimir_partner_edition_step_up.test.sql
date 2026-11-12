-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The layermate edition's step-up (0033): its row gets the step-up model and the slicerx edition day,
-- every other column keeps the value it had after 0032, and the slicerx and slicerx-web rows are
-- unchanged. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Each row as it stood after 0032, every column but edition. The layermate row here already carries
-- 0033's two new values, and the slicerx row 0034's install day; everything else in them is unchanged.
create temp table want (edition text primary key, row jsonb not null) on commit drop;
insert into want values
  ('layermate', '{"enabled": true, "signed_in": false, "ip_in_flight": 10, "ip_per_minute": 60, "net_in_flight": 24,
    "share_default": false, "step_up_model": "claude-sonnet-5-5", "ip_daily_micros": 2000000, "net_daily_micros": 6000000,
    "call_open_seconds": 420, "edition_in_flight": 400, "install_in_flight": 3, "register_key_hash": null,
    "registers_per_day": 5000, "install_per_minute": 20, "install_call_micros": 50000, "edition_daily_micros": 20000000,
    "install_daily_micros": 1000000, "registers_per_ip_day": 3, "registers_per_net_day": 20,
    "register_key_prev_hash": null, "install_store_daily_bytes": 33554432}'),
  ('slicerx', '{"enabled": true, "signed_in": false, "ip_in_flight": 10, "ip_per_minute": 60, "net_in_flight": 24,
    "share_default": true, "step_up_model": "claude-sonnet-5-5", "ip_daily_micros": 2000000, "net_daily_micros": 6000000,
    "call_open_seconds": 420, "edition_in_flight": 400, "install_in_flight": 3, "register_key_hash": null,
    "registers_per_day": 5000, "install_per_minute": 20, "install_call_micros": 50000, "edition_daily_micros": 20000000,
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

select is((select step_up_model from public.mimir_limits where edition = 'layermate'), 'claude-sonnet-5-5',
  'layermate steps up to the stronger model');
select is((select edition_daily_micros from public.mimir_limits where edition = 'layermate'), 20000000::bigint,
  'layermate has the same edition day as slicerx');
select is(public.mimir_turn_model('layermate', 'step'), 'claude-sonnet-5-5', 'a layermate step turn gets the stronger model');
select is(public.mimir_turn_model('layermate', 'base'), 'claude-haiku-5-5', 'a layermate base turn stays on the base model');
select is((select share_default from public.mimir_limits where edition = 'layermate'), false,
  'layermate still saves no chat by default');
select is((select install_daily_micros from public.mimir_limits where edition = 'layermate'), 1000000::bigint,
  'a layermate install''s day is unchanged');
select is(pg_temp.got('layermate'), (select row from want where edition = 'layermate'),
  'every other layermate column is unchanged');
select is(pg_temp.got('slicerx'), (select row from want where edition = 'slicerx'), 'the slicerx row is unchanged');
select is(pg_temp.got('slicerx-web'), (select row from want where edition = 'slicerx-web'), 'the slicerx-web row is unchanged');
select is((select array_agg(edition order by edition) from public.mimir_limits), array['layermate', 'slicerx', 'slicerx-web'],
  'no edition is added or removed');

select * from finish();
rollback;
