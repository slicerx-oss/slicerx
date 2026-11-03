// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mirror and Fill bed over MCP, as a client does them: slicerx_project_mirror flips objects along a bed axis in place,
// as the app's Mirror does, and slicerx_project_fill_bed fills the free room on a plate with copies of an object, as
// the app's Fill bed does, around what is already there. Each is read back from the answer and slicerx_project_show,
// and with the real engine the mirrored object slices as the same amount of plastic. Nothing here sends anything to a
// printer.
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rotationMatrix } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { mirroredPose } from '../src/project'
import { boxStl, connect, data, noSx, noSxGeom, sxBin, sxGeomBin, sxTimeout, type Harness } from './helpers'

const run = promisify(execFile)

type Placement = { id: string; objectId: string; copy: number; centerMm: [number, number]; sizeMm: [number, number, number]; turnDeg: number }
type Obj = { id: string; name: string; bbox_mm: number[]; rotate: number[]; scale: number[]; position: number[] | null; locked: boolean }
type Project = {
  objects: Obj[]
  bed: { widthMm: number; depthMm: number; originMm: number[] }
  plates: { index: number; items: { objectId: string; copies: number }[]; placements: Placement[] }[]
}
type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }
type Filled = { object: string; plate: number; added: number; copies: number; project: Project }

async function call<T = { project: Project }>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError } as Res<T>
}
const show = async (h: Harness): Promise<Project> => (await call<Project>(h, 'slicerx_project_show')).output

const BED = 100

/** A 100 mm bed with no excluded area, brim, skirt or support, so how many copies fit is plain to count. */
async function smallBed(opts: Parameters<typeof connect>[0] = {}): Promise<Harness> {
  const h = await connect(opts)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_set_overrides', { changes: { printable_area: ['0x0', `${BED}x0`, `${BED}x${BED}`, `0x${BED}`], bed_exclude_area: [], brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
  return h
}

/** An L of two boxes in one STL: 30 x 10 x 10 mm along X, and 10 x 20 x 10 mm standing up from its left end, so no mirror leaves it as it was. */
function ell(): Buffer {
  const a = boxStl(30, 10, 10)
  const b = boxStl(10, 20, 10)
  for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) b.writeFloatLE(b.readFloatLE(84 + t * 50 + 12 + k * 12 + 4) + 10, 84 + t * 50 + 12 + k * 12 + 4)
  const out = Buffer.concat([a, b.subarray(84)])
  out.writeUInt32LE(24, 80)
  return out
}

/** The rotation and scale as one column-major 4x4, scale first, as the project places an object. */
function orientation(rotate: [number, number, number], scale: readonly number[]): number[] {
  const m = rotationMatrix(rotate)
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 4 + row] = (m[col * 4 + row] ?? 0) * (scale[col] ?? 1)
  return m
}

/** Whether two placed copies' boxes overlap, less a hair for rounding. */
function overlap(a: Placement, b: Placement): boolean {
  const apart = (k: 0 | 1) => Math.abs(a.centerMm[k] - b.centerMm[k]) >= (a.sizeMm[k] + b.sizeMm[k]) / 2 - 0.05
  return !(apart(0) || apart(1))
}

function insideBed(p: Placement, bed: Project['bed']): boolean {
  const [x0, y0] = bed.originMm as [number, number]
  const tol = 0.05
  return p.centerMm[0] - p.sizeMm[0] / 2 >= x0 - tol && p.centerMm[1] - p.sizeMm[1] / 2 >= y0 - tol && p.centerMm[0] + p.sizeMm[0] / 2 <= x0 + bed.widthMm + tol && p.centerMm[1] + p.sizeMm[1] / 2 <= y0 + bed.depthMm + tol
}

function lastRequest(h: Harness): { plate: { objects: { id: string; transform: number[] }[] } } {
  const dir = join(h.dir, 'out', 'plates')
  const newest = readdirSync(dir).map((d) => join(dir, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? ''
  return JSON.parse(readFileSync(join(newest, 'request.json'), 'utf8'))
}

describe('the pose of a mirrored object', () => {
  it('places the model as the bed mirror of the object as it was, for any rotation and scale', () => {
    const cases: [[number, number, number], [number, number, number]][] = [
      [[0, 0, 0], [1, 1, 1]],
      [[0, 0, 90], [1, 1, 1]],
      [[10, 20, 30], [1, 2, 0.5]],
      [[-45, 60, 135], [1.5, 1, 1]],
      [[90, 0, -30], [-1, 1, 1]],
    ]
    for (const [rotate, scale] of cases) {
      for (const axis of [0, 1, 2] as const) {
        const before = orientation(rotate, scale)
        const pose = mirroredPose(rotate, scale, axis)
        const after = orientation(pose.rotate, pose.scale)
        // The bed mirror flips row `axis` of the 3x3; the move is set again when it is placed.
        for (let col = 0; col < 3; col++) {
          for (let row = 0; row < 3; row++) {
            const want = (before[col * 4 + row] ?? 0) * (row === axis ? -1 : 1)
            expect(after[col * 4 + row], `${rotate} ${scale} axis ${axis} [${row}, ${col}]`).toBeCloseTo(want, 6)
          }
        }
      }
    }
  })

  it('negates that axis of the scale and turns the other two rotations back', () => {
    expect(mirroredPose([10, 20, 30], [1, 2, 1], 0)).toEqual({ rotate: [10, -20, -30], scale: [-1, 2, 1] })
    expect(mirroredPose([10, 20, 30], [1, 2, 1], 1)).toEqual({ rotate: [-10, 20, -30], scale: [1, -2, 1] })
    expect(mirroredPose([0, 0, 30], [1, 1, 1], 2)).toEqual({ rotate: [0, 0, 30], scale: [1, 1, -1] })
    // Twice along the same axis is where it started, with no -0 left in it.
    const twice = mirroredPose(mirroredPose([0, 45, 0], [1, 1, 1], 0).rotate, mirroredPose([0, 45, 0], [1, 1, 1], 0).scale, 0)
    expect(twice).toEqual({ rotate: [0, 45, 0], scale: [1, 1, 1] })
    expect(Object.is(mirroredPose([0, 0, 0], [1, 1, 1], 1).rotate[0], -0)).toBe(false)
  })
})

describe('slicerx_project_mirror', () => {
  it('mirrors an object in place: its footprint center, size and copies stay, and it reads back', async () => {
    const h = await smallBed()
    writeFileSync(join(h.dir, 'ell.stl'), ell())
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'ell.stl'), copies: 2 })
    await call(h, 'slicerx_project_rotate', { object: 'obj-1', rotate: [0, 0, 30] })
    await call(h, 'slicerx_project_move', { object: 'obj-1', x: 40, y: 50 })
    const before = await show(h)

    const m = await call<{ objects: string[]; project: Project }>(h, 'slicerx_project_mirror', { object: 'ell.stl', axis: 'x' })
    expect(m.ok, m.error?.message).toBe(true)
    expect(m.summary).toBe('obj-1 mirrored along X')
    expect(m.output.objects).toEqual(['obj-1'])
    const o = m.output.project.objects[0]
    expect(o).toMatchObject({ rotate: [0, 0, -30], scale: [-1, 1, 1], position: [40, 50] })
    const r2 = (v: number) => Math.round(v * 100) / 100
    expect(o?.bbox_mm).toEqual(before.objects[0]?.bbox_mm.map(r2))
    // Both copies are still there, where they were, the same size.
    const at = (p: Project) => p.plates[0]?.placements.map((x) => [x.id, x.centerMm, x.sizeMm.map((v) => Math.round(v * 100) / 100)])
    expect(at(m.output.project)).toEqual(at(before))
    expect(m.output.project.plates[0]?.items).toEqual([{ objectId: 'obj-1', copies: 2 }])

    // A scale keeps the mirror; mirroring again along X puts it back.
    await call(h, 'slicerx_project_scale', { object: 'obj-1', scale: 2 })
    expect((await show(h)).objects[0]?.scale).toEqual([-2, 2, 2])
    await call(h, 'slicerx_project_scale', { object: 'obj-1', scale: 1 })
    const back = await call(h, 'slicerx_project_mirror', { object: 'obj-1', axis: 'x' })
    expect(back.output.project.objects[0]).toMatchObject({ rotate: [0, 0, 30], scale: [1, 1, 1] })
  })

  it('mirrors a list of objects along Z, upside down and still on the bed', async () => {
    const h = await smallBed()
    writeFileSync(join(h.dir, 'ell.stl'), ell())
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'ell.stl') })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    await call(h, 'slicerx_project_rotate', { object: 'obj-1', rotate: [90, 0, 0] })
    const m = await call<{ objects: string[]; project: Project }>(h, 'slicerx_project_mirror', { object: ['obj-1', 'cube.stl', 'obj-1'], axis: 'z' })
    expect(m.ok, m.error?.message).toBe(true)
    expect(m.output.objects).toEqual(['obj-1', 'obj-2'])
    expect(m.output.project.objects.map((x) => [x.id, x.rotate, x.scale, x.bbox_mm])).toEqual([
      ['obj-1', [-90, 0, 0], [1, 1, -1], [30, 10, 30]],
      ['obj-2', [0, 0, 0], [1, 1, -1], [20, 20, 20]],
    ])
  })

  it('refuses a locked object, or one it cannot find, and changes none of the list', async () => {
    const h = await smallBed()
    writeFileSync(join(h.dir, 'ell.stl'), ell())
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'ell.stl') })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    await call(h, 'slicerx_project_lock', { object: 'obj-2' })
    const locked = await call(h, 'slicerx_project_mirror', { object: ['obj-1', 'obj-2'], axis: 'y' })
    expect(locked.ok).toBe(false)
    expect(locked.error?.message ?? locked.summary).toMatch(/cube\.stl is locked\. Unlock it first with slicerx_project_lock/)
    const missing = await call(h, 'slicerx_project_mirror', { object: ['obj-1', 'obj-9'], axis: 'y' })
    expect(missing.ok).toBe(false)
    expect(missing.error?.message ?? missing.summary).toMatch(/No object obj-9/)
    const bad = await h.call('slicerx_project_mirror', { object: 'obj-1', axis: 'w' })
    expect(bad.isError).toBe(true)
    expect((await show(h)).objects.map((x) => x.scale)).toEqual([[1, 1, 1], [1, 1, 1]])
  })

  it.skipIf(noSx())(
    'with the real engine: a mirrored object slices with a mirroring transform and the same plastic',
    async () => {
      const h = await connect({ engine: 'sx', sxBin })
      writeFileSync(join(h.dir, 'ell.stl'), ell())
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'ell.stl') })
      const grams = async (): Promise<number> => {
        const r = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
        expect(r.ok, r.error?.message ?? r.summary).toBe(true)
        return r.output.total.grams
      }
      const plain = await grams()
      await call(h, 'slicerx_project_mirror', { object: 'obj-1', axis: 'y' })
      const mirrored = await grams()
      const t = lastRequest(h).plate.objects[0]?.transform ?? []
      const det = t[0]! * (t[5]! * t[10]! - t[6]! * t[9]!) - t[4]! * (t[1]! * t[10]! - t[2]! * t[9]!) + t[8]! * (t[1]! * t[6]! - t[2]! * t[5]!)
      expect(det).toBeLessThan(0)
      expect(mirrored).toBeGreaterThan(0)
      expect(Math.abs(mirrored - plain) / plain).toBeLessThan(0.02)
    },
    sxTimeout,
  )
})

describe('slicerx_project_fill_bed', () => {
  it('fills the free room with copies of the object, every one on the bed and clear of the others', async () => {
    const h = await smallBed()
    writeFileSync(join(h.dir, 'block.stl'), boxStl(20, 20, 10))
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'block.stl') })
    const f = await call<Filled>(h, 'slicerx_project_fill_bed', { object: 'obj-1' })
    expect(f.ok, f.error?.message ?? f.summary).toBe(true)
    expect(f.output.object).toBe('obj-1')
    expect(f.output.plate).toBe(1)
    // A 100 mm bed holds a few rows of 20 mm blocks 6 mm apart.
    expect(f.output.added).toBeGreaterThanOrEqual(4)
    expect(f.output.copies).toBe(f.output.added + 1)
    expect(f.summary).toBe(`${f.output.added} copies of obj-1 added on plate 1, ${f.output.copies} in all`)
    const p = await show(h)
    expect(p.objects).toHaveLength(1)
    expect(p.plates[0]?.items).toEqual([{ objectId: 'obj-1', copies: f.output.copies }])
    const placed = p.plates[0]?.placements ?? []
    expect(placed).toHaveLength(f.output.copies)
    for (const x of placed) expect(insideBed(x, p.bed), JSON.stringify(x)).toBe(true)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!), `${placed[i]!.id} ${placed[j]!.id}`).toBe(false)

    // A full bed takes no more.
    const again = await call<Filled>(h, 'slicerx_project_fill_bed', { object: 'obj-1' })
    expect(again.ok).toBe(true)
    expect(again.output.added).toBe(0)
    expect(again.output.copies).toBe(f.output.copies)
    expect(again.summary).toBe('No room left on plate 1 for another copy of obj-1')
    expect((await show(h)).plates[0]?.placements).toEqual(placed)
  })

  it('keeps every copy already on the plate where it sits, and adds no more than max', async () => {
    const h = await smallBed()
    writeFileSync(join(h.dir, 'block.stl'), boxStl(20, 20, 10))
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'block.stl') })
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    await call(h, 'slicerx_project_move', { object: 'obj-2', x: 70, y: 70 })
    await call(h, 'slicerx_project_move', { object: 'obj-1', x: 20, y: 20 })
    const f = await call<Filled>(h, 'slicerx_project_fill_bed', { object: 'block.stl', max: 2 })
    expect(f.ok, f.error?.message ?? f.summary).toBe(true)
    expect(f.output).toMatchObject({ object: 'obj-1', added: 2, copies: 3 })
    const placed = f.output.project.plates[0]?.placements ?? []
    const where = (id: string) => placed.find((x) => x.id === id)?.centerMm
    expect(where('obj-1-1')).toEqual([20, 20])
    expect(where('obj-2-1')).toEqual([70, 70])
    expect(placed.map((x) => x.id).sort()).toEqual(['obj-1-1', 'obj-1-2', 'obj-1-3', 'obj-2-1'])
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!), `${placed[i]!.id} ${placed[j]!.id}`).toBe(false)
  })

  it('refuses an object no empty plate holds, a plate it is not on, and a locked placed object', async () => {
    const h = await smallBed()
    writeFileSync(join(h.dir, 'big.stl'), boxStl(150, 20, 10))
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'big.stl') })
    const big = await call(h, 'slicerx_project_fill_bed', { object: 'obj-1' })
    expect(big.ok).toBe(false)
    expect(big.error?.message ?? big.summary).toMatch(/has no room even on an empty plate/)
    expect((await show(h)).plates[0]?.items).toEqual([{ objectId: 'obj-1', copies: 1 }])

    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'cube.stl') })
    await call(h, 'slicerx_project_plate_add')
    const elsewhere = await call(h, 'slicerx_project_fill_bed', { object: 'obj-2', plate: 2 })
    expect(elsewhere.ok).toBe(false)
    expect(elsewhere.error?.message ?? elsewhere.summary).toMatch(/is not on plate 2; it is on plate 1/)

    await call(h, 'slicerx_project_move', { object: 'obj-2', x: 50, y: 50 })
    await call(h, 'slicerx_project_lock', { object: 'obj-2' })
    const locked = await call(h, 'slicerx_project_fill_bed', { object: 'obj-2' })
    expect(locked.ok).toBe(false)
    expect(locked.error?.message ?? locked.summary).toMatch(/is locked\. Unlock it first with slicerx_project_lock/)
  })

  it.skipIf(noSxGeom())('with the geometry engine: nests the copies on their outlines, all on the bed', async () => {
    const h = await smallBed({ sxGeomBin })
    writeFileSync(join(h.dir, 'ell.stl'), ell())
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'ell.stl') })
    const f = await call<Filled>(h, 'slicerx_project_fill_bed', { object: 'obj-1' })
    expect(f.ok, f.error?.message ?? f.summary).toBe(true)
    expect(f.output.added).toBeGreaterThanOrEqual(4)
    const p = await show(h)
    const placed = p.plates[0]?.placements ?? []
    expect(placed).toHaveLength(f.output.copies)
    for (const x of placed) expect(insideBed(x, p.bed), JSON.stringify(x)).toBe(true)
    const again = await call<Filled>(h, 'slicerx_project_fill_bed', { object: 'obj-1' })
    expect(again.output.added).toBe(0)
  }, 60_000)
})

describe('mirror and fill the bed from a shell', () => {
  it('runs them through slicerx-mcp call, each read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-mirror-fill-'))
    writeFileSync(join(dir, 'ell.stl'), ell())
    const calls = [
      ['project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' }],
      ['project_add_model', { model: join(dir, 'ell.stl') }],
      ['project_mirror', { object: 'obj-1', axis: 'x' }],
      ['project_fill_bed', { object: 'obj-1', max: 3 }],
      ['project_show', {}],
    ] as const
    const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--no-app', '--printers', 'off', '--allow-dir', dir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), 'call', ...calls.flatMap(([t, a]) => [t, JSON.stringify(a)])]
    const res = await run(process.execPath, args, { cwd: resolve(__dirname, '..'), env: { ...process.env, HOME: dir } }).then(
      (r) => ({ ...r, code: 0 }),
      (e: { stdout: string; stderr: string; code: number }) => e,
    )
    expect(res.code, res.stderr).toBe(0)
    const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean; text: string; output: Res<Project & Filled> })
    expect(lines.map((l) => [l.tool, l.ok])).toEqual(calls.map(([t]) => [`slicerx_${t}`, true]))
    expect(lines[3]?.output.output).toMatchObject({ object: 'obj-1', plate: 1, added: 3, copies: 4 })
    const shown = lines[4]!.output.output
    expect(shown.objects[0]).toMatchObject({ id: 'obj-1', scale: [-1, 1, 1] })
    expect(shown.plates[0]?.items).toEqual([{ objectId: 'obj-1', copies: 4 }])
    expect(shown.plates[0]?.placements).toHaveLength(4)
  }, 60_000)
})
