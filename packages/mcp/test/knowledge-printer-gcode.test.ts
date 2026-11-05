// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A knowledge printer named other than SlicerX's profile of the machine ("Original Prusa MK4S" is prusa-mk4s) prints
// with the G-code SlicerX ships for that machine, as `machine:<id>` and the app do, not the schema's bare start script.
import { describe, expect, it } from 'vitest'
import { printerConfig } from '@slicerx/settings'
import { resolveSliceConfig } from '../src/config'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { defaultConfig } from '../src/settings'

const LINKED = [
  ['prusa_mk4s', 'prusa-mk4s'],
  ['prusa_xl', 'prusa-xl'],
  ['prusa_core_one', 'prusa-core-one'],
  ['voron_2_4', 'voron-2.4-300'],
  ['voron_trident', 'voron-trident-300'],
] as const

const GCODE = ['machine_start_gcode', 'machine_end_gcode', 'layer_change_gcode', 'change_filament_gcode'] as const

describe('the G-code of a knowledge printer linked to a profile of another name', () => {
  it("is the machine's own G-code as SlicerX ships it", async () => {
    const store = new DataStore(resolveDataPaths())
    const catalog = new ProfileCatalog(store)
    for (const [printer, machine] of LINKED) {
      await catalog.prepare([`printer:${printer}`, `machine:${machine}`])
      const own = printerConfig(machine) as unknown as Record<string, unknown>
      const knowledge = catalog.get(`printer:${printer}`)!
      expect(knowledge.shippedGcode, printer).toBe(true)
      expect(String(own['machine_start_gcode'] ?? '').length, `${machine} ships a start script`).toBeGreaterThan(0)
      for (const key of GCODE) expect(knowledge.config[key], `${printer} ${key}`).toEqual(own[key])
      // A slice of it sends the same start script as a slice of the machine, and trusts it as shipped text.
      const slice = resolveSliceConfig(store, catalog, [`printer:${printer}`], undefined)
      const app = resolveSliceConfig(store, catalog, [`machine:${machine}`], undefined)
      expect(slice.config['machine_start_gcode'], printer).toEqual(app.config['machine_start_gcode'])
      expect(slice.config['machine_start_gcode'], printer).not.toEqual(defaultConfig(store)['machine_start_gcode'])
      expect(slice.trustedGcode, printer).toBe(true)
    }
  })

  it('stays the schema G-code for a printer SlicerX has no profile of', async () => {
    const store = new DataStore(resolveDataPaths())
    const catalog = new ProfileCatalog(store)
    await catalog.prepare(['printer:bambu_a2l'])
    const a2l = catalog.get('printer:bambu_a2l')!
    expect(a2l.shippedGcode).toBeUndefined()
    expect(Object.keys(a2l.config).filter((k) => k.endsWith('_gcode'))).toEqual([])
    const slice = resolveSliceConfig(store, catalog, ['printer:bambu_a2l'], undefined)
    for (const key of GCODE) expect(slice.config[key], key).toEqual(defaultConfig(store)[key])
  })
})
