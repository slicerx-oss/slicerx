// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { perSlot } from '../src/adapters/profile'

describe('per-slot filament values', () => {
  it('leaves an unset filament override as nil instead of borrowing another slot', () => {
    const pla = { nozzle_temperature: [215] }
    const tpu = { nozzle_temperature: [230], filament_retraction_length: [1.2] }
    const out = perSlot([pla, tpu])
    expect(out.filament_retraction_length).toEqual(['nil', 1.2])
    expect(out.nozzle_temperature).toEqual([215, 230])
  })

  it('reads an empty override list as nil', () => {
    const out = perSlot([{ filament_z_hop: [] }, { filament_z_hop: [0.6] }])
    expect(out.filament_z_hop).toEqual(['nil', 0.6])
  })

  it('still fills ordinary keys from the first slot that has them', () => {
    const out = perSlot([{ a: [1] }, { fan_min_speed: [35] }])
    expect(out.fan_min_speed).toEqual([35, 35])
  })
})
