// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The model ring's verbs over MCP, as a client does them: duplicate, rename, lay on a face, lock, leave out of the
// print, center, and split to objects or parts, each read back from slicerx_project_show, and with the real engine
// the request it sliced. Nothing here sends anything to a printer.
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { downRotation } from '../src/placement'
import { boxStl, connect, data, noSx, noSxGeom, sxBin, sxTimeout, type Harness } from './helpers'

const run = promisify(execFile)

type Obj = { id: string; name: string; bbox_mm: number[]; parts: number; plates: number[]; rotate: number[]; scale: number[]; position: number[] | null; locked: boolean; printable: boolean; settings: Record<string, unknown>; volumes: { id: string; role: string }[] }
type Project = {
  objects: Obj[]
  bed: { widthMm: number; depthMm: number; originMm: number[] }
  plates: { index: number; items: { objectId: string; copies: number }[]; placements: { id: string; centerMm: number[]; printable?: false }[] }[]
  height_ranges: { objects?: string[] }[]
}
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

/** Two separate blocks in one STL: 20 x 10 x 10 mm at the origin, and 10 x 10 x 10 mm from x 30. */
function twoBlocks(): Buffer {
  const a = boxStl(20, 10, 10)
  const b = boxStl(10, 10, 10)
  for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) b.writeFloatLE(b.readFloatLE(84 + t * 50 + 12 + k * 12) + 30, 84 + t * 50 + 12 + k * 12)
  const out = Buffer.concat([a, b.subarray(84)])
  out.writeUInt32LE(24, 80)
  return out
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

describe('the ring verbs under More, and Lock', () => {
  it('locks an object, so the tools that would move it refuse until it is unlocked', async () => {
    const h = await project()
    await call(h, 'slicerx_project_plate_add')
    const locked = await call(h, 'slicerx_project_lock', { object: 'obj-1' })
    expect(locked.ok).toBe(true)
    expect(locked.output.project.objects[0]).toMatchObject({ id: 'obj-1', locked: true })
    const refused = [
      ['slicerx_project_move', { object: 'obj-1', x: 50, y: 50 }],
      ['slicerx_project_rotate', { object: 'obj-1', rotate: [0, 0, 45] }],
      ['slicerx_project_scale', { object: 'obj-1', scale: 2 }],
      ['slicerx_project_lay_on_face', { object: 'obj-1', normal: [1, 0, 0] }],
      ['slicerx_project_center', { object: 'obj-1' }],
      ['slicerx_project_move_to_plate', { object: 'obj-1', plate: 2 }],
      ['slicerx_cut', { objectId: 'obj-1', printerModel: 'A1 mini', mode: 'split', planeZ: 5 }],
    ] as const
    for (const [tool, args] of refused) {
      const r = await call(h, tool, args)
      expect(r.ok, tool).toBe(false)
      expect(r.error?.message ?? r.summary, tool).toMatch(/is locked\. Unlock it first with slicerx_project_lock/)
    }
    // Nothing moved or cut; a rename is still fine.
    let p = await show(h)
    expect(p.objects).toHaveLength(1)
    expect(p.objects[0]).toMatchObject({ rotate: [0, 0, 0], scale: [1, 1, 1], position: null, plates: [1] })
    expect((await call(h, 'slicerx_project_rename', { object: 'obj-1', name: 'Base' })).ok).toBe(true)

    const free = await call(h, 'slicerx_project_lock', { object: 'Base', locked: false })
    expect(free.output.project.objects[0]?.locked).toBe(false)
    expect((await call(h, 'slicerx_project_move', { object: 'Base', x: 50, y: 60 })).ok).toBe(true)
    p = await show(h)
    expect(p.objects[0]?.position).toEqual([50, 60])
  })

  it('keeps a locked object on its plate when another is arranged', async () => {
    const h = await project()
    writeFileSync(join(h.dir, 'small.stl'), boxStl(10, 10, 10))
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'small.stl') })
    await call(h, 'slicerx_project_lock', { object: 'obj-1' })
    const arranged = await call(h, 'slicerx_arrange', { objectId: 'obj-2', count: 4 })
    expect(arranged.ok, arranged.summary).toBe(true)
    const p = await show(h)
    expect(p.plates[0]?.items).toEqual([
      { objectId: 'obj-2', copies: 4 },
      { objectId: 'obj-1', copies: 1 },
    ])
    // Arranging the locked one itself is refused.
    const own = await call(h, 'slicerx_arrange', { objectId: 'obj-1', count: 2 })
    expect(own.ok).toBe(false)
    expect((await show(h)).plates[0]?.items).toContainEqual({ objectId: 'obj-1', copies: 1 })
  })

  it('leaves an object out of the print where it sits, and the slice without it', async () => {
    const h = await project()
    writeFileSync(join(h.dir, 'small.stl'), boxStl(10, 10, 10))
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'small.stl') })
    const grams = async (): Promise<number> => {
      const r = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
      expect(r.ok, r.error?.message ?? r.summary).toBe(true)
      return r.output.total.grams
    }
    const both = await grams()
    const out = await call(h, 'slicerx_project_printable', { object: 'obj-2', printable: false })
    expect(out.ok).toBe(true)
    expect(out.output.project.objects.map((o) => [o.id, o.printable])).toEqual([['obj-1', true], ['obj-2', false]])
    // Still on the plate, in its place in the rows.
    const placements = out.output.project.plates[0]?.placements ?? []
    expect(placements.map((x) => [x.id, x.printable])).toEqual([['obj-1-1', undefined], ['obj-2-1', false]])
    // The slice leaves it out: less filament, the same as the block alone.
    const left = await grams()
    expect(left).toBeLessThan(both)
    await call(h, 'slicerx_project_remove_object', { object: 'obj-2' })
    expect(await grams()).toBe(left)

    // With every object left out, the slice says why.
    await call(h, 'slicerx_project_printable', { object: 'obj-1', printable: false })
    const none = await call(h, 'slicerx_slice')
    expect(none.ok).toBe(false)
    expect(JSON.stringify(none)).toMatch(/Every object on plate 1 is left out of the print/)
    const back = await call(h, 'slicerx_project_printable', { object: 'obj-1', printable: true })
    expect(back.output.project.objects[0]?.printable).toBe(true)
    expect(await grams()).toBe(left)
  })

  it('centers an object on the bed and keeps it there', async () => {
    const h = await project()
    const p0 = await show(h)
    const mid = [p0.bed.originMm[0]! + p0.bed.widthMm / 2, p0.bed.originMm[1]! + p0.bed.depthMm / 2]
    await call(h, 'slicerx_project_move', { object: 'obj-1', x: 20, y: 30 })
    const c = await call<{ position: number[]; project: Project }>(h, 'slicerx_project_center', { object: 'obj-1' })
    expect(c.ok).toBe(true)
    expect(c.output.position).toEqual(mid)
    expect(c.output.project.objects[0]?.position).toEqual(mid)
    expect(c.output.project.plates[0]?.placements[0]?.centerMm).toEqual(mid)
  })

  it('splits an object of two bodies to objects, each left where it was with the source settings', async () => {
    const h = await project()
    writeFileSync(join(h.dir, 'pair.stl'), twoBlocks())
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'pair.stl'), copies: 2 })
    await call(h, 'slicerx_project_object_settings', { object: 'obj-2', set: { wall_loops: 5 } })
    await call(h, 'slicerx_project_height_ranges', { ranges: [{ z_from_mm: 2, z_to_mm: 4, settings: { wall_loops: 2 }, objects: ['obj-2'] }] })
    await call(h, 'slicerx_project_move', { object: 'obj-2', x: 100, y: 100 })
    const before = (await show(h)).objects[1]
    expect(before?.bbox_mm).toEqual([40, 10, 10])

    const split = await call<{ objects: string[]; project: Project }>(h, 'slicerx_project_split_objects', { object: 'obj-2' })
    expect(split.ok, split.error?.message).toBe(true)
    expect(split.output.objects).toEqual(['obj-3', 'obj-4'])
    const p = await show(h)
    expect(p.objects.map((o) => [o.id, o.name, o.bbox_mm, o.settings, o.plates])).toEqual([
      ['obj-1', 'block.stl', [30, 20, 10], {}, [1]],
      ['obj-3', 'pair.stl 1', [20, 10, 10], { wall_loops: 5 }, [1]],
      ['obj-4', 'pair.stl 2', [10, 10, 10], { wall_loops: 5 }, [1]],
    ])
    // The pair spanned x 80 to 120 around 100: the big block sat at 80 to 100, the small one at 110 to 120.
    expect(p.objects[1]?.position).toEqual([90, 100])
    expect(p.objects[2]?.position).toEqual([115, 100])
    expect(p.plates[0]?.items).toEqual([
      { objectId: 'obj-1', copies: 1 },
      { objectId: 'obj-3', copies: 2 },
      { objectId: 'obj-4', copies: 2 },
    ])
    expect(p.height_ranges[0]?.objects).toEqual(['obj-3', 'obj-4'])

    const one = await call(h, 'slicerx_project_split_objects', { object: 'obj-4' })
    expect(one.ok).toBe(false)
    expect(one.error?.message).toMatch(/one piece; there is nothing to split/)
  })

  it('splits an object of two bodies to parts, keeping its id, place and size', async () => {
    const h = await project()
    writeFileSync(join(h.dir, 'pair.stl'), twoBlocks())
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'pair.stl') })
    await call(h, 'slicerx_project_rotate', { object: 'obj-2', rotate: [0, 0, 90] })
    const split = await call<{ parts: number; project: Project }>(h, 'slicerx_project_split_parts', { object: 'pair.stl' })
    expect(split.ok, split.error?.message).toBe(true)
    expect(split.output.parts).toBe(2)
    expect((await show(h)).objects[1]).toMatchObject({ id: 'obj-2', parts: 2, rotate: [0, 0, 90], bbox_mm: [10, 40, 10] })
    const again = await call(h, 'slicerx_project_split_parts', { object: 'obj-2' })
    expect(again.ok).toBe(false)
    expect(again.error?.message).toMatch(/nothing to split/)
  })
})

describe('the ring verbs from a shell', () => {
  it('runs split, lock, center and printable through slicerx-mcp call, each read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-ring-'))
    writeFileSync(join(dir, 'pair.stl'), twoBlocks())
    const calls = [
      ['project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' }],
      ['project_add_model', { model: join(dir, 'pair.stl') }],
      ['project_split_objects', { object: 'obj-1' }],
      ['project_lock', { object: 'obj-2' }],
      ['project_center', { object: 'obj-3' }],
      ['project_printable', { object: 'obj-3', printable: false }],
      ['project_show', {}],
      // Last, since call stops at the first refusal: the locked one cannot be centered.
      ['project_center', { object: 'obj-2' }],
    ] as const
    const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', '--printers', 'off', '--allow-dir', dir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([t, a]) => [t, JSON.stringify(a)])]
    const res = await run(process.execPath, args, { cwd: resolve(__dirname, '..'), env: { ...process.env, HOME: dir } }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { stdout: string; stderr: string; code: number }) => e,
    )
    expect(res.code, res.stderr).toBe(1)
    const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; text: string; output: Res<Project> })
    expect(lines.map((l) => [l.tool, l.ok])).toEqual(calls.map(([t], k) => [`slicerx_${t}`, k < calls.length - 1]))
    expect(lines.at(-1)?.text).toMatch(/pair\.stl 1 is locked/)
    const shown = lines[6]!.output.output
    expect(shown.objects.map((o) => [o.id, o.name, o.locked, o.printable])).toEqual([
      ['obj-2', 'pair.stl 1', true, true],
      ['obj-3', 'pair.stl 2', false, false],
    ])
    expect(shown.objects[1]?.position).toEqual([shown.bed.originMm[0]! + shown.bed.widthMm / 2, shown.bed.originMm[1]! + shown.bed.depthMm / 2])
  }, 60_000)
})
