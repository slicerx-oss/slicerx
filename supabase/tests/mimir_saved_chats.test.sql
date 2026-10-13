-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Saved free mimir chats (pgTAP): the edition's default saves a call the client said nothing
-- about, x-sx-share: 0 (p_share false) saves nothing, a prompt is kept once per edition and
-- text, a design-sized turn fits, everything goes after 30 days, forget still deletes, and
-- clients cannot reach any of it. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

create temp table t (k text primary key, v text) on commit drop;
grant all on t to service_role, mimir_session_reader;
grant mimir_session_reader to postgres with set true;
grant usage on schema extensions to mimir_session_reader;
update public.mimir_limits set register_key_hash = public.mimir_token_hash(edition || '-key'), registers_per_day = 5000,
  install_per_minute = 100, edition_daily_micros = 5000000, enabled = true;
create function pg_temp.reg(p_edition text, p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register(p_edition, p_ip, p_edition || '-key');
  return v;
end;
$$;
create function pg_temp.done(p_token text) returns uuid language plpgsql as $$
declare v uuid := public.mimir_reserve(p_token, '10.9.0.1', 'claude-haiku-5-5', 0, 2, 0);
begin
  perform public.mimir_settle(v, 'claude-haiku-5-5', 1, 0, 0, 1, 0);
  return v;
end;
$$;
create function pg_temp.save(p_call uuid, p_share boolean, p_key text, p_body jsonb, p_hash text default repeat('a', 64)) returns boolean
language sql as $$
  select public.mimir_save_chat(p_call, p_share, p_key, '0.2.0', 'claude-haiku-5-5', p_hash, '{"tools":[]}', p_body)
$$;

-- Clients see nothing -----------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.mimir_prompts $$, '42501', null, 'anon cannot read prompts');
select throws_ok($$ select public.mimir_save_chat(null, null, 's', '0', 'm', null, null, '{}') $$, '42501', null, 'anon cannot save a chat');
reset role;
set local role authenticated;
select throws_ok($$ select public.mimir_expire_saved() $$, '42501', null, 'authenticated cannot expire chats');
select throws_ok($$ select public.mimir_reader_prompt('x') $$, '42501', null, 'authenticated cannot use the reader');
reset role;

-- Defaults ------------------------------------------------------------------------------
select is((select share_default from public.mimir_limits where edition = 'slicerx'), true, 'SlicerX saves by default in alpha');
select is((select share_default from public.mimir_limits where edition = 'layermate'), false, 'LayerMate waits for its app''s notice');
select is((select array_agg(edition_daily_micros order by edition) from public.mimir_limits), array[5000000, 5000000]::bigint[], 'each edition gets $5 a day of free mimir');
select is((select install_store_daily_bytes from public.mimir_limits where edition = 'slicerx'), 33554432::bigint,
  'an install may save 32 MB a day');
select ok(exists (select 1 from cron.job where jobname = 'mimir-expire-saved' and command like '%mimir_expire_saved%'),
  'an hourly job expires saved chats');

-- Saving --------------------------------------------------------------------------------
insert into t values ('s', pg_temp.reg('slicerx', '10.9.0.2'));
insert into t values ('sid', (select id from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 's')))::text);
insert into t values ('c1', pg_temp.done((select v from t where k = 's'))::text);
select ok(pg_temp.save((select v::uuid from t where k = 'c1'), null, 'day-20261013', '{"messages":[1]}'),
  'a client that says nothing is saved by the edition''s default');
select is((select count(*)::int from public.mimir_prompts where hash = repeat('a', 64)), 1, 'its prompt is kept');
insert into t values ('c2', pg_temp.done((select v from t where k = 's'))::text);
select ok(not pg_temp.save((select v::uuid from t where k = 'c2'), false, 's-off', '{"messages":[1]}'), 'an opt-out saves nothing');
select is((select count(*)::int from public.mimir_sessions where session_key = 's-off'), 0, 'and leaves no session');
select is((select stored_bytes from public.mimir_calls where id = (select v::uuid from t where k = 'c2')), 0, 'the call is marked as not saved');
select throws_ok(format($$ select pg_temp.save(%L, true, 's-off', '{}') $$, (select v from t where k = 'c2')), '22023', null,
  'a call saves once, even after an opt-out');
insert into t values ('c3', pg_temp.done((select v from t where k = 's'))::text);
select ok(pg_temp.save((select v::uuid from t where k = 'c3'), true, 'day-20261013', jsonb_build_object('pad', repeat('x', 900000))),
  'a design-sized turn of 900 KB is saved');
select is((select turns from public.mimir_sessions where session_key = 'day-20261013'), 2, 'into the same day''s session');
select is((select count(*)::int from public.mimir_prompts), 1, 'the same prompt is kept once');
insert into t values ('c4', pg_temp.done((select v from t where k = 's'))::text);
select ok(not pg_temp.save((select v::uuid from t where k = 'c4'), true, 's4', jsonb_build_object('pad', repeat('x', 1048577))),
  'a turn over 1 MB is not saved');
update public.mimir_limits set share_default = false where edition = 'slicerx';
insert into t values ('c5', pg_temp.done((select v from t where k = 's'))::text);
select ok(not pg_temp.save((select v::uuid from t where k = 'c5'), null, 's5', '{}'), 'with the default off, silence saves nothing');
update public.mimir_limits set share_default = true where edition = 'slicerx';

-- Reader, expiry and forget -------------------------------------------------------------
insert into t values ('lm', pg_temp.reg('layermate', '10.9.0.3'));
select pg_temp.save(pg_temp.done((select v from t where k = 'lm')), true, 'lm1', '{"messages":["lm"]}', repeat('b', 64));
set local role mimir_session_reader;
select isnt(public.mimir_reader_prompt(repeat('b', 64)), null, 'the reader opens a LayerMate prompt');
select is(public.mimir_reader_prompt(repeat('a', 64)), null, 'but not a SlicerX one');
reset role;
update public.mimir_sessions set updated_at = now() - interval '31 days' where session_key = 'lm1';
update public.mimir_prompts set last_used_at = now() - interval '31 days' where hash = repeat('b', 64);
select is(public.mimir_expire_saved(), 2, 'a session and a prompt unused for 30 days go');
select is((select count(*)::int from public.mimir_sessions where session_key = 'day-20261013'), 1, 'a recent session stays');
select is(public.mimir_forget((select v from t where k = 's')), 1, 'forget still deletes the install''s saved chats');

select * from finish();
rollback;
