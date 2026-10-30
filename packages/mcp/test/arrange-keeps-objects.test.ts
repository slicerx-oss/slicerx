// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_arrange and slicerx_project_duplicate never take an object off the plates or past the bed's edge. Before,
// arranging one object laid out plates that held only that object and every other object ended up on no plate (it
// no longer sliced), and duplicate put copies in rows that ran past the bed with no word. Now arrange packs the copies
// around the other objects, which keep their places, and copies with no room go to new plates, named by id and plate;
// duplicate sends a copy with no room to another plate and refuses an object no empty plate holds.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SlicerxMcpOptions } from '../src/index'
import { boxStl, connect, data, noSxGeom, sxGeomBin, type Harness } from './helpers'

type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }
type Placement = { id: string; objectId: string; centerMm: [number, number]; sizeMm: [number, number, number]; offBed?: boolean }
type Shown = {
  objects: { id: string; plates: number[] }[]
  plates: { index: number; items: { objectId: string; copies: number }[]; placements: Placement[] }[]
}
type Moved = { objectId: string; copies: number; fromPlate: number; toPlate: number }

/** The P1S bed, mm. */
const BED = 256

async function send<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  return { ...d, ok: d.ok ?? !r.isError } as Res<T>
}

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const out = await send<T>(h, name, args)
  expect(out.ok, `${name}: ${out.error?.message ?? out.summary}`).toBe(true)
  return out
}

const show = async (h: Harness): Promise<Shown> => (await call<Shown>(h, 'slicerx_project_show')).output

/** Copies of each object over all plates, and the ids of the objects on no plate. */
function tally(s: Shown): { copies: Map<string, number>; onNoPlate: string[] } {
  const copies = new Map<string, number>()
  for (const p of s.plates) for (const i of p.items) copies.set(i.objectId, (copies.get(i.objectId) ?? 0) + i.copies)
  return { copies, onNoPlate: s.objects.filter((o) => o.plates.length === 0).map((o) => o.id) }
}

/** Every placement past the bed's edge, and every pair of placements that overlap on a plate. */
function problems(s: Shown): string[] {
  const out: string[] = []
  for (const p of s.plates) {
    const boxes = p.placements.map((q) => ({ id: q.id, x0: q.centerMm[0] - q.sizeMm[0] / 2, y0: q.centerMm[1] - q.sizeMm[1] / 2, x1: q.centerMm[0] + q.sizeMm[0] / 2, y1: q.centerMm[1] + q.sizeMm[1] / 2 }))
    for (const b of boxes) if (b.x0 < -0.01 || b.y0 < -0.01 || b.x1 > BED + 0.01 || b.y1 > BED + 0.01) out.push(`plate ${p.index}: ${b.id} past the edge`)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!]
        if (a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01) out.push(`plate ${p.index}: ${a.id} overlaps ${b.id}`)
      }
    }
  }
  return out
}

async function p1s(engine: SlicerxMcpOptions, models: [string, number, number, number][]): Promise<Harness> {
  const h = await connect(engine)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  for (const [name, x, y, z] of models) {
    writeFileSync(join(h.dir, `${name}.stl`), boxStl(x, y, z))
    await call(h, 'slicerx_project_add_model', { model: join(h.dir, `${name}.stl`) })
  }
  return h
}

/** Ten long thin bars, 150 to 200 mm long, that fill a bed in a few rows. */
const BARS: [string, number, number, number][] = [[200, 8], [185, 12], [170, 6], [195, 15], [160, 10], [175, 7], [150, 14], [190, 9], [165, 11], [180, 13]].map(([x, y], k) => [`bar${k + 1}`, x!, y!, 4])

const ENGINES: [string, SlicerxMcpOptions, boolean][] = [
  ['on true outlines', { sxGeomBin }, noSxGeom()],
  ['on boxes, with no geometry engine', { sxGeomBin: join('/nonexistent', 'sx-geom') }, false],
]

describe.each(ENGINES)('arrange and duplicate keep every object %s', (_name, engine, skip) => {
  it.skipIf(skip)('a bed full of bars: duplicate never goes past the edge, and arrange leaves no object off the plates', { timeout: 120_000 }, async () => {
    const h = await p1s(engine, BARS)
    const ids = (await show(h)).objects.map((o) => o.id)
    for (const id of ids) {
      const dup = await call<{ objects: string[]; moved: { objectId: string; from: number; to: number }[] }>(h, 'slicerx_project_duplicate', { object: id })
      // A copy with no room on plate 1 says where it went.
      for (const m of dup.output.moved ?? []) expect(dup.summary).toContain(`${m.objectId}`)
      expect(problems(await show(h))).toEqual([])
    }
    for (const id of (await show(h)).objects.map((o) => o.id).slice(0, 6)) await call(h, 'slicerx_project_duplicate', { object: id })
    let s = await show(h)
    expect(s.objects).toHaveLength(26)
    expect(tally(s).onNoPlate).toEqual([])
    expect(problems(s)).toEqual([])
    expect(s.plates.length).toBeGreaterThan(1)

    for (const args of [{ objectId: ids[0] }, { objectId: ids[0], count: 3 }]) {
      const before = tally(await show(h))
      const r = await call<{ moved: Moved[] }>(h, 'slicerx_arrange', args)
      s = await show(h)
      const after = tally(s)
      expect(after.onNoPlate).toEqual([])
      expect(problems(s)).toEqual([])
      for (const [id, n] of before.copies) if (id !== ids[0]) expect(after.copies.get(id), id).toBe(n)
      expect(after.copies.get(ids[0]!)).toBe(args.count ?? 1)
      // Each copy that moved is named by object and plate, in the output and the summary.
      for (const m of r.output.moved ?? []) {
        expect(m.objectId).toBe(ids[0])
        expect(r.summary).toContain(`moved to plate ${m.toPlate}`)
      }
    }
  })

  it.skipIf(skip)('copies with no room around the other objects go to a new plate, named by id and plate', { timeout: 60_000 }, async () => {
    const h = await p1s(engine, [['slab', 230, 230, 4], ['cube', 60, 60, 20]])
    // The slab alone on plate 1, the cube on plate 2.
    await call(h, 'slicerx_project_plate_add')
    await call(h, 'slicerx_project_move_to_plate', { object: 'obj-2', plate: 2 })
    expect(problems(await show(h))).toEqual([])
    const was = (await show(h)).plates[0]!.placements.find((p) => p.objectId === 'obj-1')!
    const r = await call<{ moved: Moved[] }>(h, 'slicerx_arrange', { objectId: 'obj-2', count: 2 })
    expect(r.output.moved).toEqual([{ objectId: 'obj-2', copies: 2, fromPlate: 1, toPlate: 2 }])
    expect(r.summary).toContain('2 copies of obj-2 had no room on plate 1, so they moved to plate 2.')
    const s = await show(h)
    expect(s.plates.map((p) => p.items)).toEqual([[{ objectId: 'obj-1', copies: 1 }], [{ objectId: 'obj-2', copies: 2 }]])
    // The slab stays where it was.
    expect(s.plates[0]!.placements[0]!.centerMm).toEqual(was.centerMm)
    expect(problems(s)).toEqual([])
  })

  // The new plates are laid out by the same arrange as the plan's plates, so the copies an empty bed holds all go to one.
  it.skipIf(skip)('copies with no room around the other objects go to one new plate packed as full as an empty bed', { timeout: 120_000 }, async () => {
    // How many bars an empty bed holds.
    const empty = await p1s(engine, [['bar', 200, 8, 4]])
    const most = await send<{ placed: number }>(empty, 'slicerx_arrange', { objectId: 'obj-1', count: 500 })
    const full = most.output.placed
    expect(full).toBeGreaterThan(4)
    // A slab over half the bed on plate 1, the bar on plate 2; a full bed of bars arranged onto plate 1.
    const h = await p1s(engine, [['slab', 250, 120, 4], ['bar', 200, 8, 4]])
    await call(h, 'slicerx_project_plate_add')
    await call(h, 'slicerx_project_move_to_plate', { object: 'obj-2', plate: 2 })
    const r = await call<{ moved: Moved[] }>(h, 'slicerx_arrange', { objectId: 'obj-2', count: full })
    const s = await show(h)
    const bars = s.plates.map((p) => p.items.filter((i) => i.objectId === 'obj-2').reduce((n, i) => n + i.copies, 0))
    expect(bars).toHaveLength(2)
    expect(bars[0]).toBeGreaterThan(0)
    expect(bars[0]! + bars[1]!).toBe(full)
    expect(r.output.moved).toEqual([{ objectId: 'obj-2', copies: bars[1], fromPlate: 1, toPlate: 2 }])
    expect(problems(s)).toEqual([])
  })

  it.skipIf(skip)('a copy with no room on the bed goes to the next plate, then a new one', { timeout: 60_000 }, async () => {
    const h = await p1s(engine, [['block', 150, 150, 10]])
    const dup = await call<{ objects: string[]; moved: { objectId: string; from: number; to: number }[] }>(h, 'slicerx_project_duplicate', { object: 'obj-1', count: 2 })
    expect(dup.output.objects).toEqual(['obj-2', 'obj-3'])
    expect(dup.output.moved).toEqual([{ objectId: 'obj-2', from: 1, to: 2 }, { objectId: 'obj-3', from: 1, to: 3 }])
    expect(dup.summary).toBe('obj-1 duplicated as obj-2, obj-3. obj-2, obj-3 had no room on plate 1, so they went to plate 2 and plate 3.')
    const s = await show(h)
    expect(s.plates.map((p) => p.items.map((i) => i.objectId))).toEqual([['obj-1'], ['obj-2'], ['obj-3']])
    expect(problems(s)).toEqual([])
  })

  it.skipIf(skip)('refuses to duplicate an object no empty plate holds, and makes no copy', { timeout: 60_000 }, async () => {
    const h = await p1s(engine, [['long', 300, 20, 4]])
    const r = await send(h, 'slicerx_project_duplicate', { object: 'obj-1' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/has no room even on an empty plate .*so no copy was added/)
    expect((await show(h)).objects.map((o) => o.id)).toEqual(['obj-1'])
  })

  // Every arrange and duplicate path a client has: the objects on the plates before are all on them after (a duplicate
  // adds its copies), and every object other than the one arranged keeps its copies.
  it.skipIf(skip)('invariant: no arrange or duplicate takes an object off the plates', { timeout: 120_000 }, async () => {
    const paths: [string, Record<string, unknown>][] = [
      ['slicerx_arrange', {}],
      ['slicerx_arrange', { objectId: 'obj-2' }],
      ['slicerx_arrange', { objectId: 'obj-3', count: 4 }],
      ['slicerx_arrange', { objectId: 'obj-1', count: 6, plates: 2 }],
      ['slicerx_arrange', { objectId: 'obj-4', spacing: 2 }],
      ['slicerx_project_duplicate', { object: 'obj-2' }],
      ['slicerx_project_duplicate', { object: 'obj-3', count: 8 }],
      ['slicerx_arrange', { objectId: 'obj-2', count: 2 }],
    ]
    const h = await p1s(engine, [['a', 40, 30, 10], ['b', 120, 90, 6], ['c', 70, 70, 15], ['d', 25, 160, 5], ['e', 50, 50, 50]])
    await call(h, 'slicerx_project_lock', { object: 'obj-5' })
    for (const [tool, args] of paths) {
      const before = tally(await show(h))
      const r = await call<{ objects?: string[] }>(h, tool, args)
      const s = await show(h)
      const after = tally(s)
      const added = r.output.objects ?? []
      const arranged = tool === 'slicerx_arrange' ? String(args['objectId'] ?? 'obj-1') : undefined
      expect(after.onNoPlate, `${tool} ${JSON.stringify(args)}`).toEqual([])
      expect([...after.copies.keys()].sort(), `${tool} ${JSON.stringify(args)}`).toEqual([...before.copies.keys(), ...added].sort())
      for (const [id, n] of before.copies) if (id !== arranged) expect(after.copies.get(id), `${tool} ${JSON.stringify(args)}: ${id}`).toBe(n)
      expect(problems(s), `${tool} ${JSON.stringify(args)}`).toEqual([])
    }
  })
})
