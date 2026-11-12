-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- A desktop install's free mimir day goes from $1 to $20, so one day covers a longer design session.
-- Only install_daily_micros of the slicerx row changes: its edition day, its step-up model, its other
-- caps and the layermate and slicerx-web rows stay as they are. Running it twice changes nothing more.
update public.mimir_limits
set install_daily_micros = 20000000
where edition = 'slicerx';
