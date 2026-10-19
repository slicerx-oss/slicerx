-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir memory sync (pgTAP): a person reads and writes only their own facts, the newer
-- updated_at wins, deletions are tombstones, and neither anon nor the mimir session reader
-- reaches the table. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

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

select pg_temp.as_user('rv');
insert into public.mimir_memory (edition, id, fact, updated_at) values
  ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "A1 mini", "updatedAt": 1000}', to_timestamp(1)),
  ('layermate', 'p1', '{"id": "p1", "kind": "printer", "text": "X1C", "updatedAt": 1000}', to_timestamp(1));
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

-- the newer edit wins, also through an upsert as the app sends it
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "A1", "updatedAt": 2000}', to_timestamp(2))
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1',
  'a newer edit replaces the fact');
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"id": "p1", "kind": "printer", "text": "stale", "updatedAt": 1500}', to_timestamp(1.5))
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select fact ->> 'text' from public.mimir_memory where edition = 'slicerx' and id = 'p1'), 'A1',
  'an older edit changes nothing');

-- a deletion is a tombstone; clients never delete rows
insert into public.mimir_memory (edition, id, fact, updated_at)
  values ('slicerx', 'p1', '{"deleted": true, "updatedAt": 3000}', to_timestamp(3))
  on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at;
select is((select (fact ->> 'deleted')::boolean from public.mimir_memory where edition = 'slicerx' and id = 'p1'), true,
  'a deletion syncs as a tombstone');
select ok(not has_table_privilege('authenticated', 'public.mimir_memory', 'DELETE, TRUNCATE'),
  'clients never delete rows');
select is((select fact ->> 'text' from public.mimir_memory where edition = 'layermate' and id = 'p1'), 'X1C',
  'editions stay apart');

-- each edition holds at most 2000 facts per person, and an update still passes at the limit
insert into public.mimir_memory (edition, id, fact, updated_at)
  select 'slicerx', 'n' || g, '{}', to_timestamp(1) from generate_series(1, 1999) g;
select throws_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'one-more', '{}', now())$$,
  '54000', null, 'an edition holds at most 2000 facts');
select lives_ok(
  $$insert into public.mimir_memory (edition, id, fact, updated_at) values ('slicerx', 'n1', '{"text": "again"}', now())
    on conflict (user_id, edition, id) do update set fact = excluded.fact, updated_at = excluded.updated_at$$,
  'an update passes at the limit');

select pg_temp.as_anon();
select throws_ok('select count(*) from public.mimir_memory', '42501', null, 'anon cannot read facts');
reset role;
select ok(not has_any_column_privilege('anon', 'public.mimir_memory', 'SELECT, INSERT, UPDATE')
  and not has_table_privilege('anon', 'public.mimir_memory', 'DELETE, TRUNCATE'), 'anon has no access');
select ok(not has_any_column_privilege('mimir_session_reader', 'public.mimir_memory', 'SELECT'),
  'mimir_session_reader has no select');

select * from finish();
rollback;
