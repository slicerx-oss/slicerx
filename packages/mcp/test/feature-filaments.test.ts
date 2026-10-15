// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client puts a feature on a filament of its own (here the sparse infill on filament 2), slices, and reads back which
// filament each object's walls, infill and surfaces printed with: from slicerx_slice over MCP, from slicerx_slice_file,
// and from a shell with `slicerx-mcp call`. The engine reports what its sliced paths printed with, so this needs the
// real sx engine. Nothing here sends anything to a printer.
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

type Features = Record<string, number[]>
type Plate = { plate: number; featureFilaments?: { object: string; engineObject?: string; name: string; features: Features }[] }

describe.skipIf(noSx())('feature filaments read back', () => {
  it("reports each feature of each project object with its filament after the project's and the object's settings", async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.call('slicerx_project_open', { filament: 'pla' })
    for (let i = 0; i < 2; i++) expect((await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })).isError).toBeFalsy()
    expect((await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#ffffff' })).isError).toBeFalsy()
    const set = await h.call('slicerx_project_set_overrides', { changes: { sparse_infill_filament_id: 2 } })
    expect(set.isError, text(set)).toBeFalsy()
    const own = await h.call('slicerx_project_object_settings', { object: 'obj-2', set: { outer_wall_filament_id: 2, sparse_infill_filament_id: 1 } })
    expect(own.isError, text(own)).toBeFalsy()
    const sliced = await h.call('slicerx_slice')
    expect(sliced.isError, text(sliced)).toBeFalsy()
    const objects = data<{ output: { plates: Plate[] } }>(sliced).output.plates[0]!.featureFilaments!
    // Each copy on the plate is an entry: object obj-1's first copy is obj-1-1.
    expect(objects.map((o) => o.object)).toEqual(['obj-1-1', 'obj-2-1'])
    expect(objects.map((o) => o.engineObject)).toEqual(['o0', 'o1'])
    const [a, b] = objects.map((o) => o.features)
    // The project's setting: sparse infill on filament 2, and (on a printer that isn't a Bambu Lab one) the solid
    // infill and surfaces with it. The walls stay on the object's own filament.
    expect(a).toMatchObject({ outerWall: [1], innerWall: [1], sparseInfill: [2], internalSolid: [2], topSurface: [2], bottomSurface: [2] })
    // The second object's own settings win for that object only.
    expect(b).toMatchObject({ outerWall: [2], innerWall: [1], sparseInfill: [1] })
  }, sxTimeout)

  it('reports them from slicerx_slice_file too', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), filaments: [{ slot: 2, color: '#00ff00' }], overrides: { sparse_infill_filament_id: 2 } })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ feature_filaments?: { object?: string; name: string; features: Features }[] }>(r).feature_filaments!
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('cube.stl')
    expect(out[0]!.features['sparseInfill']).toEqual([2])
    expect(out[0]!.features['outerWall']).toEqual([1])
  }, sxTimeout)

  it('reports them from a shell', async () => {
    const run = promisify(execFile)
    const h = await connect()
    const { stdout } = await run(
      process.execPath,
      [
        '--import', 'tsx', 'src/cli.ts', '--engine', 'sx', '--sx-bin', sxBin, '--printers', 'off', '--allow-dir', h.dir, '--out-dir', join(h.dir, 'out'), '--profiles-dir', join(h.dir, 'profiles'),
        'call', 'project_open', '{"printer":"bambu_p1s","filament":"pla"}', 'project_add_model', JSON.stringify({ model: join(h.dir, 'cube.stl') }),
        'project_add_filament', '{"type":"PLA","color":"#ffffff"}', 'project_set_overrides', '{"changes":{"sparse_infill_filament_id":2}}', 'slice',
      ],
      { cwd: resolve(__dirname, '..') },
    )
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; output: { output?: { plates?: Plate[] } } | null })
    const last = lines.at(-1)!
    expect(last).toMatchObject({ tool: 'slicerx_slice', ok: true })
    expect(last.output?.output?.plates?.[0]?.featureFilaments?.[0]?.features['sparseInfill']).toEqual([2])
  }, sxTimeout)
})
