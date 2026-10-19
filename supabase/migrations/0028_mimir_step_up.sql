-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir steps up to a stronger model for hard turns, within each edition's limits. The app asks
-- with x-sx-tier: step; the proxy then asks mimir_turn_model, which answers the edition's step-up
-- model only when the edition has one and that model has a price row, and the base model
-- (Haiku 5.5) otherwise. The proxy never takes a model id from the client.
-- SlicerX steps up to Sonnet 5.5 and its edition day goes to $20; an install's day stays $1.
-- LayerMate keeps Haiku only, $5 an edition day and $1 an install. The web edition has no step-up.

-- No foreign key to mimir_prices: a step-up model without a price falls back to the base model
-- in mimir_turn_model instead of blocking a price change.
alter table public.mimir_limits
  add column step_up_model text check (step_up_model is null or char_length(step_up_model) between 1 and 80);

update public.mimir_limits set step_up_model = 'claude-sonnet-5-5', edition_daily_micros = 20000000 where edition = 'slicerx';

-- Sonnet 5.5 as published at https://platform.claude.com/docs/en/about-claude/pricing (read
-- 2026-10-18): $2 input and $10 output per million tokens at every prompt length (the full
-- context window at standard pricing, so the long rates equal the base ones and long_above is the
-- 1M context), 5-minute cache writes $2.50 (1.25x input), cache hits $0.10 (0.05x input), web
-- search $10 per 1,000. The table has no cache columns: mimir_cost bills cache reads at 0.1x
-- input, twice Sonnet's 0.05x, so its cache reads count high, never low.
insert into public.mimir_prices (model, input_mtok, output_mtok, long_above, long_input_mtok, long_output_mtok, search_each)
values ('claude-sonnet-5-5', 2000000, 10000000, 1000000, 2000000, 10000000, 10000);

-- The model for one turn: the edition's step-up model when the client asked for the step tier,
-- the edition has one and it has a price; else the base model. An unknown edition gets the base
-- model, and mimir_reserve refuses its install anyway.
create function public.mimir_turn_model(p_edition text, p_tier text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select l.step_up_model from public.mimir_limits l
     join public.mimir_prices p on p.model = l.step_up_model
     where p_tier = 'step' and l.edition = p_edition),
    'claude-haiku-5-5');
$$;

revoke execute on function public.mimir_turn_model(text, text) from public, anon, authenticated;
grant execute on function public.mimir_turn_model(text, text) to service_role;
