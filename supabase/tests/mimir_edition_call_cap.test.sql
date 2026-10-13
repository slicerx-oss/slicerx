-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The edition's day counts an open call at no more than install_call_micros, like an install's, so
-- only settled cost uses it up; and free mimir is $1 a day per install and $5 per edition. Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

create temp table t (k text primary key, v text) on commit drop;
grant all on t to service_role;
update public.mimir_limits set register_key_hash = public.mimir_token_hash(edition || '-key') where edition in ('slicerx', 'layermate');
create function pg_temp.reg(p_edition text, p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register(p_edition, p_ip, p_edition || '-key');
  return v;
end;
$$;
grant execute on function pg_temp.reg(text, text) to service_role;
-- a worst case of 800K reply tokens: $0.40 reserved, counted at the $0.05 clamp
create function pg_temp.big(p_token text, p_ip text) returns uuid language sql as $$
  select public.mimir_reserve(p_token, p_ip, 'claude-haiku-5-5', 0, 800000, 0)
$$;
grant execute on function pg_temp.big(text, text) to service_role;

select is((select array_agg(install_daily_micros order by edition) from public.mimir_limits where edition in ('layermate', 'slicerx')),
  array[1000000, 1000000]::bigint[], 'an install gets $1 a day of free mimir');
select is((select array_agg(edition_daily_micros order by edition) from public.mimir_limits where edition in ('layermate', 'slicerx')),
  array[5000000, 5000000]::bigint[], 'and each edition $5');

-- a $0.30 edition day, smaller than one call's worst case
update public.mimir_limits set edition_daily_micros = 300000 where edition = 'slicerx';
set local role service_role;
insert into t values ('a', pg_temp.reg('slicerx', '10.0.3.1')), ('b', pg_temp.reg('slicerx', '10.0.3.2')), ('c', pg_temp.reg('slicerx', '10.0.3.3'));
insert into t values ('a1', pg_temp.big((select v from t where k = 'a'), '10.0.3.1')::text);
select is((select reserved_micros from public.mimir_calls where id = (select v::uuid from t where k = 'a1')), 400000::bigint,
  'a call larger than the edition''s day is reserved in full');
select ok((select edition_open from public.mimir_quota((select v from t where k = 'a'), '10.0.3.1')),
  'and the edition stays open while it runs');
select pg_temp.big((select v from t where k = 'a'), '10.0.3.1');
select pg_temp.big((select v from t where k = 'a'), '10.0.3.1');
select pg_temp.big((select v from t where k = 'b'), '10.0.3.2');
select pg_temp.big((select v from t where k = 'b'), '10.0.3.2');
-- five open calls count $0.25; a sixth makes exactly the $0.30
select lives_ok(format($$ select pg_temp.big(%L, '10.0.3.3') $$, (select v from t where k = 'c')),
  'six open calls fit a $0.30 day at the clamp');
select throws_ok(format($$ select pg_temp.big(%L, '10.0.3.3') $$, (select v from t where k = 'c')),
  'P0001', 'daily limit for this edition reached', 'a seventh does not');
-- settled cost counts in full: $0.25 real plus five open calls at $0.05 is past the day
select public.mimir_settle((select v::uuid from t where k = 'a1'), 'claude-haiku-5-5', 0, 0, 0, 500000, 0);
select ok(not (select edition_open from public.mimir_quota((select v from t where k = 'a'), '10.0.3.1')),
  'a settled call counts what it cost');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.3.3', 'claude-haiku-5-5', 0, 8, 0) $$, (select v from t where k = 'c')),
  'P0001', 'daily limit for this edition reached', 'so even a small call is refused');

select * from finish();
rollback;
