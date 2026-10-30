// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_arrange turns each copy as the app's Arrange does. Long thin bars standing at 30 degrees show it: the nest
// turns them and fits about a dozen on a 100 mm bed, where the same bars kept at their angle fit a few. The app lays
// 24 of these bars out on two plates (packages/app/test/arrange-overflow-nest.test.ts); slicerx_arrange must do the
// same, on the plates it was asked for and on the new plates copies with no room go to, with every copy inside the
// bed and the gap kept between the turned outlines. Each copy's turn is in the arrange result and in project.show.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxStl, connect, data, noSxGeom, sxGeomBin, type Harness } from './helpers'

type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }
type Placement = { id: string; objectId: string; centerMm: [number, number]; sizeMm: [number, number, number]; turnDeg: number }
type Shown = { plates: { index: number; items: { objectId: string; copies: number }[]; placements: Placement[] }[] }
type Arranged = { plates: { plate: number; copies: number }[]; turns: { id: string; plate: number; turnDeg: number }[]; moved?: { objectId: string; copies: number; fromPlate: number; toPlate: number }[] }

const BED = 100
const LEN = 80
const WIDTH = 6
const GAP = 2
/** Plates the app's Arrange all puts 24 of these bars on (arrange-overflow-nest.test.ts). */
const APP_PLATES = 2

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  const out = { ...d, ok: d.ok ?? !r.isError } as Res<T>
  expect(out.ok, `${name}: ${out.error?.message ?? out.summary}`).toBe(true)
  return out
}

const show = async (h: Harness): Promise<Shown> => (await call<Shown>(h, 'slicerx_project_show')).output

/** A 100 mm bed with no excluded area, brim, skirt or support, as the app's test has it, and a bar at 30 degrees as obj-1. */
async function barsProject(): Promise<Harness> {
  const h = await connect({ sxGeomBin })
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_set_overrides', { changes: { printable_area: ['0x0', `${BED}x0`, `${BED}x${BED}`, `0x${BED}`], bed_exclude_area: [], brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
  writeFileSync(join(h.dir, 'bar.stl'), boxStl(LEN, WIDTH, 5))
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'bar.stl') })
  await call(h, 'slicerx_project_rotate', { object: 'obj-1', rotate: [0, 0, 30] })
  return h
}

type Pt = [number, number]

/** A bar's footprint corners: the 30 degree start plus its turn, about the center of its box. */
function corners(p: Placement): Pt[] {
  const a = ((30 + p.turnDeg) * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  return ([[-LEN / 2, -WIDTH / 2], [LEN / 2, -WIDTH / 2], [LEN / 2, WIDTH / 2], [-LEN / 2, WIDTH / 2]] as const).map(([x, y]) => [p.centerMm[0] + c * x - s * y, p.centerMm[1] + s * x + c * y])
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

/** Every bar corner past the bed, and every pair of bars closer than the gap, on every plate. */
function problems(s: Shown): string[] {
  const out: string[] = []
  for (const plate of s.plates) {
    const bars = plate.placements.filter((p) => p.objectId === 'obj-1')
    for (const p of bars) for (const [x, y] of corners(p)) if (x < -1e-2 || y < -1e-2 || x > BED + 1e-2 || y > BED + 1e-2) out.push(`plate ${plate.index}: ${p.id} past the edge at ${x.toFixed(2)}, ${y.toFixed(2)}`)
    for (let i = 0; i < bars.length; i++) {
      for (let j = i + 1; j < bars.length; j++) {
        const gap = separation(corners(bars[i]!), corners(bars[j]!))
        if (gap < GAP - 2e-2) out.push(`plate ${plate.index}: ${bars[i]!.id} and ${bars[j]!.id} ${gap.toFixed(2)} mm apart`)
      }
    }
  }
  return out
}

const bars = (s: Shown) => s.plates.reduce((n, p) => n + p.items.filter((i) => i.objectId === 'obj-1').reduce((m, i) => m + i.copies, 0), 0)

describe.skipIf(noSxGeom())('slicerx_arrange turns each copy as the app does', () => {
  it('24 bars at 30 degrees go on as many plates as the app uses, inside the bed with the gap kept', { timeout: 240_000 }, async () => {
    const h = await barsProject()
    try {
      const r = await call<Arranged>(h, 'slicerx_arrange', { objectId: 'obj-1', count: 24, plates: APP_PLATES, spacing: GAP })
      const s = await show(h)
      expect(s.plates.length).toBe(APP_PLATES)
      expect(bars(s)).toBe(24)
      expect(problems(s)).toEqual([])
      // The copies are turned out of their 30 degree start, and the result and project.show say how far, copy by copy.
      const placed = s.plates.flatMap((p) => p.placements.map((q) => ({ id: q.id, plate: p.index, turnDeg: q.turnDeg })))
      expect(placed.some((q) => q.turnDeg !== 0)).toBe(true)
      expect([...r.output.turns].sort((a, b) => a.plate - b.plate || a.id.localeCompare(b.id))).toEqual(placed.sort((a, b) => a.plate - b.plate || a.id.localeCompare(b.id)))
    } finally {
      await h.client.close()
    }
  })

  it('copies with no room around another object go to a new plate laid out with turns too', { timeout: 240_000 }, async () => {
    const h = await barsProject()
    try {
      // A block in the middle of plate 1 that stays where it is.
      writeFileSync(join(h.dir, 'block.stl'), boxStl(30, 30, 10))
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'block.stl') })
      await call(h, 'slicerx_project_move', { object: 'obj-2', x: BED / 2, y: BED / 2 })
      const r = await call<Arranged>(h, 'slicerx_arrange', { objectId: 'obj-1', count: 24, plates: APP_PLATES, spacing: GAP })
      const s = await show(h)
      expect(bars(s)).toBe(24)
      expect(problems(s)).toEqual([])
      // Plate 1 held fewer around the block, so some went on to a new plate after the two asked for.
      expect(r.output.moved?.some((m) => m.objectId === 'obj-1' && m.toPlate > APP_PLATES)).toBe(true)
      const extra = s.plates.filter((p) => p.index > APP_PLATES).flatMap((p) => p.placements)
      expect(extra.length).toBeGreaterThan(0)
      expect(extra.some((p) => p.turnDeg !== 0)).toBe(true)
      // The block keeps its place and is not turned.
      const block = s.plates[0]!.placements.find((p) => p.objectId === 'obj-2')!
      expect(block.centerMm).toEqual([BED / 2, BED / 2])
      expect(block.turnDeg).toBe(0)
      const [bw, bd] = block.sizeMm
      const box: Pt[] = [[BED / 2 - bw / 2, BED / 2 - bd / 2], [BED / 2 + bw / 2, BED / 2 - bd / 2], [BED / 2 + bw / 2, BED / 2 + bd / 2], [BED / 2 - bw / 2, BED / 2 + bd / 2]]
      for (const p of s.plates[0]!.placements.filter((q) => q.objectId === 'obj-1')) expect(separation(corners(p), box)).toBeGreaterThanOrEqual(GAP - 2e-2)
    } finally {
      await h.client.close()
    }
  })
})
