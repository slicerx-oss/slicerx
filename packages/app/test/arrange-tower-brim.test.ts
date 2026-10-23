// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange keeps the prime tower's room as the engine keeps it: the tower, its brim and 1 mm, at a hand placed tower's
// spot, or, while the engine places the tower itself, at the configured spot pulled onto the bed. And an automatic
// brim takes the room the engine prints for it, sized from each object's first layer (its outline at the first
// layer's cut), so a thin part standing on edge keeps its wide brim clear of its neighbors.
// Runs the real geometry engine when it is built, else replies recorded from it (test/geom-engine.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart, SettingValue } from '@slicerx/contracts'
import { autoBrimRoom, type FirstLayerShape } from '@slicerx/settings/print-margins'
import { arrange, NO_MARGINS, printSizeOf, printsOnBed, setAvoidAreas, setMarginSource, type Rect } from '../src/plate/arrange'
import { arrangePlate, setArrangeOptions } from '../src/plate/edit'
import { autoBrimWidth, installPrintMargins, marginsFor, printMargins } from '../src/plate/footprint'
import { nestArrange, outlineOf, type NestEntry } from '../src/plate/nest'
import { bounds, compose, type Mat4 } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('arrange-tower-brim')

type Pt = [number, number]
type Ring = readonly (readonly [number, number])[]

const at = (x: number, y: number, deg = 0): Mat4 => compose({ position: [x, y, 0], rotation: [0, 0, deg], scale: [1, 1, 1] })

/** A closed prism `height` tall over a strip of quads: `a[k]` faces `b[k]` across the strip. */
function strip(a: Pt[], b: Pt[], height: number, slot = 1): MeshPart {
  const positions: number[] = []
  const indices: number[] = []
  const n = a.length
  for (const z of [0, height]) for (const p of [...a, ...b]) positions.push(p[0], p[1], z)
  const v = (k: number, side: 0 | 1, top: 0 | 1) => top * 2 * n + side * n + k
  const quad = (p: number, q: number, r: number, s: number) => indices.push(p, q, r, p, r, s)
  for (let k = 0; k + 1 < n; k++) {
    quad(v(k, 0, 0), v(k, 1, 0), v(k + 1, 1, 0), v(k + 1, 0, 0))
    quad(v(k, 0, 1), v(k + 1, 0, 1), v(k + 1, 1, 1), v(k, 1, 1))
    quad(v(k, 0, 0), v(k + 1, 0, 0), v(k + 1, 0, 1), v(k, 0, 1))
    quad(v(k, 1, 0), v(k, 1, 1), v(k + 1, 1, 1), v(k + 1, 1, 0))
  }
  quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0))
  quad(v(n - 1, 0, 0), v(n - 1, 1, 0), v(n - 1, 1, 1), v(n - 1, 0, 1))
  return { name: 'p', slot, positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** A w x d block `height` tall from the origin. */
const block = (w: number, d: number, height: number, slot = 1) => strip([[0, 0], [w, 0]], [[0, d], [w, d]], height, slot)

/** A curved fin standing on edge: `sweepDeg` of a ring `r` mm across the middle of its wall, `wall` mm thick. */
function crescent(r: number, wall: number, height: number, sweepDeg = 150): MeshPart {
  const steps = 30
  const arc = (radius: number): Pt[] => Array.from({ length: steps + 1 }, (_, k) => {
    const t = ((-sweepDeg / 2 + (k * sweepDeg) / steps) * Math.PI) / 180
    return [radius * Math.cos(t), radius * Math.sin(t)]
  })
  return strip(arc(r + wall / 2), arc(r - wall / 2), height)
}

const nestEntry = (id: string, part: MeshPart, t: Mat4): NestEntry => ({ id, parts: [part], transform: t })

function plateEntry(id: string, part: MeshPart, t: Mat4): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: part.indices.length / 3, bboxMm: [0, 0, 5], openEdges: 0, parts: [{ name: part.name, slot: part.slot }] } as unknown as MeshHandle
  return { id, name: id, handle, parts: [part], colors: ['#bd93f9', '#50fa7b'], transform: t }
}

/** The outline of an entry's first layer where a transform puts it: what the engine cuts at 0.1 mm. */
async function firstLayer(part: MeshPart, t: Mat4): Promise<FirstLayerShape[]> {
  return (await outlineOf(nestEntry('q', part, t), 0.1)).base ?? []
}

/** The smallest distance between two sets of rings, mm, by their edges. */
function ringDistance(a: readonly Ring[], b: readonly Ring[]): number {
  const seg = (p: Ring[number], u: Ring[number], w: Ring[number]) => {
    const dx = w[0] - u[0]
    const dy = w[1] - u[1]
    const l = dx * dx + dy * dy
    const t = l > 0 ? Math.min(1, Math.max(0, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l)) : 0
    return Math.hypot(u[0] + t * dx - p[0], u[1] + t * dy - p[1])
  }
  let best = Infinity
  for (const [from, to] of [[a, b], [b, a]] as const) for (const r of from) for (const p of r) for (const s of to) for (let i = 0; i < s.length; i++) best = Math.min(best, seg(p, s[i]!, s[(i + 1) % s.length]!))
  return best
}

const rings = (shapes: readonly FirstLayerShape[]): Ring[] => shapes.flatMap((s) => [s.outer, ...s.holes])

/** The distance from an outline to a box, mm: 0 when they touch or overlap. */
function boxDistance(shapes: readonly FirstLayerShape[], r: Rect): number {
  const pts = rings(shapes).flat()
  const inside = pts.some((p) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h)
  return inside ? 0 : ringDistance(rings(shapes), [[[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]])
}

/** A P1S sized bed and printable area, two filaments, the tower on, no brim or skirt. */
const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
const TOWER: Record<string, SettingValue> = {
  printable_area: ['0x0', '256x0', '256x256', '0x256'],
  enable_prime_tower: true,
  wipe_tower_x: 15,
  wipe_tower_y: 220,
  prime_tower_width: 35,
  prime_tower_brim_width: 3,
  brim_type: 'no_brim',
  skirt_loops: 0,
  enable_support: false,
}

/** An automatic brim with the first layer of a 0.4 mm nozzle and a quick wall speed. */
const AUTO: Record<string, SettingValue> = {
  brim_type: 'auto_brim',
  brim_width: 0,
  brim_object_gap: 0,
  skirt_loops: 0,
  nozzle_diameter: 0.4,
  line_width: 0.42,
  initial_layer_line_width: 0.5,
  initial_layer_print_height: 0.2,
  outer_wall_speed: 120,
  inner_wall_speed: 120,
  filament_type: 'PLA',
}
const SPACING = 0.5 - 0.2 * (1 - Math.PI / 4)
/** The same with fast walls, where a thin standing part gets the widest brim. */
const FAST: Record<string, SettingValue> = { ...AUTO, outer_wall_speed: 300, inner_wall_speed: 300 }

beforeEach(() => {
  setAvoidAreas([])
  setMarginSource(() => NO_MARGINS)
})

describe('the prime tower in arrange', () => {
  it('keeps room for a tower the engine places at the configured spot, pulled onto the bed', () => {
    const m = marginsFor(TOWER, 2)
    expect(m.keepOut).toEqual([])
    // The tower and its 3 mm brim end 1 mm inside the back edge: y = 256 - 1 - 38, then the room is 1 mm more round it.
    expect(m.towerRoom).toEqual([{ x: 11, y: 213, w: 43, h: 43 }])
    expect(marginsFor(TOWER, 1).towerRoom).toEqual([])
    expect(marginsFor({ ...TOWER, enable_prime_tower: false }, 2).towerRoom).toEqual([])
    // A small bed: the configured spot lies past its back, so the room comes forward onto it.
    const mini = marginsFor({ ...TOWER, printable_area: ['0x0', '180x0', '180x180', '0x180'] }, 2).towerRoom![0]!
    expect(mini.y + mini.h).toBeLessThanOrEqual(180)
    expect(mini.y).toBeGreaterThan(130)
  })

  it('keeps a hand placed tower where it stands, at the size the last slice gave it', () => {
    const hand = marginsFor(TOWER, 2, { auto: false, x: 100, y: 50 })
    expect(hand.towerRoom).toEqual([])
    expect(hand.keepOut).toEqual([{ x: 96, y: 46, w: 43, h: 43 }])
    // A wider, shallower tower than prime_tower_width says, as a slice reported it.
    const sliced = marginsFor(TOWER, 2, { auto: true, x: 0, y: 0, size: { width: 60, depth: 20, angle: 0 } })
    expect(sliced.towerRoom).toEqual([{ x: 11, y: 216, w: 68, h: 28 }])
    // A plate skirt runs round the tower too, so the tower stays its loops inside the edge.
    const skirt = marginsFor({ ...TOWER, skirt_loops: 2, skirt_distance: 3, skirt_height: 1, line_width: 0.5 }, 2).towerRoom![0]!
    expect(skirt.y + skirt.h).toBeCloseTo(256 - 1 - 3 - 2 * 0.5 + 1, 6)
  })

  it('a part standing in the room of a tower the engine places still prints there; one on a hand placed tower does not', () => {
    const part = { parts: [block(20, 20, 10)], transform: at(20, 225) }
    expect(printsOnBed(part, BED, marginsFor(TOWER, 2))).toBe(true)
    expect(printsOnBed(part, BED, marginsFor(TOWER, 2, { auto: false, x: 15, y: 217 }))).toBe(false)
  })

  it('arrange keeps the tower room clear on a crowded plate, on true outlines and on boxes', async () => {
    const margins = marginsFor(TOWER, 2)
    const room = margins.towerRoom![0]!
    const items = Array.from({ length: 30 }, (_, i) => nestEntry(`p${i}`, block(38, 30, 10), at(0, 0)))
    const r = await nestArrange(items, [], BED, { gapMm: 6, rotate: false, margins })
    expect(Object.keys(r.transforms).length).toBeGreaterThan(20)
    for (const e of items) {
      const t = r.transforms[e.id]
      if (!t) continue
      expect(boxDistance(await firstLayer(e.parts[0] as MeshPart, t), room)).toBeGreaterThanOrEqual(6 - 1e-3)
    }
    const boxes = arrange(items.map((e) => ({ id: e.id, parts: e.parts, transform: e.transform })), [], BED, { gapMm: 6, rotate: false, margins })
    expect(Object.keys(boxes.transforms).length).toBeGreaterThan(15)
    for (const e of items) {
      const t = boxes.transforms[e.id]
      if (!t) continue
      const b = bounds(e.parts, t)!
      const gap = Math.max(0, room.x - b.max[0], b.min[0] - room.x - room.w, room.y - b.max[1], b.min[1] - room.y - room.h)
      expect(gap).toBeGreaterThanOrEqual(6 - 1e-3)
    }
  })

  it('arrange on the plate keeps room for the tower the engine places when the plate prints in two filaments', async () => {
    installPrintMargins(get)
    setArrangeOptions({ gapMm: 6, rotate: false })
    const entries = Array.from({ length: 24 }, (_, i) => plateEntry(`o${i}`, block(40, 32, 10, (i % 2) + 1), at(100, 100)))
    set({ bed: BED, plate: entries, plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', selection: null, selectedIds: [], tower: { auto: true, x: 0, y: 0 }, slice: { status: 'idle' }, overrides: TOWER })
    const room = printMargins(get()).towerRoom![0]!
    expect(room).toEqual({ x: 11, y: 213, w: 43, h: 43 })
    await arrangePlate('all')
    let placed = 0
    for (const p of get().plate) {
      const b = bounds(p.parts, p.transform)!
      if (b.min[0] < 0 || b.max[0] > 256 || b.min[1] < 0 || b.max[1] > 256) continue
      placed++
      const gap = Math.max(0, room.x - b.max[0], b.min[0] - room.x - room.w, room.y - b.max[1], b.min[1] - room.y - room.h)
      expect(gap).toBeGreaterThanOrEqual(6 - 1e-3)
    }
    expect(placed).toBeGreaterThan(15)
  })
})

describe('the automatic brim in arrange follows the first layer', () => {
  it('a thin fin standing on edge gets the brim of its first layer, in whole pairs of loops', async () => {
    const fin = block(60, 1.6, 40)
    const base = await firstLayer(fin, at(50, 50))
    expect(base).toHaveLength(1)
    const size = printSizeOf(bounds([fin], at(50, 50))!)
    // A rectangle's first layer is its bounds, so the engine's width is the bounds formula without the quarter more.
    const width = autoBrimWidth(AUTO, size) / 1.25
    expect(width).toBeGreaterThan(5)
    const room = autoBrimRoom(AUTO, base, size.height)
    expect(room).toBeCloseTo(2 * Math.floor(width / SPACING / 2) * SPACING, 3)
    expect(marginsFor(AUTO).grow(size, base)).toBeCloseTo(room, 6)
    expect(marginsFor(AUTO).firstLayerMm).toBeCloseTo(0.1, 6)
  })

  it('a tall thin wall that the formula leaves bare still gets the few loops the engine gives it', async () => {
    const slow = { ...AUTO, outer_wall_speed: 30, inner_wall_speed: 30 }
    const fin = block(60, 1.6, 40)
    const base = await firstLayer(fin, at(50, 50))
    const size = printSizeOf(bounds([fin], at(50, 50))!)
    // The bounds estimate prints no brim at all.
    expect(marginsFor(slow).grow(size)).toBe(0)
    expect(marginsFor(slow).grow(size, base)).toBeCloseTo(2 * Math.floor((Math.floor(5 / SPACING / 2) * SPACING * 2) / SPACING / 2) * SPACING, 3)
  })

  it('a curved sliver gets a wider brim than its bounds suggest, and a stem no wider than itself', async () => {
    const arc = crescent(8, 1.2, 40, 120)
    const base = await firstLayer(arc, at(80, 80))
    const size = printSizeOf(bounds([arc], at(80, 80))!)
    // Its first layer has far less area than its bounds, so it tips more easily: a wider brim, in whole pairs of loops.
    const room = marginsFor(FAST).grow(size, base)
    const loops = room / SPACING
    expect(Math.abs(loops - 2 * Math.round(loops / 2))).toBeLessThan(1e-6)
    expect(room).toBeGreaterThan(marginsFor(FAST).grow(size) + 2)
    expect(room).toBeLessThanOrEqual(18)
    // A mushroom: a 4 mm stem under a 30 mm cap. The brim of the stem's island is no wider than the stem.
    const stem = block(4, 4, 40)
    const cap = block(30, 30, 2)
    const mushroom: MeshPart = {
      ...stem,
      positions: new Float32Array([...stem.positions, ...Array.from(cap.positions, (v, i) => (i % 3 === 2 ? v + 40 : v - 13))]),
      indices: new Uint32Array([...stem.indices, ...Array.from(cap.indices, (v) => v + stem.positions.length / 3)]),
    }
    const foot = await firstLayer(mushroom, at(100, 100))
    const top = printSizeOf(bounds([mushroom], at(100, 100))!)
    expect(marginsFor(AUTO).grow(top, foot)).toBeLessThanOrEqual(4 + 1e-6)
  })

  it('arrange keeps thin standing parts apart by the brims their first layers print', async () => {
    const margins = marginsFor(FAST)
    const items = [0, 1, 2, 3].map((i) => nestEntry(`c${i}`, crescent(8, 1.2, 40, 120), at(i * 3, 0)))
    const r = await nestArrange(items, [], BED, { gapMm: 6, rotate: true, margins })
    expect(r.leftOver).toEqual([])
    const placed = await Promise.all(items.map(async (e) => {
      const t = r.transforms[e.id]!
      const base = await firstLayer(e.parts[0] as MeshPart, t)
      return { base, room: margins.grow(printSizeOf(bounds(e.parts, t)!), base) }
    }))
    expect(placed[0]!.room).toBeGreaterThan(12)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!
        const b = placed[j]!
        expect(ringDistance(rings(a.base), rings(b.base))).toBeGreaterThanOrEqual(a.room + b.room + 1 - 0.05)
      }
    }
  })
})
