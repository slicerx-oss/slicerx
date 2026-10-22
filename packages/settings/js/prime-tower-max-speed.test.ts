// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `prime_tower_max_speed` (Bambu Lab's cap on the prime tower's speeds) reaches the engine from a project file and
// from an imported profile, instead of being dropped as a key from another slicer.
import { describe, expect, it } from 'vitest'
import { settingDef } from './schema'
import { importProject } from './project'
import { importValues, projectReport } from './report'

describe('prime tower max speed', () => {
  it('is a process setting in mm/s, 90 by default', () => {
    expect(settingDef('prime_tower_max_speed')).toMatchObject({ section: 'process', type: 'float', unit: 'mm/s', default: 90, group: 'multimaterial', invalidates: 'paths' })
  })

  it("is read from a project's settings", () => {
    const imported = importProject({ projectSettings: { prime_tower_max_speed: '50', layer_height: '0.2' } })
    expect(imported.config['prime_tower_max_speed' as keyof typeof imported.config]).toBe(50)
    expect(imported.unknownKeys).not.toContain('prime_tower_max_speed')
  })

  it('is kept from an imported profile and not reported as unsupported', () => {
    const { config, dropped } = importValues({ prime_tower_max_speed: '120' })
    expect(config['prime_tower_max_speed' as keyof typeof config]).toBe(120)
    expect(dropped.map((d) => d.key)).not.toContain('prime_tower_max_speed')
    const report = projectReport('tower.3mf', { prime_tower_max_speed: '50', layer_height: '0.2' })
    expect(JSON.stringify(report)).not.toMatch(/prime_tower_max_speed[^}]*unsupported/)
  })
})
