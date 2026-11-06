// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// evenFilamentLists: every per-filament list of a project's settings at one entry per filament.
import { describe, expect, it } from 'vitest'
import { evenFilamentLists, isFilamentList } from './slot-settings'

describe('per-filament lists', () => {
  it('knows the filament settings and the project filament lists, not the process or printer ones', () => {
    expect(isFilamentList('nozzle_temperature')).toBe(true)
    expect(isFilamentList('filament_colour')).toBe(true)
    expect(isFilamentList('filament_ids')).toBe(true)
    expect(isFilamentList('filament_settings_id')).toBe(true)
    expect(isFilamentList('layer_height')).toBe(false)
    expect(isFilamentList('nozzle_diameter')).toBe(false)
    expect(isFilamentList('flush_volumes_matrix')).toBe(false)
  })

  it('fills each list to the count with its last entry, and a value given once becomes a list', () => {
    const out = evenFilamentLists({ nozzle_temperature: ['220', '250'], filament_flow_ratio: '0.98', layer_height: '0.2', wall_loops: ['2'] }, 4)
    expect(out['nozzle_temperature']).toEqual(['220', '250', '250', '250'])
    expect(out['filament_flow_ratio']).toEqual(['0.98', '0.98', '0.98', '0.98'])
    expect(out['layer_height']).toBe('0.2')
    expect(out['wall_loops']).toEqual(['2'])
  })

  it("takes a filament's own value where one is given, and cuts a list past the count", () => {
    const own = (key: string, i: number) => (key === 'nozzle_temperature' && i === 2 ? '255' : undefined)
    const out = evenFilamentLists({ nozzle_temperature: ['220'], filament_type: ['PLA', 'PLA', 'PETG', 'TPU'] }, 3, own)
    expect(out['nozzle_temperature']).toEqual(['220', '220', '255'])
    expect(out['filament_type']).toEqual(['PLA', 'PLA', 'PETG'])
  })

  it('keeps an empty list (a filament override no filament sets) empty', () => {
    expect(evenFilamentLists({ filament_retraction_length: [] }, 3)['filament_retraction_length']).toEqual([])
  })
})
