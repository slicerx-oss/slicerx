// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower line width (`prime_tower_line_width`) and the first layer's infill width
// (`initial_layer_infill_line_width`) reach the engine from a project file, an imported profile and the stock H3C
// presets, instead of being dropped as keys from another slicer. Neither has a default, so a printer whose presets
// leave them out slices as before.
import { describe, expect, it } from 'vitest'
import { defaultConfig, settingDef } from './schema'
import { importProject } from './project'
import { importValues } from './report'
import { resolvedProfile } from './resolved'

const KEYS = ['prime_tower_line_width', 'initial_layer_infill_line_width'] as const

describe('the prime tower and first layer infill line widths', () => {
  it('are process settings in mm with no default', () => {
    expect(settingDef('prime_tower_line_width')).toMatchObject({ section: 'process', type: 'float', label: 'Prime tower line width', unit: 'mm', group: 'multimaterial' })
    expect(settingDef('initial_layer_infill_line_width')).toMatchObject({ section: 'process', type: 'float', label: 'Infill line width on the first layer', unit: 'mm', group: 'quality' })
    for (const k of KEYS) {
      expect(settingDef(k)?.default, k).toBeUndefined()
      expect(defaultConfig()[k], k).toBeUndefined()
    }
  })

  it("are read from a project's settings", () => {
    const imported = importProject({ projectSettings: { prime_tower_line_width: '0.8', initial_layer_infill_line_width: '0.6', layer_height: '0.2' } })
    expect(imported.config['prime_tower_line_width' as keyof typeof imported.config]).toBe(0.8)
    expect(imported.config['initial_layer_infill_line_width' as keyof typeof imported.config]).toBe(0.6)
    for (const k of KEYS) expect(imported.unknownKeys).not.toContain(k)
  })

  it('are kept from an imported profile', () => {
    const { config, dropped } = importValues({ prime_tower_line_width: '0.6', initial_layer_infill_line_width: '0.25' })
    expect(config['prime_tower_line_width' as keyof typeof config]).toBe(0.6)
    expect(config['initial_layer_infill_line_width' as keyof typeof config]).toBe(0.25)
    for (const k of KEYS) expect(dropped.map((d) => d.key)).not.toContain(k)
  })

  it("come with the H3C's stock presets on every nozzle", async () => {
    for (const [n, tower, infill] of [[0.2, 0.6, 0.25], [0.4, 0.8, 0.6], [0.6, 0.8, 0.62], [0.8, 0.8, 0.82]] as const) {
      const r = await resolvedProfile('bambu-h3c', 'standard', n)
      expect(r!.process['prime_tower_line_width'], String(n)).toBe(tower)
      expect(r!.process['initial_layer_infill_line_width'], String(n)).toBe(infill)
    }
    // The maker's 0.4 mm Extra Fine preset sets no tower line width, so its tower keeps the wall's bead.
    expect((await resolvedProfile('bambu-h3c', 'extra_fine', 0.4))!.process['prime_tower_line_width']).toBeUndefined()
  })

  it('stay unset on the stock presets of the other Bambu Lab printers', async () => {
    for (const model of ['bambu-x1-carbon', 'bambu-p1s', 'bambu-a1', 'bambu-h2d']) {
      const r = await resolvedProfile(model, 'standard')
      for (const k of KEYS) expect(r!.process[k], `${model} ${k}`).toBeUndefined()
    }
  })
})
