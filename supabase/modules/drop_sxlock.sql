-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Removes locked projects (migrations/0010_sxlock.sql, 0011_sxlock_seal.sql). Every .sxlock file
-- made on this database becomes unopenable. The sxlock_open and sxlock_seal
-- token scopes stay allowed, so existing tokens keep their scopes.
drop function if exists
  public.sxlock_seal(text), public.sxlock_open(uuid, uuid, text),
  public.sxlock_open_with_token(text, uuid, uuid, text), public.sxlock_seal_with_token(text, text),
  public.sxlock_keys(),
  public.rotate_sxlock_key(), public.revoke_sxlock_key(uuid);
drop schema if exists sxlock cascade;
