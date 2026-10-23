// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The floating vertical shell settings (`detect_floating_vertical_shell`, `vertical_shell_speed`) reach the engine
// from a project file and from an imported profile, instead of being dropped as keys from another slicer.
import { describe, expect, it } from 'vitest'
import { settingDef } from './schema'
import { importProject } from './project'
import { importValues, projectReport } from './report'

const narrowOn = [{ key: 'detect_narrow_internal_solid_infill', op: 'eq', value: true }]

describe('floating vertical shell settings', () => {
  it('are process settings with their defaults, used while narrow internal solid infill is detected', () => {
    expect(settingDef('detect_floating_vertical_shell')).toMatchObject({ section: 'process', type: 'bool', label: 'Detect floating vertical shells', default: true, group: 'strength', enabledWhen: narrowOn })
    expect(settingDef('vertical_shell_speed')).toMatchObject({ section: 'process', type: 'floatsOrPercents', label: 'Floating vertical shell speed', unit: 'mm/s', default: ['80%'], group: 'speed', enabledWhen: narrowOn })
  })

  it("are read from a project's settings", () => {
    const imported = importProject({ projectSettings: { detect_floating_vertical_shell: '0', vertical_shell_speed: ['60%'], layer_height: '0.2' } })
    expect(imported.config['detect_floating_vertical_shell' as keyof typeof imported.config]).toBe(false)
    expect(imported.config['vertical_shell_speed' as keyof typeof imported.config]).toEqual(['60%'])
    expect(imported.unknownKeys).not.toContain('detect_floating_vertical_shell')
    expect(imported.unknownKeys).not.toContain('vertical_shell_speed')
  })

  it('are kept from an imported profile and not reported as unsupported', () => {
    const { config, dropped } = importValues({ detect_floating_vertical_shell: '1', vertical_shell_speed: ['150'] })
    expect(config['detect_floating_vertical_shell' as keyof typeof config]).toBe(true)
    expect(config['vertical_shell_speed' as keyof typeof config]).toEqual(['150'])
    expect(dropped.map((d) => d.key)).not.toContain('vertical_shell_speed')
    const report = projectReport('shell.3mf', { detect_floating_vertical_shell: '1', vertical_shell_speed: ['80%'], layer_height: '0.2' })
    expect(JSON.stringify(report)).not.toMatch(/(detect_floating_vertical_shell|vertical_shell_speed)[^}]*unsupported/)
  })
})
