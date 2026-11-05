// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a project's open puts over the printer's settings: every process and filament value the file holds, also one
// equal to the current settings, and never its G-code, a printer setting, or an engine choice SlicerX keeps. The keeps
// are empty in engine-choices.json today, so one is put in here to show it stays out.
import { describe, expect, it, vi } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts/settings'
import { defaultConfig } from './schema'

vi.mock('./engine-choices', async (importOriginal) => {
  const real = await importOriginal<typeof import('./engine-choices')>()
  return {
    ...real,
    keptEngineChoices: (s: Record<string, unknown>) => (real.changedKeys(s)?.has('wall_generator') ? [] : ['wall_generator']),
    SLICERX_KEEP_VALUES: { wall_generator: 'aegis' },
  }
})
const { projectPrinterChanges } = await import('./project-open')

const current = defaultConfig() as unknown as PrintConfig
const MATCH = { kind: 'match' as const, profileId: 'bambu-p1s', vendor: 'Bambu Lab', model: 'P1S', nozzle: 0.4, name: 'Bambu Lab P1S 0.4 nozzle' }
const FILE = {
  nozzle_diameter: ['0.4'],
  layer_height: '0.12',
  support_top_z_distance: '0.2',
  wall_generator: 'classic',
  machine_start_gcode: 'G28 ; mine',
  printable_height: '180',
  different_settings_to_system: ['layer_height;machine_start_gcode;printable_height', '', ''],
}

describe("a project's open", () => {
  for (const [route, match] of [['its own printer', MATCH], ['a printer with no profile', { kind: 'unknown' as const, name: 'Workshop Printer' }]] as const) {
    it(`on ${route} takes an unlisted value equal to the current one`, () => {
      const { values, all } = projectPrinterChanges(FILE, match, current, 0.4)
      expect(values['support_top_z_distance']).toBe(0.2)
      expect(all).not.toHaveProperty('support_top_z_distance')
    })

    it(`on ${route} leaves out G-code, printer settings and kept engine choices`, () => {
      // with the current walls on the file's choice, so the kept one has to come from the keep where one is put back
      const { values } = projectPrinterChanges(FILE, match, { ...current, wall_generator: 'classic' } as PrintConfig, 0.4)
      expect(values).not.toHaveProperty('machine_start_gcode')
      expect(values).not.toHaveProperty('printable_height')
      // on its own printer the keep leaves the profile's value; on a printer with no profile SlicerX's is put over it
      if (match.kind === 'match') expect(values).not.toHaveProperty('wall_generator')
      else expect(values['wall_generator']).toBe('aegis')
    })
  }

  it('for another nozzle takes only what the file lists', () => {
    const { values, listed } = projectPrinterChanges(FILE, { ...MATCH, asked: 0.6 }, current, 0.4)
    expect(values['layer_height']).toBe(0.12)
    expect(values).not.toHaveProperty('support_top_z_distance')
    expect(listed).toBe(true)
  })

  it('counts every key as its own when the file lists none', () => {
    const { different_settings_to_system: _list, ...file } = FILE
    const { values, all, listed } = projectPrinterChanges(file, MATCH, current, 0.4)
    expect(values['support_top_z_distance']).toBe(0.2)
    expect(all).not.toHaveProperty('support_top_z_distance')
    expect(listed).toBe(false)
  })

  it('names only real changes as left out for another nozzle', () => {
    const file = { ...FILE, nozzle_diameter: ['0.6'], layer_height: String(current['layer_height']), outer_wall_line_width: '0.62' }
    const { values, dropped } = projectPrinterChanges(file, { kind: 'unknown', name: 'Workshop Printer', nozzle: 0.6 }, current, 0.4)
    expect(dropped).toEqual(['outer_wall_line_width'])
    expect(values).not.toHaveProperty('layer_height')
    expect(values).not.toHaveProperty('outer_wall_line_width')
  })
})
