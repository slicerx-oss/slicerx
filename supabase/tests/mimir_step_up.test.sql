-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir's step-up model (pgTAP): SlicerX steps up to Sonnet 5.5 on the step tier, the base tier and
-- an edition without a step-up get Haiku 5.5, a step-up model without a price falls back to Haiku,
-- the caps are $20 an edition day and $1 an install, and only the service role can ask. Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select is(public.mimir_turn_model('slicerx', 'step'), 'claude-sonnet-5-5', 'SlicerX steps up to Sonnet 5.5 on the step tier');
select is(public.mimir_turn_model('slicerx', 'base'), 'claude-haiku-5-5', 'and stays on Haiku 5.5 on the base tier');
select is(public.mimir_turn_model('layermate', 'step'), 'claude-haiku-5-5', 'an edition without a step-up gets Haiku 5.5, not an error');

delete from public.mimir_prices where model = 'claude-sonnet-5-5';
select is(public.mimir_turn_model('slicerx', 'step'), 'claude-haiku-5-5', 'a step-up model without a price falls back to Haiku 5.5');

select is((select edition_daily_micros from public.mimir_limits where edition = 'slicerx'), 20000000::bigint, 'SlicerX gets $20 an edition day');
select is((select install_daily_micros from public.mimir_limits where edition = 'slicerx'), 1000000::bigint, 'and $1 an install');

select ok(has_function_privilege('service_role', 'public.mimir_turn_model(text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.mimir_turn_model(text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.mimir_turn_model(text, text)', 'EXECUTE'),
  'only the service role can ask for a turn''s model');

select * from finish();
rollback;
