-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The layermate edition steps up to the stronger model on hard turns, as the slicerx edition does
-- (0028_mimir_step_up.sql), and its edition day matches slicerx's. Only those two columns of that one
-- row change: its install day, its share default, its registration keys and every other row stay as
-- they are. A turn steps up only when the client sends x-sx-tier: step; the edition day applies to
-- every turn at once. Running it twice changes nothing more.
update public.mimir_limits
set step_up_model = 'claude-sonnet-5-5', edition_daily_micros = 20000000
where edition = 'layermate';
