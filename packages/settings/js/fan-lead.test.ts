// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fan lead time (`pre_start_fan_time`) reaches the engine from the shipped Bambu Lab filament presets and from a
// project file, as a setting the app keeps, instead of being dropped as a key it does not know.
import { describe, expect, it } from 'vitest'
import { loadFilamentPreset } from './filaments'
import { importProject } from './project'
import { checkValues } from './validate'

describe('fan lead time', () => {
  it("comes from the shipped presets: 2 s on the A1 and A1 mini's PLA Basic, unset (0) on the X1 Carbon's", async () => {
    for (const variant of ['BBL A1', 'BBL A1M']) {
      const p = (await loadFilamentPreset('BBL', 'Bambu PLA Basic', variant))!
      expect(p.config['pre_start_fan_time' as keyof typeof p.config], variant).toEqual([2])
      expect(p.extras, variant).not.toHaveProperty('pre_start_fan_time')
    }
    const x1c = (await loadFilamentPreset('BBL', 'Bambu PLA Basic', 'BBL X1C'))!
    expect(x1c.config).not.toHaveProperty('pre_start_fan_time')
  })

  it("is read from a project's settings, one value per filament", () => {
    const imported = importProject({ projectSettings: { pre_start_fan_time: ['0', '0', '2', '2'], filament_type: ['PLA', 'PLA', 'PLA', 'PLA'] } })
    expect(imported.config['pre_start_fan_time' as keyof typeof imported.config]).toEqual([0, 0, 2, 2])
    expect(imported.unknownKeys).not.toContain('pre_start_fan_time')
  })

  it('is checked against 0 to 5 s', () => {
    expect(checkValues({ pre_start_fan_time: [5] } as never).filter((i) => i.severity === 'error')).toEqual([])
    expect(checkValues({ pre_start_fan_time: [5.5] } as never)).toContainEqual(expect.objectContaining({ severity: 'error', keys: ['pre_start_fan_time'], message: 'Fan lead time is 5.5, outside 0 to 5 s.' }))
    expect(checkValues({ pre_start_fan_time: [-1] } as never)).toContainEqual(expect.objectContaining({ severity: 'error', message: 'Fan lead time is -1, outside 0 to 5 s.' }))
  })
})
