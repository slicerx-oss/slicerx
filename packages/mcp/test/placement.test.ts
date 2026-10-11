// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Placement and per-object control over MCP, as a client does it: each change, then the project read back, and
// with the real engine the request it sliced and what the G-code shows.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, type Harness } from './helpers'

type Placement = { id: string; objectId: string; copy: number; centerMm: [number, number]; sizeMm: [number, number, number]; manual: boolean }
type Obj = { id: string; bbox_mm: number[]; plates: number[]; rotate: number[]; scale: number[]; position: number[] | null; settings: Record<string, unknown>; volumes: { id: string; role: string; shape: string; settings?: Record<string, unknown> }[]; model_bounds: { min: number[]; max: number[] } }
type Project = { objects: Obj[]; plates: { index: number; items: { objectId: string; copies: number }[]; placements: Placement[] }[]; height_ranges: { zFromMm: number; zToMm: number; settings: Record<string, unknown>; objects?: string[] }[] }
type Res<T = Record<string, unknown>> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }

async function call<T = { project: Project }>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  // A refused call carries only the error; ok is then false.
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError } as Res<T>
}
const show = async (h: Harness): Promise<Project> => (await call<Project>(h, 'slicerx_project_show')).output

async function project(opts: Parameters<typeof connect>[0] = {}): Promise<Harness> {
  const h = await connect(opts)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
  return h
}

/** The request.json of the newest slice. */
function lastRequest(h: Harness): { plate: { objects: Record<string, unknown>[] }; options: Record<string, unknown> } {
  const dir = join(h.dir, 'out', 'plates')
  const newest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? ''
  return JSON.parse(readFileSync(join(newest, 'request.json'), 'utf8'))
}

describe('placing objects', () => {
  it('moves, rotates and scales an object and reads back where it sits', async () => {
    const h = await project()
    const moved = await call(h, 'slicerx_project_move', { object: 'obj-1', x: 60, y: 70 })
    expect(moved.ok).toBe(true)
    expect(moved.output.project.plates[0]?.placements).toEqual([{ id: 'obj-1-1', objectId: 'obj-1', copy: 1, centerMm: [60, 70], sizeMm: [20, 20, 20], manual: true }])

    const scaled = await call(h, 'slicerx_project_scale', { object: 'cube.stl', scale: [2, 1, 0.5] })
    expect(scaled.output.project.objects[0]).toMatchObject({ bbox_mm: [40, 20, 10], scale: [2, 1, 0.5], position: [60, 70], model_bounds: { min: [0, 0, 0], max: [20, 20, 20] } })

    await call(h, 'slicerx_project_rotate', { object: 'obj-1', rotate: [0, 0, 90] })
    const p = await show(h)
    // Scale first, then the turn about Z: 40 mm along X becomes 40 mm along Y.
    expect(p.objects[0]?.bbox_mm.map(Math.round)).toEqual([20, 40, 10])
    expect(p.plates[0]?.placements[0]?.centerMm).toEqual([60, 70])

    await call(h, 'slicerx_project_move', { object: 'obj-1', auto: true })
    const auto = await show(h)
    expect(auto.objects[0]?.position).toBeNull()
    expect(auto.plates[0]?.placements[0]?.manual).toBe(false)
  })

  it('adds, fills and removes plates', async () => {
    const h = await project()
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 2 })
    const added = await call<{ plate: number; project: Project }>(h, 'slicerx_project_plate_add')
    expect(added.output.plate).toBe(2)
    await call(h, 'slicerx_project_move_to_plate', { object: 'obj-2', plate: 2 })
    let p = await show(h)
    expect(p.plates.map((x) => [x.index, x.items])).toEqual([
      [1, [{ objectId: 'obj-1', copies: 1 }]],
      [2, [{ objectId: 'obj-2', copies: 2 }]],
    ])
    expect(p.plates[1]?.placements.map((x) => x.id)).toEqual(['obj-2-1', 'obj-2-2'])

    const refused = await call(h, 'slicerx_project_plate_remove', { plate: 1 })
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toMatch(/move_to/)
    await call(h, 'slicerx_project_plate_remove', { plate: 1, move_to: 2 })
    p = await show(h)
    // Plate 2 is plate 1 now, and holds both objects.
    expect(p.plates.map((x) => [x.index, x.items.map((i) => i.objectId)])).toEqual([[1, ['obj-2', 'obj-1']]])

    await call(h, 'slicerx_project_remove_object', { object: 'obj-2' })
    expect((await show(h)).objects.map((o) => o.id)).toEqual(['obj-1'])
  })
})

describe('per-object settings, volumes and height ranges', () => {
  it('stores them and reads them back, and refuses what a file may not set', async () => {
    const h = await project()
    const set = await call<{ settings: Record<string, unknown>; project: Project }>(h, 'slicerx_project_object_settings', { object: 'obj-1', set: { wall_loops: 5, sparse_infill_density: '35%' } })
    expect(set.output.settings).toEqual({ wall_loops: 5, sparse_infill_density: 35 })
    await call(h, 'slicerx_project_object_settings', { object: 'obj-1', clear: ['sparse_infill_density'] })
    expect((await show(h)).objects[0]?.settings).toEqual({ wall_loops: 5 })

    const gcode = await call(h, 'slicerx_project_object_settings', { object: 'obj-1', set: { machine_start_gcode: 'M104 S300' } })
    expect(gcode.ok).toBe(false)
    expect(gcode.error?.message).toMatch(/cannot be set per object/)
    expect((await call(h, 'slicerx_project_object_settings', { object: 'obj-1', set: { no_such_key: 1 } })).ok).toBe(false)

    const cut = await call<{ volume: { id: string; shape: string }; project: Project }>(h, 'slicerx_project_add_volume', { object: 'obj-1', role: 'negative', shape: { box: [10, 10, 30] } })
    expect(cut.output.volume).toMatchObject({ id: 'vol-1', shape: 'box 10 x 10 x 30 mm at [10, 10, 10]' })
    const mod = await call<{ volume: { id: string } }>(h, 'slicerx_project_add_volume', { object: 'obj-1', role: 'modifier', shape: { cylinder: { diameter: 6, height: 20 } }, center: [4, 4, 10], settings: { sparse_infill_density: '100%' } })
    expect(mod.ok).toBe(true)
    expect((await call(h, 'slicerx_project_add_volume', { object: 'obj-1', role: 'negative', shape: { box: [1, 1, 1] }, settings: { wall_loops: 2 } })).ok).toBe(false)
    expect((await show(h)).objects[0]?.volumes).toEqual([
      { id: 'vol-1', name: 'negative box', role: 'negative', shape: 'box 10 x 10 x 30 mm at [10, 10, 10]' },
      { id: 'vol-2', name: 'modifier cylinder', role: 'modifier', shape: 'cylinder 6 mm across, 20 mm tall, at [4, 4, 10]', settings: { sparse_infill_density: 100 } },
    ])
    await call(h, 'slicerx_project_remove_volume', { object: 'obj-1', volume: 'vol-2' })
    expect((await show(h)).objects[0]?.volumes.map((v) => v.id)).toEqual(['vol-1'])

    const ranges = await call(h, 'slicerx_project_height_ranges', { ranges: [{ z_from_mm: 10, z_to_mm: 15, settings: { nozzle_temperature: 240 }, objects: ['obj-1'] }] })
    expect(ranges.output.project.height_ranges).toEqual([{ zFromMm: 10, zToMm: 15, settings: { nozzle_temperature: [240] }, objects: ['obj-1'] }])
    const layer = await call(h, 'slicerx_project_height_ranges', { ranges: [{ z_from_mm: 0, z_to_mm: 5, settings: { layer_height: 0.1 } }] })
    expect(layer.ok).toBe(false)
    expect(layer.error?.message).toMatch(/can change only/)
  })

  it.skipIf(noSx())(
    'the slice gets the place, settings, volumes and ranges, and the G-code shows them',
    async () => {
      const h = await project({ engine: 'sx', sxBin })
      const plain = (await call<{ total: { grams: number } }>(h, 'slicerx_slice')).output.total.grams

      await call(h, 'slicerx_project_move', { object: 'obj-1', x: 60, y: 70 })
      await call(h, 'slicerx_project_object_settings', { object: 'obj-1', set: { wall_loops: 2, sparse_infill_density: '100%' } })
      const solid = (await call<{ total: { grams: number } }>(h, 'slicerx_slice')).output.total.grams
      let req = lastRequest(h)
      // 20 mm cube centered at (60, 70): its corner goes to (50, 60).
      expect((req.plate.objects[0]?.['transform'] as number[]).slice(12, 15)).toEqual([50, 60, 0])
      expect(req.plate.objects[0]?.['settings']).toEqual({ wall_loops: 2, sparse_infill_density: 100 })
      expect(solid).toBeGreaterThan(plain)

      await call(h, 'slicerx_project_add_volume', { object: 'obj-1', role: 'negative', shape: { box: [12, 12, 30] } })
      await call(h, 'slicerx_project_height_ranges', { ranges: [{ z_from_mm: 10, z_to_mm: 15, settings: { nozzle_temperature: 245 } }] })
      const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
      expect(sliced.ok).toBe(true)
      req = lastRequest(h)
      expect(req.plate.objects[0]?.['volumes']).toEqual([{ role: 'negative', mesh: 'm0v0', name: 'negative box' }])
      expect(req.options['heightRanges']).toEqual([{ zFromMm: 10, zToMm: 15, settings: { nozzle_temperature: [245] } }])
      // The hole through the middle of the solid cube takes material out.
      expect(sliced.output.total.grams).toBeLessThan(solid)
      const dir = join(h.dir, 'out', 'plates')
      const newest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? ''
      const gcode = readdirSync(newest).find((f) => f.endsWith('.gcode'))
      expect(readFileSync(join(newest, gcode ?? ''), 'utf8')).toMatch(/M104 S245/)
    },
    sxTimeout * 2,
  )
})

describe('placement and the permission policy', () => {
  it('refuses project changes when the policy turns them off, and reading still works', async () => {
    const h = await project({ policy: { classes: { slice: 'off', queue: 'off', start: 'off', profile: 'off' } } })
    expect((await h.call('slicerx_project_move', { object: 'obj-1', x: 50, y: 50 })).isError).toBe(true)
    expect((await show(h)).objects[0]?.position).toBeNull()
  })
})
