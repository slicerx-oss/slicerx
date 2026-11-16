-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The desktop days raised for a period in 0034 and 0035 come back down: a slicerx install's day goes
-- from $20 to $1, the edition's day from $100 to $20, an address's day from $20 to $2 and a network's
-- day from $40 to $6, the values the slicerx row had before 0034. Only those four columns of the
-- slicerx row change: its step-up model, its other caps and the layermate and slicerx-web rows stay as
-- they are. Running it twice changes nothing more.
update public.mimir_limits
set install_daily_micros = 1000000, edition_daily_micros = 20000000, ip_daily_micros = 2000000, net_daily_micros = 6000000
where edition = 'slicerx';
