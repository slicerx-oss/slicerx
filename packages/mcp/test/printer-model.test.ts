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

  it('leaves a printer SlicerX has no profile of by that name as the knowledge base has it', async () => {
    // "Original Prusa MK4S" names no profile ("Prusa Research MK4S"), so nothing is taken from one.
    expect(await resolved('prusa_mk4s')).toMatchObject({ printer_model: '', extruder_clearance_radius: 40 })
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
