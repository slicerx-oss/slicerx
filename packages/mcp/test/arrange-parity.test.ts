// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two places where an arranged copy's turn has to match the app. Duplicate in the app copies the selected copy as it
// sits, turn included, so slicerx_project_duplicate of a copy the last arrange turned gives a copy at the same turn,
// placed around the others and inside the bed. And a part that fits more copies turned a quarter turn gets them from
// the nest's own turns through slicerx_arrange, with no separate rotation hint on the plate.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxStl, connect, data, noSxGeom, sxGeomBin, type Harness } from './helpers'

type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }
type Placement = { id: string; objectId: string; centerMm: [number, number]; sizeMm: [number, number, number]; turnDeg: number }
type Shown = { plates: { index: number; items: Record<string, unknown>[]; placements: Placement[] }[] }
type Arranged = { plates: { plate: number; copies: number }[]; turns: { id: string; plate: number; turnDeg: number }[] }
type Duplicated = { objects: string[]; moved: { objectId: string; from: number; to: number }[] }

/** Gap duplicate keeps around a copy it places, mm (slicerx_arrange's default). */
const DUPLICATE_GAP = 6
const EPS = 2e-2

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  const out = { ...d, ok: d.ok ?? !r.isError } as Res<T>
  expect(out.ok, `${name}: ${out.error?.message ?? out.summary}`).toBe(true)
  return out
}

const show = async (h: Harness): Promise<Shown> => (await call<Shown>(h, 'slicerx_project_show')).output

/** A bed of `w` by `d` mm with no excluded area, brim, skirt or support, and a box of `len` by `width` mm as obj-1. */
async function barProject(w: number, d: number, len: number, width: number, rotateZ = 0): Promise<Harness> {
  const h = await connect({ sxGeomBin })
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_set_overrides', { changes: { printable_area: ['0x0', `${w}x0`, `${w}x${d}`, `0x${d}`], bed_exclude_area: [], brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
  writeFileSync(join(h.dir, 'bar.stl'), boxStl(len, width, 5))
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'bar.stl') })
  if (rotateZ) await call(h, 'slicerx_project_rotate', { object: 'obj-1', rotate: [0, 0, rotateZ] })
  return h
}

type Pt = [number, number]

/** A box's footprint corners: its start angle plus its turn, about the center of its placement. */
function corners(p: Placement, len: number, width: number, startDeg: number): Pt[] {
  const a = ((startDeg + p.turnDeg) * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  return ([[-len / 2, -width / 2], [len / 2, -width / 2], [len / 2, width / 2], [-len / 2, width / 2]] as const).map(([x, y]) => [p.centerMm[0] + c * x - s * y, p.centerMm[1] + s * x + c * y])
}

/** The gap between two convex footprints along the axis that separates them best (0 or less when they overlap). */
function separation(a: Pt[], b: Pt[]): number {
  let best = -Infinity
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!
      const q = poly[(i + 1) % poly.length]!
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      const n: Pt = [(q[1] - p[1]) / len, (p[0] - q[0]) / len]
      const proj = (s: Pt[]) => s.map(([x, y]) => x * n[0] + y * n[1])
      const pa = proj(a)
      const pb = proj(b)
      best = Math.max(best, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb))
    }
  }
  return best
}

const outside = (pts: Pt[], w: number, d: number): Pt[] => pts.filter(([x, y]) => x < -EPS || y < -EPS || x > w + EPS || y > d + EPS)

describe.skipIf(noSxGeom())('arranged turns match the app', () => {
  it('a duplicate of a turned copy keeps its turn and stays inside the bed, clear of the others', { timeout: 240_000 }, async () => {
    // Bars of 80 x 6 mm standing at 30 degrees on a 100 mm bed: the arrange turns them, and 6 leave room for more.
    const [BED, LEN, WIDTH, START] = [100, 80, 6, 30]
    const h = await barProject(BED, BED, LEN, WIDTH, START)
    try {
      await call<Arranged>(h, 'slicerx_arrange', { objectId: 'obj-1', count: 6, plates: 1, spacing: 2 })
      const before = await show(h)
      const source = before.plates[0]!.placements.find((p) => p.id === 'obj-1-1')!
      // The copy duplicate starts from is turned; otherwise this case would prove nothing.
      expect(source.turnDeg).not.toBe(0)

      const dup = await call<Duplicated>(h, 'slicerx_project_duplicate', { object: 'obj-1' })
      expect(dup.output.objects).toEqual(['obj-2'])
      expect(dup.output.moved).toEqual([])
      const after = await show(h)
      expect(after.plates.length).toBe(1)
      const placed = after.plates[0]!.placements
      const copy = placed.find((p) => p.objectId === 'obj-2')!
      // The new copy has the turn of the copy it came from, as Duplicate in the app keeps it.
      expect(copy.turnDeg).toBe(source.turnDeg)
      const mine = corners(copy, LEN, WIDTH, START)
      expect(outside(mine, BED, BED)).toEqual([])
      for (const p of placed.filter((q) => q.objectId === 'obj-1')) expect(separation(mine, corners(p, LEN, WIDTH, START)), `obj-2 against ${p.id}`).toBeGreaterThanOrEqual(DUPLICATE_GAP - EPS)
      // The copies already there keep their places and turns.
      expect(placed.filter((q) => q.objectId === 'obj-1')).toEqual(before.plates[0]!.placements)
    } finally {
      await h.client.close()
    }
  })

  it('a part that fits more turned a quarter turn gets those copies from the nest, with no rotation hint on the plate', { timeout: 240_000 }, async () => {
    // A 100 x 60 mm bed and bars of 50 x 10 mm: in rows as loaded, 5 fit, so a sixth needs a quarter turn.
    const [W, D, LEN, WIDTH] = [100, 60, 50, 10]
    const h = await barProject(W, D, LEN, WIDTH)
    try {
      const r = await call<Arranged>(h, 'slicerx_arrange', { objectId: 'obj-1', count: 6, plates: 1, spacing: 2 })
      expect(r.output.plates).toEqual([expect.objectContaining({ plate: 1, copies: 6 })])
      const s = await show(h)
      expect(s.plates.length).toBe(1)
      const plate = s.plates[0]!
      // The plate keeps only the object and its copies: the turns live in the arranged layout.
      expect(plate.items).toEqual([{ objectId: 'obj-1', copies: 6 }])
      const bars = plate.placements
      expect(bars.length).toBe(6)
      expect(bars.some((p) => p.turnDeg === 90 || p.turnDeg === 270)).toBe(true)
      for (const p of bars) expect(outside(corners(p, LEN, WIDTH, 0), W, D), p.id).toEqual([])
      for (let i = 0; i < bars.length; i++) for (let j = i + 1; j < bars.length; j++) expect(separation(corners(bars[i]!, LEN, WIDTH, 0), corners(bars[j]!, LEN, WIDTH, 0))).toBeGreaterThanOrEqual(2 - EPS)
    } finally {
      await h.client.close()
    }
  })
})
