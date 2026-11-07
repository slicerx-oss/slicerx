// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { checkValues, rangeMessage, usualRangeMessage } from './validate'

const messages = (config: Record<string, unknown>, code: string) =>
  checkValues(config as never).filter((i) => i.code === code).map((i) => i.message)

describe('range messages', () => {
  it('name only the lower limit when a setting has no upper limit', () => {
    expect(messages({ layer_height: 0 }, 'out_of_range')).toEqual(['Layer height is 0; it must be at least 0.01 mm.'])
    expect(messages({ filament_diameter: [0] }, 'out_of_range')).toEqual(['Filament diameter is 0; it must be at least 0.01 mm.'])
  })

  it('name only the upper limit when a setting has no lower limit', () => {
    expect(messages({ wipe_tower_extra_rib_length: 400 }, 'out_of_range')).toEqual(['Prime tower extra rib length is 400; it must be at most 300 mm.'])
  })

  it('keep the two-sided form when both limits exist', () => {
    expect(messages({ wall_loops: -1 }, 'out_of_range')).toEqual(['Wall loops is -1, outside 0 to 1000.'])
    expect(messages({ layer_height: 0.9 }, 'outside_recommended_range')).toEqual(['Layer height is 0.9, outside the usual 0.04 to 0.8 mm.'])
  })

  it('never print inf for an open side', () => {
    for (const config of [{ layer_height: 0 }, { initial_layer_print_height: 0 }, { nozzle_height: 0 }, { extruder_clearance_radius: 0 }, { wipe_tower_extra_rib_length: 400 }, { skirt_height: 20000 }]) {
      const out = messages(config, 'out_of_range')
      expect(out).toHaveLength(1)
      expect(out[0]).not.toMatch(/\binf\b/)
    }
  })

  it('word each side of the usual range on its own', () => {
    expect(usualRangeMessage('Layer height', 0.9, undefined, 0.6, ' mm')).toBe('Layer height is 0.9, above the usual maximum of 0.6 mm.')
    expect(usualRangeMessage('Wall loops', 0, 1, undefined, '')).toBe('Wall loops is 0, below the usual minimum of 1.')
    expect(usualRangeMessage('Wall loops', 0, 1, 20, '')).toBe('Wall loops is 0, outside the usual 1 to 20.')
    expect(rangeMessage('Skirt height', 20000, undefined, 10000, ' layers')).toBe('Skirt height is 20000; it must be at most 10000 layers.')
    expect(rangeMessage('Layer height', 0, 0.01, undefined, ' mm')).toBe('Layer height is 0; it must be at least 0.01 mm.')
  })
})
