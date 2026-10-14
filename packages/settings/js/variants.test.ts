// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { selectVariants } from './variants'

const standard = 'Direct Drive Standard'
const high = 'Direct Drive High Flow'
const mapped = {
  filament_settings_id: ['one', 'two'],
  filament_self_index: ['2', '1', '2', '1'],
  filament_extruder_variant: [high, standard, standard, high],
  filament_map: ['2', '1'],
  extruder_type: ['Direct Drive', 'Direct Drive'],
  nozzle_volume_type: ['Standard', 'High Flow'],
  filament_max_volumetric_speed: ['42', '11', '22', '31'],
}

describe('explicit filament variants', () => {
  it('uses filament identity and the mapped physical extruder', () => {
    expect(selectVariants(mapped)['filament_max_volumetric_speed']).toEqual(['31', '22'])
  })

  it('keeps metadata, printer arrays, ordinary slot arrays and unknown arrays', () => {
    const raw = { ...mapped, nozzle_diameter: ['0.4', '0.6', '0.8', '1.0'], hot_plate_temp: ['55', '60'], future_values: [1, 2, 3, 4] }
    const result = selectVariants(raw)
    for (const key of ['filament_self_index', 'filament_extruder_variant', 'nozzle_diameter', 'hot_plate_temp', 'future_values'] as const) {
      expect(result[key], key).toEqual(raw[key])
    }
    expect(raw.filament_max_volumetric_speed).toEqual(['42', '11', '22', '31'])
    expect(selectVariants(result)).toEqual(result)
  })

  it('separates process and filament tables of the same length', () => {
    const result = selectVariants({ ...mapped, print_extruder_id: ['1', '1', '2', '2'], print_extruder_variant: [standard, high, standard, high], outer_wall_speed: ['100', '200', '110', '210'] })
    expect(result['outer_wall_speed']).toEqual(['100', '210'])
    expect(result['filament_max_volumetric_speed']).toEqual(['31', '22'])
  })

  it('preserves selected nil entries for inheritance', () => {
    expect(selectVariants({ ...mapped, filament_retraction_length: ['9', '8', '0.4', 'nil'] })['filament_retraction_length']).toEqual(['nil', '0.4'])
  })

  it('rejects missing and duplicate matches instead of picking a different variant', () => {
    expect(() => selectVariants({ ...mapped, filament_extruder_variant: [high, standard, high, high] })).toThrow(/variant/i)
    expect(() => selectVariants({ ...mapped, filament_extruder_variant: [standard, high, standard, high] })).toThrow(/variant/i)
  })

  it('accepts a future variant only when its explicit name matches', () => {
    const future = { ...mapped, nozzle_volume_type: ['Standard', 'Future'], filament_extruder_variant: [high, standard, standard, 'Direct Drive Future'] }
    expect(selectVariants(future)['filament_max_volumetric_speed']).toEqual(['31', '22'])
  })
})


describe('variant identity validation', () => {
  it('rejects missing physical process identities', () => {
    expect(() => selectVariants({ extruder_type: ['Direct Drive', 'Direct Drive'], nozzle_volume_type: ['Standard', 'High Flow'], print_extruder_id: ['2', '2'], print_extruder_variant: [standard, high], outer_wall_speed: [110, 210] })).toThrow(/variant/i)
  })

  it('accepts unequal explicit groups and rejects malformed maps', () => {
    expect(selectVariants({ ...mapped, filament_self_index: ['1', '1', '2'], filament_extruder_variant: [standard, high, standard], filament_max_volumetric_speed: [11, 31, 22] })['filament_max_volumetric_speed']).toEqual([31, 22])
    for (const map of [[], ['1'], ['0', '1'], ['3', '1']]) expect(() => selectVariants({ ...mapped, filament_map: map })).toThrow(/variant/i)
    expect(() => selectVariants({ ...mapped, filament_self_index: ['2', '1', '2'] })).toThrow(/variant/i)
  })

  it('accepts validated legacy groups without explicit filament identities', () => {
    const raw = { ...mapped, filament_self_index: undefined, filament_extruder_variant: [standard, high, high, standard], filament_max_volumetric_speed: [11, 31, 42, 22] }
    expect(selectVariants(raw)['filament_max_volumetric_speed']).toEqual([31, 22])
    expect(() => selectVariants({ ...raw, filament_extruder_variant: [standard, high, high, 'Different'] })).toThrow(/variant/i)
  })
})
