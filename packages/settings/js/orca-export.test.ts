// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A profile exported for OrcaSlicer or Bambu Studio carries only what they read: a ramp lift (`Ramp Lift`, SlicerX's
// own lift type) goes out as Slope Lift, and the filament's own travel slope, a key of ours, is left out.
import { describe, expect, it } from 'vitest'
import { exportOrcaProfile, importFlat } from './index'

describe('an Orca profile export of a ramp lift', () => {
  it('writes a filament ramp as a slope lift without the filament travel slope', () => {
    const { config } = importFlat({ filament_z_hop: ['0.6'], filament_z_hop_types: ['Ramp Lift'], filament_travel_slope: ['1'], nozzle_temperature: ['215'] })
    const out = exportOrcaProfile(config, { name: 'Ramp PLA', section: 'filament' })
    expect(out['filament_z_hop_types']).toEqual(['Slope Lift'])
    expect(out['filament_z_hop']).toEqual(['0.6'])
    expect(out).not.toHaveProperty('filament_travel_slope')
    expect(out['nozzle_temperature']).toEqual(['215'])
  })

  it("writes a printer's ramp as a slope lift and keeps its other lift types", () => {
    const { config } = importFlat({ z_hop: ['0.6', '0.4'], z_hop_types: ['Ramp Lift', 'Spiral Lift'], travel_slope: ['1', '3'] })
    const out = exportOrcaProfile(config, { name: 'Ramp printer', section: 'printer' })
    expect(out['z_hop_types']).toEqual(['Slope Lift', 'Spiral Lift'])
    expect(out['travel_slope']).toEqual(['1', '3'])
  })
})
