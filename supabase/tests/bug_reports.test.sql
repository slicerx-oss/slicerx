-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Crash and bug reports (pgTAP): clients cannot touch the table, submit_bug_report
-- works signed in and out, checks the kind and lengths, and holds the rate limits
-- (10 an hour per install, 200 an hour overall). Run with `supabase test db` after
-- `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

create temp table ids on commit drop as
select (select id from public.profiles where handle = 'rv') as rv, gen_random_uuid() as install, gen_random_uuid() as other;
create temp table got (k text primary key, id uuid) on commit drop;
grant select on ids to anon, authenticated, service_role;
grant all on got to anon, authenticated, service_role;

create function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
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

-- A valid report from p_install, with one field swapped for a test.
create function pg_temp.submit(p_install uuid, p_kind text default 'manual', p_title text default 'The preview is blank',
  p_body text default 'Slice, then open Preview.', p_app_version text default '0.1.0', p_os text default 'macOS 15.1 (arm64)',
  p_printer text default 'Bambu Lab A1 mini, firmware 01.04', p_stack text default null, p_log_tail text default null,
  p_fingerprint text default null, p_commit text default '0f15b63a') returns uuid language sql as $$
  select public.submit_bug_report(p_kind, p_install, p_app_version, p_commit, p_os, p_printer, p_title, p_body, p_stack, p_log_tail, p_fingerprint);
$$;
grant execute on function pg_temp.submit(uuid, text, text, text, text, text, text, text, text, text, text) to anon, authenticated;

-- No direct access ---------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok('select * from public.bug_reports', '42501', null, 'anon cannot read reports');
select throws_ok($$insert into public.bug_reports (kind, install_id, app_version, commit, os, title, body) values ('manual', gen_random_uuid(), '1', 'abc', 'os', 't', 'b')$$,
  '42501', null, 'anon cannot insert directly');
select throws_ok($$update public.bug_reports set posted_at = now()$$, '42501', null, 'anon cannot update reports');
select throws_ok($$delete from public.bug_reports$$, '42501', null, 'anon cannot delete reports');

select pg_temp.as_user((select rv from ids));
select throws_ok('select * from public.bug_reports', '42501', null, 'members cannot read reports');
select throws_ok($$insert into public.bug_reports (kind, install_id, app_version, commit, os, title, body) values ('manual', gen_random_uuid(), '1', 'abc', 'os', 't', 'b')$$,
  '42501', null, 'members cannot insert directly');
select throws_ok($$update public.bug_reports set posted_at = now()$$, '42501', null, 'members cannot update reports');
select throws_ok($$delete from public.bug_reports$$, '42501', null, 'members cannot delete reports');

-- Submitting ---------------------------------------------------------------------
select pg_temp.as_anon();
insert into got values ('anon', pg_temp.submit((select install from ids), 'crash', 'TypeError: x is undefined', '', p_stack => 'at slice (index.js)', p_log_tail => '12:00:01 error boom', p_fingerprint => repeat('a', 64)));
select ok((select id from got where k = 'anon') is not null, 'anon can submit a crash report');

select pg_temp.as_user((select rv from ids));
insert into got values ('member', pg_temp.submit((select install from ids)));
select ok((select id from got where k = 'member') is not null, 'members can submit a report');

reset role;
select is((select user_id from public.bug_reports where id = (select id from got where k = 'anon')), null, 'a signed-out report has no account');
select is((select user_id from public.bug_reports where id = (select id from got where k = 'member')), (select rv from ids), 'a signed-in report names the account');
select is((select kind || ' ' || title || ' ' || fingerprint from public.bug_reports where id = (select id from got where k = 'anon')),
  'crash TypeError: x is undefined ' || repeat('a', 64), 'the fields are stored as sent');
select ok((select posted_at is null and discord_message_id is null from public.bug_reports where id = (select id from got where k = 'member')), 'a new report is not posted yet');
select is((select printer from public.bug_reports where id = (select id from got where k = 'member')), 'Bambu Lab A1 mini, firmware 01.04', 'the printer is kept');

-- The poller, with the service key, reads and marks rows.
set local role service_role;
select is((select count(*)::int from public.bug_reports where posted_at is null), 2, 'the service role reads unposted reports');
update public.bug_reports set posted_at = now(), discord_message_id = '1' where id = (select id from got where k = 'anon');
select is((select discord_message_id from public.bug_reports where id = (select id from got where k = 'anon')), '1', 'the service role marks a report posted');

-- Checks -------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select pg_temp.submit((select other from ids), 'feedback')$$, '22023', null, 'an unknown kind is refused');
select throws_ok($$select pg_temp.submit(null)$$, '22023', null, 'an install id is required');
select throws_ok($$select pg_temp.submit((select other from ids), p_title => '   ')$$, '22023', null, 'a blank title is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_title => repeat('t', 201))$$, '22001', null, 'a title over 200 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_body => repeat('b', 20001))$$, '22001', null, 'a body over 20,000 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_stack => repeat('s', 50001))$$, '22001', null, 'a stack over 50,000 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_log_tail => repeat('l', 200001))$$, '22001', null, 'a log tail over 200,000 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_app_version => repeat('v', 41))$$, '22001', null, 'a version over 40 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_commit => repeat('c', 41))$$, '22001', null, 'a commit over 40 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_os => repeat('o', 81))$$, '22001', null, 'an OS over 80 characters is refused');
select throws_ok($$select pg_temp.submit((select other from ids), p_printer => repeat('p', 121))$$, '22001', null, 'a printer over 120 characters is refused');
select lives_ok($$select pg_temp.submit((select other from ids), p_title => repeat('t', 200), p_body => repeat('b', 20000), p_stack => repeat('s', 50000), p_log_tail => repeat('l', 200000))$$,
  'fields at their limits are accepted');

-- Rate limits ----------------------------------------------------------------------
-- The install has 2 reports this hour; 8 more fit, the 11th does not.
select lives_ok($$select pg_temp.submit((select install from ids)) from generate_series(1, 8)$$, 'an install can send 10 reports an hour');
select throws_ok($$select pg_temp.submit((select install from ids))$$, 'P0001', 'too many reports from this install; try again later', 'the 11th report in an hour is refused');

-- 11 reports so far this hour. Fill up to 199 from other installs, then one more fits and the next does not.
reset role;
insert into public.bug_reports (kind, install_id, app_version, commit, os, title, body)
select 'crash', gen_random_uuid(), '0.1.0', 'abc', 'Linux', 'filler', '' from generate_series(1, 188);
select pg_temp.as_anon();
select lives_ok($$select pg_temp.submit(gen_random_uuid())$$, 'the 200th report of the hour is accepted');
select throws_ok($$select pg_temp.submit(gen_random_uuid())$$, 'P0001', 'too many reports right now; try again later', 'everyone together is held to 200 an hour');

select * from finish();
rollback;
