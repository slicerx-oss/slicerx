-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Partner app tokens (0032_partner_tokens.sql, pgTAP): a member issues a
-- cloud_slice token to a named partner app, sees it with the app's name,
-- revokes it, and it stops resolving. The scope and the expiry cannot be
-- widened. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash,
  '47173fd9-98a7-51bf-9a48-636445f84d02'::uuid as banned;
create temp table tok (who text, token text, id uuid, expires_at timestamptz) on commit drop;
grant select on ids to anon, authenticated, service_role;
grant all on tok to authenticated, service_role;

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

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end;
$$;

-- Who may issue one ---------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select * from public.create_partner_token('Example Phone')$$, '42501', null, 'anon cannot issue a partner app token');

select pg_temp.as_user((select banned from ids));
select throws_ok($$select * from public.create_partner_token('Example Phone')$$, '42501', null, 'a banned member cannot issue one');

select pg_temp.as_user((select rv from ids));
select throws_ok($$select * from public.create_partner_token('')$$, '23514', null, 'the app needs a name');
select throws_ok($$select * from public.create_partner_token('   ')$$, '23514', null, 'a name of spaces is no name');
select throws_ok($$select * from public.create_partner_token(repeat('x', 61))$$, '23514', null, 'names are at most 60 characters');
select throws_ok($$select * from public.create_partner_token(E'Example\nPhone')$$, '23514', null, 'control characters are refused');
select throws_ok($$select * from public.create_partner_token('Example Phone', null)$$, '23514', null, 'a partner app token always expires');
select throws_ok($$select * from public.create_partner_token('Example Phone', 400)$$, '23514', null, 'and within a year');

-- Issuing and seeing it -----------------------------------------------------------
insert into tok select 'rv', t.token, t.id, t.expires_at from public.create_partner_token('  Example Phone ', 30) t;
select ok((select token ~ '^sxk_[0-9a-f]{64}$' from tok where who = 'rv'), 'the token is an sxk_ token, returned once');
select is(
  (select row(name, partner_app, scopes, rate_limit_per_minute)::text from public.api_tokens where id = (select id from tok where who = 'rv')),
  row('Example Phone', 'Example Phone', array['cloud_slice'], 60)::text,
  'the member sees it under the app''s name, with the cloud_slice scope only');
select ok(
  (select expires_at between now() + interval '29 days' and now() + interval '31 days' from public.api_tokens where id = (select id from tok where who = 'rv')),
  'it expires when asked');
insert into tok select 'rv-default', t.token, t.id, t.expires_at from public.create_partner_token('Other App') t;
select ok(
  (select expires_at between now() + interval '89 days' and now() + interval '91 days' from tok where who = 'rv-default'),
  'by default after 90 days');
select is((select partner_app from public.api_tokens where id = (select id from tok where who = 'rv-default')), 'Other App', 'a second app gets its own token');
insert into tok select 'rv-own', t.token, t.id, t.expires_at from public.create_api_token('Laptop CLI', array['cloud_slice', 'cli'], 30) t;
select is((select partner_app from public.api_tokens where id = (select id from tok where who = 'rv-own')), null, 'a token the member makes for their own tools is not a partner token');

select pg_temp.as_user((select ash from ids));
select is((select count(*)::int from public.api_tokens where id = (select id from tok where who = 'rv')), 0, 'another member cannot see it');
select is(public.revoke_api_token((select id from tok where who = 'rv')), false, 'or revoke it');

-- The grant cannot be widened -------------------------------------------------------
select pg_temp.as_user((select rv from ids));
select throws_ok(
  $$update public.api_tokens set scopes = array['cloud_slice', 'link'] where id = (select id from tok where who = 'rv')$$,
  '42501', null, 'the member cannot change its scopes');
select throws_ok(
  $$update public.api_tokens set partner_app = null where id = (select id from tok where who = 'rv')$$,
  '42501', null, 'or clear the app name');
reset role;
select throws_ok(
  $$update public.api_tokens set scopes = array['cloud_slice', 'link'] where id = (select id from tok where who = 'rv')$$,
  '23514', null, 'even the table owner cannot give a partner token another scope');
select throws_ok(
  $$update public.api_tokens set expires_at = null where id = (select id from tok where who = 'rv')$$,
  '23514', null, 'or take away its expiry');

-- The service resolves it with the app's name ---------------------------------------
select pg_temp.as_user((select rv from ids));
select throws_ok($$select * from public.resolve_api_token((select token from tok where who = 'rv'))$$, '42501', null, 'members cannot resolve tokens');
select pg_temp.as_service();
select is(
  (select row(user_id, scopes, allowed, partner_app)::text from public.resolve_api_token((select token from tok where who = 'rv'), '192.0.2.20', true)),
  row((select rv from ids), array['cloud_slice'], true, 'Example Phone')::text,
  'resolve_api_token returns the account, the scope and the partner app');
select is(
  (select partner_app from public.resolve_api_token((select token from tok where who = 'rv-own'))),
  null, 'and no partner app for the member''s own token');
select is(
  (select retry_after_s from public.resolve_api_token((select token from tok where who = 'rv-own'))),
  0, 'the other columns are as before');

-- Revoking --------------------------------------------------------------------------
select pg_temp.as_user((select rv from ids));
select is((select host(last_used_ip) from public.api_tokens where id = (select id from tok where who = 'rv')), '192.0.2.20', 'the member sees when and from where the app last used it');
select is(public.revoke_api_token((select id from tok where who = 'rv')), true, 'the member revokes it like any token');
select ok((select revoked_at is not null from public.api_tokens where id = (select id from tok where who = 'rv')), 'it shows as revoked');
select pg_temp.as_service();
select is((select count(*)::int from public.resolve_api_token((select token from tok where who = 'rv'), null, true)), 0, 'a revoked partner token no longer resolves');
select is((select partner_app from public.resolve_api_token((select token from tok where who = 'rv-default'))), 'Other App', 'the other app''s token still does');

select * from finish();
rollback;
