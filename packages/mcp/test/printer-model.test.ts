// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project opened on a printer from the knowledge base ("Bambu Lab A1") carries the printer's model and clearances
// from SlicerX's own profile of that printer, as a project on the profile itself (machine:bambu-a1) does. The
// by-object rules read them: a Bambu Lab printer is held to its max radius (73 mm on the A1), the gantry to its rod.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxStl, connect, data, noSx, sxBin, type Harness } from './helpers'

const KEYS = ['printer_model', 'extruder_clearance_radius', 'extruder_clearance_max_radius', 'extruder_clearance_height_to_rod', 'extruder_clearance_height_to_lid', 'extruder_clearance_dist_to_rod', 'nozzle_height'] as const

/** The settings a project opened on `printer` slices with, the printer's model and clearances only. */
async function resolved(printer: string): Promise<Record<string, unknown>> {
  const { McpProject } = await import('../src/project')
  const { ProfileCatalog } = await import('../src/profiles')
  const { DataStore, resolveDataPaths } = await import('../src/data')
  const { createNodeSlicerHost } = await import('../src/slicerhost')
  const { createStubSlicer } = await import('../src/slicer')
  const store = new DataStore(resolveDataPaths())
  const project = new McpProject({ name: 'Printer', profiles: [], printer }, store, new ProfileCatalog(store), createNodeSlicerHost(createStubSlicer(), `/tmp/slicerx-mcp-test-printer-${printer}`))
  const cfg = project.config(1) as unknown as Record<string, unknown>
  return Object.fromEntries(KEYS.map((k) => [k, cfg[k]]))
}

describe('a project on a printer from the knowledge base', () => {
  it('carries the model and clearances of SlicerX\'s profile of that printer', async () => {
    expect(await resolved('bambu_a1')).toMatchObject({ printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73, extruder_clearance_height_to_rod: 25, extruder_clearance_dist_to_rod: 56.5, extruder_clearance_height_to_lid: 256 })
    expect(await resolved('bambu_a1_mini')).toMatchObject({ printer_model: 'Bambu Lab A1 mini', extruder_clearance_max_radius: 73 })
    expect(await resolved('bambu_p1s')).toMatchObject({ printer_model: 'Bambu Lab P1S', extruder_clearance_max_radius: 68, extruder_clearance_height_to_rod: 34 })
    expect(await resolved('bambu_x1c')).toMatchObject({ printer_model: 'Bambu Lab X1 Carbon', extruder_clearance_max_radius: 68 })
  })

  it('carries them for a printer the knowledge base names its own way', async () => {
    // "Original Prusa MK4S" is SlicerX's "Prusa Research MK4S" (printer-models.json links them); the values are its profile's.
    const { printerConfig } = await import('@slicerx/settings')
    const own = printerConfig('prusa-mk4s') as unknown as Record<string, unknown>
    const mk4s = { printer_model: 'Prusa Research MK4S', extruder_clearance_radius: 45, extruder_clearance_height_to_rod: 14, extruder_clearance_height_to_lid: 220 }
    expect(own).toMatchObject(mk4s)
    expect(await resolved('prusa_mk4s')).toMatchObject(mk4s)
  })

  it('takes the same profile as before for a printer the knowledge base names as SlicerX does', async () => {
    const { printerConfig } = await import('@slicerx/settings')
    for (const [printer, machine] of [['bambu_a1', 'bambu-a1'], ['bambu_a1_mini', 'bambu-a1-mini'], ['bambu_p1s', 'bambu-p1s'], ['bambu_x1c', 'bambu-x1-carbon'], ['creality_k1_max', 'creality-k1-max']]) {
      const own = printerConfig(machine!) as unknown as Record<string, unknown>
      expect(await resolved(printer!), printer).toMatchObject(Object.fromEntries(KEYS.filter((k) => own[k] !== undefined).map((k) => [k, own[k]])))
    }
    expect(await resolved('creality_k1_max')).toMatchObject({ printer_model: 'Creality K1 Max', extruder_clearance_radius: 65 })
  })

  it('leaves a printer SlicerX has no profile of as the knowledge base has it', async () => {
    // SlicerX has no A2L profile.
    expect(await resolved('bambu_a2l')).toMatchObject({ printer_model: '', extruder_clearance_radius: 40 })
  })

  it('slices the printers linked by another name from the generic process and supports, with their own clearances', async () => {
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { ProfileCatalog } = await import('../src/profiles')
    const { resolveSliceConfig } = await import('../src/config')
    const { printerConfig } = await import('@slicerx/settings')
    const store = new DataStore(resolveDataPaths())
    const catalog = new ProfileCatalog(store)
    for (const [printer, machine] of [['prusa_mk4s', 'prusa-mk4s'], ['prusa_xl', 'prusa-xl'], ['prusa_core_one', 'prusa-core-one'], ['voron_2_4', 'voron-2.4-300'], ['voron_trident', 'voron-trident-300']] as const) {
      // The process and supports a slice starts from stay the ones a printer with no profile of its name gets.
      expect(catalog.printerModel(`printer:${printer}`), printer).toBeUndefined()
      const names = [`printer:${printer}`]
      await catalog.prepare(names)
      const { config } = resolveSliceConfig(store, catalog, names, undefined)
      expect(config, printer).toMatchObject({ enable_support: true, support_on_build_plate_only: true, support_threshold_angle: 25, support_type: 'tree(auto)', internal_solid_infill_speed: [100], overhang_4_4_speed: ['0'] })
      // The model and clearances still come from the machine's own profile.
      const own = printerConfig(machine) as unknown as Record<string, unknown>
      expect(config, printer).toMatchObject({ printer_model: own['printer_model'], extruder_clearance_radius: own['extruder_clearance_radius'], extruder_clearance_height_to_rod: own['extruder_clearance_height_to_rod'], extruder_clearance_height_to_lid: own['extruder_clearance_height_to_lid'] })
    }
  })

  it('links every knowledge printer to the one profile of the same machine', async () => {
    const { DataStore, resolveDataPaths } = await import('../src/data')
    const { printerProfileFor } = await import('../src/settings')
    const store = new DataStore(resolveDataPaths())
    const printers = store.knowledge().filter((e) => e.kind === 'printer').sort((a, b) => a.id.localeCompare(b.id))
    expect(Object.fromEntries(printers.map((e) => [e.id, printerProfileFor(e) ?? null]))).toEqual({
      bambu_a1: 'bambu-a1',
      bambu_a1_mini: 'bambu-a1-mini',
      bambu_a2l: null,
      bambu_h2c: 'bambu-h2c',
      bambu_h2d: 'bambu-h2d',
      bambu_h2s: 'bambu-h2s',
      bambu_p1p: 'bambu-p1p',
      bambu_p1s: 'bambu-p1s',
      bambu_p2s: 'bambu-p2s',
      bambu_x1c: 'bambu-x1-carbon',
      bambu_x1e: 'bambu-x1e',
      bambu_x2d: 'bambu-x2d',
      creality_k1_max: 'creality-k1-max',
      creality_k2_plus: 'creality-k2-plus',
      elegoo_centauri_carbon: 'elegoo-centauri-carbon',
      elegoo_neptune_4_pro: 'elegoo-neptune-4-pro',
      flsun_v400: 'flsun-v400',
      // Linked by printer-models.json: the names differ ("Prusa CORE One", "Original Prusa XL", "Voron 2.4").
      prusa_core_one: 'prusa-core-one',
      prusa_mk4s: 'prusa-mk4s',
      // The single toolhead XL: the 5 toolhead one shares the knowledge entry and the bed.
      prusa_xl: 'prusa-xl',
      sovol_sv08: 'sovol-sv08',
      // The knowledge files model the 300 mm kits, the only ones of the three with their bed.
      voron_2_4: 'voron-2.4-300',
      voron_trident: 'voron-trident-300',
    })
  })
})

/** An A1 project from the knowledge base, two 20 mm boxes 50 mm apart, printed by object. */
async function twoOnA1(h: Harness): Promise<void> {
  writeFileSync(join(h.dir, 'a.stl'), boxStl(20, 20, 10))
  writeFileSync(join(h.dir, 'b.stl'), boxStl(20, 20, 10))
  for (const [name, args] of [
    ['slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' }],
    ['slicerx_project_add_model', { model: join(h.dir, 'a.stl') }],
    ['slicerx_project_add_model', { model: join(h.dir, 'b.stl') }],
    ['slicerx_project_move', { object: 'obj-1', x: 110, y: 128 }],
    ['slicerx_project_move', { object: 'obj-2', x: 180, y: 128 }],
    ['slicerx_project_set_overrides', { changes: { print_sequence: 'by object', skirt_loops: 0, brim_type: 'no_brim' } }],
  ] as const) {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${JSON.stringify(data(r)).slice(0, 300)}`).not.toBe(true)
  }
}

describe.skipIf(noSx())('an A1 project from the knowledge base sliced with sx', () => {
  it('holds two objects 50 mm apart to the A1\'s 73 mm radius by object', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      await twoOnA1(h)
      const r = await h.call('slicerx_slice')
      expect(r.isError).toBe(true)
      const e = data<{ error: { code: string; message: string } }>(r).error
      expect(e.code).toBe('sequence_clearance')
      expect(e.message).toMatch(/inside the 73 mm the printer profile asks for/)
    } finally {
      await h.client.close()
    }
  }, 240_000)
})
