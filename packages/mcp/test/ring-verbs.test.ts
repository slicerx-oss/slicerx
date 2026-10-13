// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The model ring's verbs over MCP, as a client does them: duplicate, rename and lay on a face, each read back from
// slicerx_project_show, and with the real engine the request it sliced.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downRotation } from '../src/placement'
import { boxStl, connect, data, noSx, noSxGeom, sxBin, sxTimeout, type Harness } from './helpers'

type Obj = { id: string; name: string; bbox_mm: number[]; plates: number[]; rotate: number[]; scale: number[]; position: number[] | null; settings: Record<string, unknown>; volumes: { id: string; role: string }[] }
type Project = { objects: Obj[]; plates: { index: number; items: { objectId: string; copies: number }[]; placements: { id: string; centerMm: number[] }[] }[]; height_ranges: { objects?: string[] }[] }
type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }

async function call<T = { project: Project }>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError } as Res<T>
}
const show = async (h: Harness): Promise<Project> => (await call<Project>(h, 'slicerx_project_show')).output

/** A project with one 30 x 20 x 10 mm block, so each face it lies on gives a different height. */
async function project(opts: Parameters<typeof connect>[0] = {}): Promise<Harness> {
  const h = await connect(opts)
  writeFileSync(join(h.dir, 'block.stl'), boxStl(30, 20, 10))
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'block.stl') })
  return h
}

function lastRequest(h: Harness): { plate: { objects: { id: string; transform: number[]; settings?: Record<string, unknown> }[] } } {
  const dir = join(h.dir, 'out', 'plates')
  const newest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? ''
  return JSON.parse(readFileSync(join(newest, 'request.json'), 'utf8'))
}

describe('the face a normal lays an object on', () => {
  it('turns that face straight down, about X then Y', () => {
    expect(downRotation([0, 0, -1])).toEqual([0, 0, 0])
    expect(downRotation([0, 0, 1])).toEqual([180, 0, 0])
    expect(downRotation([1, 0, 0])).toEqual([0, 90, 0])
    expect(downRotation([-1, 0, 0])).toEqual([0, -90, 0])
    expect(downRotation([0, 1, 0])).toEqual([-90, 0, 0])
    expect(downRotation([0, -1, 0])).toEqual([90, 0, 0])
    // A face scaled flatter points more along the axis that grew.
    expect(downRotation([1, 0, -1], [1, 1, 1])[1]).toBeCloseTo(45, 6)
    expect(downRotation([1, 0, -1], [2, 1, 1])[1]).toBeCloseTo((Math.atan2(0.5, 1) * 180) / Math.PI, 6)
    expect(() => downRotation([0, 0, 0])).toThrow(/no direction/)
  })
})

describe('the model ring verbs', () => {
  it('duplicates an object as new objects with its rotation, scale, settings and volumes', async () => {
    const h = await project()
    await call(h, 'slicerx_project_rotate', { object: 'obj-1', rotate: [0, 0, 90] })
    await call(h, 'slicerx_project_scale', { object: 'obj-1', scale: 2 })
    await call(h, 'slicerx_project_object_settings', { object: 'obj-1', set: { wall_loops: 4 } })
    await call(h, 'slicerx_project_add_volume', { object: 'obj-1', role: 'negative', shape: { box: [4, 4, 30] } })
    await call(h, 'slicerx_project_height_ranges', { ranges: [{ z_from_mm: 2, z_to_mm: 4, settings: { nozzle_temperature: 230 }, objects: ['obj-1'] }] })
    await call(h, 'slicerx_project_move', { object: 'obj-1', x: 80, y: 80 })

    const dup = await call<{ objects: string[]; project: Project }>(h, 'slicerx_project_duplicate', { object: 'obj-1', count: 2 })
    expect(dup.ok).toBe(true)
    expect(dup.output.objects).toEqual(['obj-2', 'obj-3'])
    const p = await show(h)
    expect(p.objects.map((o) => o.id)).toEqual(['obj-1', 'obj-2', 'obj-3'])
    const [src, a, b] = p.objects
    for (const c of [a, b]) {
      expect(c).toMatchObject({ name: src?.name, rotate: [0, 0, 90], scale: [2, 2, 2], settings: { wall_loops: 4 }, plates: [1], position: null })
      expect(c?.bbox_mm).toEqual(src?.bbox_mm)
      expect(c?.volumes.map((v) => v.role)).toEqual(['negative'])
    }
    // Each copy's volume is its own.
    expect(new Set(p.objects.flatMap((o) => o.volumes.map((v) => v.id))).size).toBe(3)
    expect(p.plates[0]?.items).toEqual([
      { objectId: 'obj-1', copies: 1 },
      { objectId: 'obj-2', copies: 1 },
      { objectId: 'obj-3', copies: 1 },
    ])
    expect(p.height_ranges[0]?.objects).toEqual(['obj-1', 'obj-2', 'obj-3'])

    // A copy moves on its own.
    await call(h, 'slicerx_project_move', { object: 'obj-2', x: 150, y: 150 })
    expect((await show(h)).objects.map((o) => o.position)).toEqual([[80, 80], [150, 150], null])

    const missing = await call(h, 'slicerx_project_duplicate', { object: 'obj-9' })
    expect(missing.ok).toBe(false)
    expect(missing.error?.message).toMatch(/slicerx_project_show/)
  })

  it('renames an object, which keeps its id, and refuses a name that reads as an id', async () => {
    const h = await project()
    const renamed = await call(h, 'slicerx_project_rename', { object: 'block.stl', name: '  Bracket left ' })
    expect(renamed.ok).toBe(true)
    expect(renamed.output.project.objects[0]).toMatchObject({ id: 'obj-1', name: 'Bracket left' })
    // The new name finds it, as an id does.
    await call(h, 'slicerx_project_scale', { object: 'Bracket left', scale: 0.5 })
    expect((await show(h)).objects[0]?.scale).toEqual([0.5, 0.5, 0.5])

    const asId = await call(h, 'slicerx_project_rename', { object: 'obj-1', name: 'obj-7' })
    expect(asId.ok).toBe(false)
    expect(asId.error?.message).toMatch(/reads as an object id/)
    const blank = await call(h, 'slicerx_project_rename', { object: 'obj-1', name: '   ' })
    expect(blank.ok).toBe(false)
    expect((await show(h)).objects[0]?.name).toBe('Bracket left')
  })

  it('lays an object on a face by its normal and reads back the rotation and size', async () => {
    const h = await project()
    const side = await call<{ rotate: number[]; project: Project }>(h, 'slicerx_project_lay_on_face', { object: 'obj-1', normal: [1, 0, 0] })
    expect(side.ok).toBe(true)
    expect(side.output.rotate).toEqual([0, 90, 0])
    // On its 20 x 10 mm end, the 30 mm length stands up.
    expect(side.output.project.objects[0]?.bbox_mm.map(Math.round)).toEqual([10, 20, 30])

    await call(h, 'slicerx_project_lay_on_face', { object: 'obj-1', normal: [0, -1, 0] })
    const front = (await show(h)).objects[0]
    expect(front?.rotate).toEqual([90, 0, 0])
    expect(front?.bbox_mm.map(Math.round)).toEqual([30, 10, 20])

    const none = await call(h, 'slicerx_project_lay_on_face', { object: 'obj-1', normal: [0, 0, 0] })
    expect(none.ok).toBe(false)
    expect((await show(h)).objects[0]?.rotate).toEqual([90, 0, 0])
  })

  it.skipIf(noSx() || noSxGeom())(
    'with the real engine: a face from slicerx_geom_faces, then the duplicate, rename and lay slice as read back',
    async () => {
      const h = await project({ engine: 'sx', sxBin })
      // The client finds the block's +x end the way it would: from the model's flat faces.
      const faces = await call<{ faces: { facing?: string; normal: number[] }[] }>(h, 'slicerx_geom_faces', { model: join(h.dir, 'block.stl') })
      expect(faces.ok, faces.error?.message).toBe(true)
      const end = faces.output.faces.find((f) => f.facing === '+x')
      expect(end).toBeDefined()

      await call(h, 'slicerx_project_object_settings', { object: 'obj-1', set: { wall_loops: 3 } })
      const dup = await call<{ objects: string[] }>(h, 'slicerx_project_duplicate', { object: 'obj-1' })
      expect(dup.output.objects).toEqual(['obj-2'])
      await call(h, 'slicerx_project_rename', { object: 'obj-2', name: 'Upright' })
      const laid = await call<{ rotate: number[]; project: Project }>(h, 'slicerx_project_lay_on_face', { object: 'Upright', normal: end!.normal })
      expect(laid.output.rotate.map((v) => Math.round(v))).toEqual([0, 90, 0])

      const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
      expect(sliced.ok, sliced.error?.message).toBe(true)
      const objs = lastRequest(h).plate.objects
      expect(objs).toHaveLength(2)
      // Both carry the source's settings; the laid copy's transform turns X up: its third column (Z) is along X.
      for (const o of objs) expect(o.settings).toEqual({ wall_loops: 3 })
      const upright = objs.find((o) => Math.abs(o.transform[2] ?? 0) > 0.5)
      expect(upright, JSON.stringify(objs.map((o) => o.transform))).toBeDefined()
      const flat = objs.find((o) => o !== upright)
      expect(flat?.transform.slice(0, 3).map((v) => Math.round(v))).toEqual([1, 0, 0])
      expect(sliced.output.total.grams).toBeGreaterThan(0)

      const p = await show(h)
      expect(p.objects.map((o) => [o.id, o.name, o.bbox_mm.map(Math.round)])).toEqual([
        ['obj-1', 'block.stl', [30, 20, 10]],
        ['obj-2', 'Upright', [10, 20, 30]],
      ])
    },
    sxTimeout,
  )
})
