// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower setting of the shipped process presets. Orca's CLI turns enable_prime_tower off whenever a plate has
// one filament (PrintConfig.cpp, used_filaments == 1), so a resolved dump made from a one-color plate reads false even
// when the maker's preset enables the tower (Bambu Lab's fdm_process_common sets it). The resolved profiles must keep
// the preset's value, or every multi-color plate on these printers slices without a tower.
import { describe, expect, it } from 'vitest'
import { resolvedProfile } from './resolved'

describe('prime tower in the resolved process presets', () => {
  it.each([
    ['bambu-p1s', 'standard'],
    ['bambu-x1-carbon', 'fine'],
    ['bambu-a1', 'draft'],
  ])('%s %s enables the tower as the maker preset does', async (id, tier) => {
    const r = await resolvedProfile(id, tier)
    expect(r?.process['enable_prime_tower']).toBe(true)
  })
})
