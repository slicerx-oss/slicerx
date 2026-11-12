-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- A desktop install's $20 day (0034) is no longer cut short by the limits above it: the desktop
-- edition's day goes from $20 to $100, an address's day from $2 to $20 and a network's day from $6
-- to $40. These days are raised for a period and are expected to come back down. Only those three
-- columns of the slicerx row change: its install day, its step-up model, its other caps and the
-- layermate and slicerx-web rows stay as they are. Running it twice changes nothing more.
update public.mimir_limits
set edition_daily_micros = 100000000, ip_daily_micros = 20000000, net_daily_micros = 40000000
where edition = 'slicerx';
