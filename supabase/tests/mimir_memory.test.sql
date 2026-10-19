-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir memory sync (pgTAP): a person reads and writes only their own facts, the newer
-- updated_at wins, deletions are tombstones, a clock far ahead is ignored, tombstones do not hold
-- slots under the cap and old ones are pruned, and neither anon nor the mimir session reader
-- reaches the table. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash;
grant select on ids to anon, authenticated, service_role;

create function pg_temp.as_user(p_handle text) returns void language plpgsql as $$
declare
  uid uuid;
begin
  reset role;
  select id into uid from public.profiles where handle = p_handle;
  if uid is null then raise exception 'no profile %', p_handle; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
end;
$$;

-- now() is fixed for the whole transaction; t(n) is n hours ago
create function pg_temp.t(p_hours_ago int) returns timestamptz language sql stable as $$
  select now() - make_interval(hours => p_hours_ago);
$$;
grant execute on function pg_temp.t(int) to anon, authenticated;

select pg_temp.as_user('rv');
insert into public.mimir_memory (edition, id, fact, updated_at) values
  ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "A1 mini", "updatedAt": 1000}', pg_temp.t(30)),
  ('layermate', 'p1', '{"id": "p1", "kind": "printer", "text": "X1C", "updatedAt": 1000}', pg_temp.t(30));
select is((select user_id from public.mimir_memory where edition = 'slicerx' and id = 'p1'), (select rv from ids),
  'a fact belongs to the person who wrote it');

select pg_temp.as_user('ash');
select is((select count(*)::int from public.mimir_memory), 0, 'a user cannot read another user''s facts');
select throws_ok(
  $$insert into public.mimir_memory (user_id, edition, id, fact, updated_at)
    values ((select rv from ids), 'slicerx', 'x', '{}', now())$$,
  '42501', null, 'a user cannot write a fact for another user');
update public.mimir_memory set fact = '{"text": "taken"}', updated_at = now();
select pg_temp.as_user('rv');
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1 mini',
  'a user cannot change another user''s facts');
select throws_ok(
  $$update public.mimir_memory set user_id = (select ash from ids), updated_at = now()
    where edition = 'slicerx' and id = 'p1'$$,
  '42501', null, 'a user cannot hand their own fact to another user');

-- the newer edit wins, also through an upsert as the app sends it
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "A1", "updatedAt": 2000}', pg_temp.t(20))
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1',
  'a newer edit replaces the fact');
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "stale", "updatedAt": 1500}', pg_temp.t(25))
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1',
  'an older edit changes nothing');
update public.mimir_memory set fact = '{"id": "p1", "kind": "printer", "text": "same time"}', updated_at = pg_temp.t(20)
  where edition = 'slicerx' and id = 'p1';
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1',
  'an edit with the same updated_at changes nothing');

-- a clock more than a day ahead is ignored, for a new fact and for an edit
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'ahead', '{"id": "ahead", "kind": "printer", "text": "from the future", "updatedAt": 1}', now() + interval '2 days');
select is((select count(*)::int from public.mimir_memory where edition = 'slicerx' and id = 'ahead'), 0,
  'a new fact dated more than a day ahead is skipped');
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "frozen", "updatedAt": 1}', now() + interval '10 years')
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1',
  'an edit dated more than a day ahead is skipped');
select lives_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at)
    values ('slicerx', 'soon', '{"id": "soon", "kind": "printer", "text": "a little ahead", "updatedAt": 1}', now() + interval '1 hour')$$,
  'a clock a little ahead is fine');

-- a deletion is a tombstone; clients never delete rows
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"deleted": true, "updatedAt": 3000}', pg_temp.t(10))
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select (fact ->> 'deleted')::boolean from public.mimir_memory where edition = 'slicerx' and id = 'p1'), true,
  'a deletion syncs as a tombstone');
select throws_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at)
    values ('slicerx', 'odd', '{"deleted": true, "updatedAt": 1, "text": "kept"}', now())$$,
  '23514', null, 'a tombstone carries only deleted and updatedAt');
select ok(not has_table_privilege('authenticated', 'public.mimir_memory', 'DELETE, TRUNCATE'),
  'clients never delete rows');
select is((select fact ->> 'text' from public.mimir_memory where edition = 'layermate' and id = 'p1'), 'X1C',
  'editions stay apart');

-- each edition holds at most 2000 live facts per person, and an update still passes at the limit
-- ('soon' is live and p1 is a tombstone, so 1999 more fill the edition)
insert into public.mimir_memory (edition, id, fact, updated_at)
  select 'slicerx', 'n' || g, '{}', pg_temp.t(40) from generate_series(1, 1999) g;
select throws_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'one-more', '{}', now())$$,
  '54000', null, 'an edition holds at most 2000 facts');
select lives_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'n1', '{"text": "again"}', pg_temp.t(5))
    on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at$$,
  'an update passes at the limit');
select throws_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'p1', '{"text": "back"}', pg_temp.t(5))
    on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at$$,
  '54000', null, 'a fact written over a tombstone takes a slot');
select lives_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'gone', '{"deleted": true, "updatedAt": 1}', pg_temp.t(5))$$,
  'a tombstone needs no slot');

-- clearing every fact frees the slots, and new facts fit again (dated ahead of 'soon', so it clears too)
insert into public.mimir_memory (edition, id, fact, updated_at)
  select m.edition, m.id, jsonb_build_object('deleted', true, 'updatedAt', 4000), now() + interval '2 hours'
  from public.mimir_memory m where m.edition = 'slicerx' and not (m.fact ? 'deleted')
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select count(*)::int from public.mimir_memory where edition = 'slicerx' and not (fact ? 'deleted')), 0,
  'clearing leaves only tombstones');
select lives_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'fresh', '{"text": "new printer"}', pg_temp.t(1))$$,
  'a new fact fits after clearing at the limit');
insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'n2', '{"text": "back again"}', now() + interval '3 hours')
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'n2'), 'back again',
  'a cleared fact can come back after clearing at the limit');

-- old tombstones are pruned on the next write: past 90 days, and beyond the newest 8000 per edition
insert into public.mimir_memory (edition, id, fact, updated_at) values
  ('prune', 'old', '{"deleted": true, "updatedAt": 1}', now() - interval '91 days'),
  ('prune', 'recent', '{"deleted": true, "updatedAt": 1}', now() - interval '89 days'),
  ('prune', 'old-fact', '{"text": "kept"}', now() - interval '400 days');
select is((select string_agg(id, ',' order by id) from public.mimir_memory where edition = 'prune'), 'old-fact,recent',
  'a tombstone older than 90 days is pruned, a live fact is not');
insert into public.mimir_memory (edition, id, fact, updated_at)
  select 'prune', 't' || g, jsonb_build_object('deleted', true, 'updatedAt', g), now() - make_interval(secs => 8001 - g)
  from generate_series(1, 8001) g;
select is((select count(*)::int from public.mimir_memory where edition = 'prune' and (fact ? 'deleted')), 8000,
  'an edition keeps at most 8000 tombstones');
select ok(not exists (select 1 from public.mimir_memory where edition = 'prune' and id in ('recent', 't1')),
  'the oldest tombstones go first');

select pg_temp.as_anon();
select throws_ok('select count(*) from public.mimir_memory', '42501', null, 'anon cannot read facts');
reset role;
select ok(not has_any_column_privilege('anon', 'public.mimir_memory', 'SELECT, INSERT, UPDATE')
  and not has_table_privilege('anon', 'public.mimir_memory', 'DELETE, TRUNCATE'), 'anon has no access');
select ok(not has_any_column_privilege('mimir_session_reader', 'public.mimir_memory', 'SELECT'),
  'mimir_session_reader has no select');

select * from finish();
rollback;
