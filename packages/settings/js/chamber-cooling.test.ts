// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// chamber_cooling_mode, the chamber airflow the Snapmaker U1's Top Cover start G-code reads: a printer setting from 0 to 2
// with no default, so the slice picks it from the filaments unless a preset, a project or a client sets it.
import { describe, expect, it } from 'vitest'
import { checkValues } from './validate'
import { defaultConfig, settingDef } from './schema'
import { defaultConfig as smallDefaults } from './defaults'
import { diffConfigs } from './diff'
import { importFlat, exportOrcaProfile } from './import'
import { importPresetFiles } from './presetfile'
import { importProject } from './project'

const KEY = 'chamber_cooling_mode'
const machine = (extra: Record<string, unknown>) => ({ type: 'machine', name: 'My U1 Top Cover', from: 'User', printer_technology: 'FFF', nozzle_diameter: ['0.4'], ...extra })

describe('chamber_cooling_mode', () => {
  it('is a printer setting from 0 to 2, never in a default config', () => {
    expect(settingDef(KEY)).toMatchObject({ section: 'printer', type: 'int', min: 0, max: 2, mode: 'hidden', invalidates: 'gcode' })
    expect(settingDef(KEY)).not.toHaveProperty('default')
    expect(defaultConfig()).not.toHaveProperty(KEY)
    expect(defaultConfig('printer')).not.toHaveProperty(KEY)
    expect(smallDefaults('printer')).not.toHaveProperty(KEY)
  })

  it("survives a printer preset file's import, as a number", async () => {
    for (const raw of ['0', 0, ['2']]) {
      const [p] = await importPresetFiles([{ path: 'My U1 Top Cover.json', kind: 'printer', json: machine({ [KEY]: raw }) }])
      expect(p?.kind).toBe('printer')
      expect(p?.values[KEY], JSON.stringify(raw)).toBe(Array.isArray(raw) ? 2 : 0)
      expect(p?.report.items.map((i) => i.key)).not.toContain(KEY)
    }
  })

  it('is not set by a printer preset that does not name it', async () => {
    const [p] = await importPresetFiles([{ path: 'My U1.json', kind: 'printer', json: machine({}) }])
    expect(p?.values).not.toHaveProperty(KEY)
  })

  it('says the slice works it out again once a change to it is undone', () => {
    const [d] = diffConfigs({ [KEY]: 0 } as never, {} as never)
    expect(d).toMatchObject({ key: KEY, kind: 'removed', stage: 'gcode', reason: 'Chamber cooling mode is no longer set; it is worked out when slicing.' })
  })

  it('goes back out in a preset Orca can open', () => {
    expect(exportOrcaProfile({ [KEY]: 0 } as never, { name: 'My U1', section: 'printer' })[KEY]).toBe('0')
  })

  it("is read from a project's settings as a setting", () => {
    const p = importProject({ projectSettings: { [KEY]: '0', layer_height: '0.2' } })
    expect(p.config[KEY]).toBe(0)
  })

  it('refuses values outside 0 to 2 and text, as other whole number settings do', () => {
    const codes = (v: unknown) => checkValues({ [KEY]: v } as never).filter((i) => i.severity === 'error').map((i) => i.code)
    for (const ok of [0, 1, 2]) expect(codes(ok), String(ok)).toEqual([])
    expect(codes(3)).toEqual(['out_of_range'])
    expect(codes(-1)).toEqual(['out_of_range'])
    expect(codes('strong')).toEqual(['wrong_type'])
    expect(checkValues({ [KEY]: 3 } as never)[0]?.message).toBe('Chamber cooling mode is 3, outside 0 to 2.')
    // The same as another printer whole number with a range.
    expect(checkValues({ part_cooling_fan_min_pwm: 101 } as never).map((i) => i.code)).toEqual(['out_of_range'])
    expect(checkValues({ part_cooling_fan_min_pwm: 'x' } as never).map((i) => i.code)).toEqual(['wrong_type'])
  })

  it('drops text from a file, keeps a number for validation to judge', () => {
    expect(importFlat({ [KEY]: 'strong' })).toMatchObject({ config: {}, invalidKeys: [KEY] })
    expect(importFlat({ [KEY]: '3' }).config[KEY]).toBe(3)
    expect(importFlat({ part_cooling_fan_min_pwm: '101' }).config['part_cooling_fan_min_pwm']).toBe(101)
  })
})
