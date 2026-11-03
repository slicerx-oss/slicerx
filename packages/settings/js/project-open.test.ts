// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's per-filament overrides: a `nil` entry is that filament on the printer's value, so opening the project
// keeps it instead of copying the entry before it or dropping the whole list.
import { describe, expect, it } from 'vitest'
import { filamentOverrideList, projectSettingChanges } from './project-open'

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
})
