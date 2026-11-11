// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's per-filament overrides: a `nil` entry is that filament on the printer's value, so opening the project
// keeps it instead of copying the entry before it or dropping the whole list.
import { describe, expect, it } from 'vitest'
import { filamentOverrideList, projectSettingChanges } from './project-open'
import { FILAMENT_OVERRIDE_KEYS } from './stock-layer'

describe('per-filament overrides in a project', () => {
  it("keep each filament's own value and its nil entries", () => {
    const raw = { filament_z_hop: ['0.6', 'nil'], filament_z_hop_types: ['nil', 'Ramp Lift'], filament_travel_slope: 'nil,20', filament_retraction_length: ['0.8', 'nil', '1.2'] }
    const { values } = projectSettingChanges(raw, {} as never)
    expect(values['filament_z_hop']).toEqual([0.6, 'nil'])
    expect(values['filament_z_hop_types']).toEqual(['nil', 'Ramp Lift'])
    expect(values['filament_travel_slope']).toEqual(['nil', 20])
    expect(values['filament_retraction_length']).toEqual([0.8, 'nil', 1.2])
  })

  it('read lists with no nil, and lists of nil only, as before', () => {
    const { values } = projectSettingChanges({ filament_z_hop: ['0.6', '0.4'], filament_z_hop_types: ['nil', 'nil'] }, {} as never)
    expect(values['filament_z_hop']).toEqual([0.6, 0.4])
    expect(values).not.toHaveProperty('filament_z_hop_types')
  })

  it('leave other keys and values that do not read to the usual import', () => {
    expect(filamentOverrideList('nozzle_temperature', ['215', 'nil'])).toBeUndefined()
    expect(filamentOverrideList('filament_z_hop', ['0.6'])).toBeUndefined()
    expect(filamentOverrideList('filament_z_hop', ['high', 'nil'])).toBeUndefined()
  })

  it('take no empty filament override list: it leaves the value to the filament', () => {
    // Our own project writes [] for each override the filament does not set. Against a filament that sets it (a cut
    // retraction of 18 mm), [] is no change and no value to pin, on every override key.
    const keys = [...FILAMENT_OVERRIDE_KEYS]
    expect(keys.length).toBeGreaterThan(10)
    const raw = Object.fromEntries(keys.map((k) => [k, []]))
    const r = projectSettingChanges(raw, { filament_retraction_distances_when_cut: [18] } as never)
    for (const k of keys) {
      expect(r.values, k).not.toHaveProperty(k)
      expect(r.taken, k).not.toHaveProperty(k)
    }
  })

  it('still take a filament override a person set, empty or not around it', () => {
    const r = projectSettingChanges({ filament_retraction_distances_when_cut: ['12'], filament_retraction_length: [] }, { filament_retraction_distances_when_cut: [18] } as never)
    expect(r.values['filament_retraction_distances_when_cut']).toEqual([12])
    expect(r.taken).not.toHaveProperty('filament_retraction_length')
  })
})
