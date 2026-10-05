-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Account self-service and API token safety (pgTAP): data export, deletion
-- with a grace period, cascading removal of uploads, per-token rate limits,
-- last-used address, revoke-all. Run with `supabase test db` after
-- `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.profiles where handle = 'owner') as owner,
  (select id from public.profiles where handle = 'moderator') as moderator,
  (select id from public.profiles where handle = 'ferro') as victim,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as victim_creator;
grant select on ids to anon, authenticated, service_role;
create temp table before on commit drop as
select
  (select array_agg(id) from public.listings where creator_id = (select victim_creator from ids)) as victim_listings,
  (select count(*) from public.listings) as listing_rows,
  (select count(*) from public.audit_log) as audit_rows;
create temp table tok (token text, id uuid) on commit drop;
create temp table exported (doc jsonb) on commit drop;
grant select on ids, before to anon, authenticated, service_role;
grant all on tok, exported to authenticated, service_role;

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

select ok((select cardinality(victim_listings) > 0 from before), 'the member being deleted has uploads');

-- Token rate limits, last-used address, revoke-all ------------------------------
select pg_temp.as_user((select rv from ids));
select throws_ok(
  $$select * from public.create_api_token('Too fast', array['cli'], 30, 0)$$,
  '23514', null, 'a rate limit below 1 per minute is rejected');
insert into tok select t.token, t.id from public.create_api_token('Rate test', array['cloud_slice'], 30, 2) t;
select throws_ok(
  $$select * from public.api_token_usage$$,
  '42501', null, 'members cannot read request counts');

select pg_temp.as_service();
select is((select remaining from public.resolve_api_token((select token from tok), '192.0.2.10')), 1, 'first request is allowed, one left this minute');
select is((select allowed from public.resolve_api_token((select token from tok), '192.0.2.10')), true, 'second request is allowed');
select is((select count(*)::int from public.resolve_api_token((select token from tok), '192.0.2.10')), 0, 'over the limit, the default call fails closed with no row');
select is(
  (select allowed from public.resolve_api_token((select token from tok), '192.0.2.10', true)),
  false, 'with p_report_limit, an over-limit call reports allowed = false');
select ok((select retry_after_s from public.resolve_api_token((select token from tok), null, true)) between 1 and 60, 'and says when to retry');

select pg_temp.as_user((select rv from ids));
select is((select host(last_used_ip) from public.api_tokens where id = (select id from tok)), '192.0.2.10', 'the member sees the last address that used the token');
select ok(public.revoke_all_api_tokens() >= 1, 'revoke-all revokes the member''s tokens');
select is((select count(*)::int from public.api_tokens where user_id = (select rv from ids) and revoked_at is null), 0, 'no active tokens remain');
select pg_temp.as_service();
select is((select count(*)::int from public.resolve_api_token((select token from tok))), 0, 'a revoked token no longer resolves');

-- Export ------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select public.export_my_data()$$, '42501', null, 'anon cannot export');

select pg_temp.as_user((select rv from ids));
insert into exported select public.export_my_data();
select is((select doc ->> 'format' from exported), 'slicerx-account-export', 'the export names its format');
select is((select doc -> 'profile' ->> 'handle' from exported), 'rv', 'the export has the profile');
select is((select doc -> 'account' ->> 'email' from exported), 'rv@example.com', 'the export has the sign-in email');
select is(
  (select jsonb_array_length(doc -> 'likes') from exported),
  (select count(*)::int from public.likes where user_id = (select rv from ids)), 'the export has the member''s likes');
select is(
  (select count(*)::int from exported, jsonb_array_elements(doc -> 'likes') l where (l ->> 'user_id')::uuid <> (select rv from ids)),
  0, 'the export has no one else''s likes');
select ok((select doc ? 'sync_profiles' and doc ? 'collections' and doc ? 'likes' and doc ? 'downloads' and doc ? 'paired_devices' and doc ? 'listings' from exported), 'the export covers the library, devices and uploads');
select is(
  (select count(*)::int from exported where doc ? 'subscriptions' or doc ? 'licenses' or doc ? 'boosts' or doc ? 'print_events'),
  0, 'the pricing sections are gone from the export');

select pg_temp.as_user((select victim from ids));
delete from exported;
insert into exported select public.export_my_data();
select is((select jsonb_array_length(doc -> 'listings') from exported), cardinality((select victim_listings from before)), 'a creator''s export has every upload');
select ok((select jsonb_array_length(doc -> 'creator_page') = 1 and jsonb_array_length(doc -> 'creator_links') > 0 from exported), 'and the creator page with its links');
select is((select jsonb_array_length(doc -> 'listing_versions') from exported), (select count(*)::int from public.listing_versions where listing_id = any (array(select unnest(victim_listings) from before))), 'and every version');
select pg_temp.as_user((select rv from ids));
select is(
  (select count(*)::int from exported, jsonb_array_elements(doc -> 'api_tokens') t where t ? 'token_hash'),
  0, 'token hashes are left out of the export');

-- Deletion ------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select public.request_account_deletion()$$, '42501', null, 'anon cannot request deletion');

select pg_temp.as_user((select owner from ids));
select throws_ok(
  $$select public.request_account_deletion()$$,
  'P0001', 'the owner account cannot be deleted; transfer the owner role first', 'the owner cannot delete their account');
select pg_temp.as_user((select moderator from ids));
select lives_ok($$select public.request_account_deletion()$$, 'a moderator can ask for deletion');
select ok(public.cancel_account_deletion(), 'and cancel it');

select pg_temp.as_user((select rv from ids));
select ok(
  (select (public.request_account_deletion() ->> 'purge_after')::timestamptz between now() + interval '29 days' and now() + interval '31 days'),
  'a member schedules deletion 30 days out');
select throws_ok(
  $$select * from public.create_api_token('After', array['cli'])$$,
  'P0001', 'this account is scheduled for deletion', 'no new tokens while deletion is scheduled');
select ok(public.cancel_account_deletion(), 'the member cancels within the grace period');
select pg_temp.as_user((select ash from ids));
select is((select count(*)::int from public.account_deletions), 0, 'other members cannot see deletion requests');
select throws_ok(
  $$select public.purge_account((select rv from ids))$$,
  '42501', null, 'members cannot purge accounts');

select pg_temp.as_service();
select is(cardinality(public.purge_due_accounts()), 0, 'nothing is purged before the grace period ends or after a cancel');

select pg_temp.as_user((select victim from ids));
insert into public.comments (listing_id, user_id, body) select (select l.id from public.listings l where l.status = 'approved' and l.creator_id <> (select victim_creator from ids) limit 1), (select victim from ids), 'A remark from the creator';
select lives_ok($$select public.request_account_deletion()$$, 'a creator requests deletion');
reset role;
update public.account_deletions set purge_after = now() - interval '1 minute' where user_id = (select victim from ids);
select pg_temp.as_service();
select is(public.purge_due_accounts(), array[(select victim from ids)], 'the service purges the request once its grace period is over and returns its id');

reset role;
select is((select count(*)::int from auth.users where id = (select victim from ids)), 0, 'the sign-in account is gone');
select is(
  (select count(*)::int from public.profiles where id = (select victim from ids))
  + (select count(*)::int from public.creators where id = (select victim_creator from ids))
  + (select count(*)::int from public.listings where id = any (array(select unnest(victim_listings) from before))),
  0, 'profile, creator page and uploads are gone');
select is((select count(*) from public.listings), (select listing_rows - cardinality(victim_listings) from before), 'no one else''s listings were touched');
select is(
  (select count(*)::int from public.storage_cleanup where done_at is null and bucket = 'listing-files' and prefix = any (select l::text || '/' from unnest((select victim_listings from before)) l)),
  cardinality((select victim_listings from before)), 'the uploaded files are queued for removal from storage');
select is(
  (select count(*)::int from public.comments c where c.body = '[deleted]' and c.user_id is null and c.listing_id in (select id from public.listings)),
  (select count(*)::int from public.comments c where c.body = '[deleted]'), 'the creator''s comments stay with author and text removed');
select ok((select count(*) from public.comments where body = '[deleted]') >= 1, 'at least one comment was anonymized');
select ok((select count(*) from public.audit_log) >= (select audit_rows from before), 'the audit log keeps its rows');
select ok((select completed_at is not null from public.account_deletions where user_id = (select victim from ids)), 'a record of the deletion remains');

select pg_temp.as_service();
select throws_ok(
  $$select public.purge_account((select owner from ids))$$,
  'P0001', null, 'the owner account cannot be purged');

select * from finish();
rollback;
