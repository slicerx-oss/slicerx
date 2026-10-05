// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange and fill the bed on true outlines (src/plate/nest.ts on sx-geom's nest): outlines keep their
// holes and inner corners, parts tuck into each other at any turn, brims and skirts keep their room,
// fixed objects, excluded areas and the prime tower stay clear, and the same plate gives the same layout.
// Runs the real engine when it is built, else replies recorded from it (test/geom-engine.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart, SettingValue } from '@slicerx/contracts'
import { arrange, fillCount, NO_MARGINS, setAvoidAreas, setMarginSource } from '../src/plate/arrange'
import { arrangePlate, fillBed, setArrangeOptions } from '../src/plate/edit'
import { installPrintMargins, marginsFor } from '../src/plate/footprint'
import { nestArrange, nestFill, outlineOf, type NestEntry } from '../src/plate/nest'
import { bounds, compose, type Mat4 } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('nest-replies')

const at = (x: number, y: number, deg = 0): Mat4 => compose({ position: [x, y, 0], rotation: [0, 0, deg], scale: [1, 1, 1] })

/** Boxes [x0, y0, x1, y1] in the object's own coordinates, 5 mm tall, as one closed mesh each. */
function boxes(list: [number, number, number, number][]): MeshPart {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, x1, y1] of list) {
    const base = positions.length / 3
    for (const z of [0, 5]) for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) positions.push(x, y, z)
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    for (const [a, b, c, d] of quads) indices.push(base + a!, base + b!, base + c!, base + a!, base + c!, base + d!)
  }
  return { name: 'p', slot: 1, positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** An L, legs `len` long and `w` wide, its corner at the origin. */
const ell = (len: number, w: number) => boxes([[0, 0, len, w], [0, w, w, len]])
/** A square frame `size` across with walls `wall` thick. */
const frame = (size: number, wall: number) => boxes([[0, 0, size, wall], [0, size - wall, size, size], [0, wall, wall, size - wall], [size - wall, wall, size, size - wall]])

const nestEntry = (id: string, part: MeshPart, t: Mat4): NestEntry => ({ id, parts: [part], transform: t })

function plateEntry(id: string, part: MeshPart, t: Mat4): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: part.indices.length / 3, bboxMm: [0, 0, 5], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: [part], colors: ['#bd93f9'], transform: t }
}

type Box = { x0: number; y0: number; x1: number; y1: number }

/** The boxes of an entry's mesh, moved by its transform. Each box is one closed block of 8 vertices. */
function placedBoxes(part: MeshPart, t: Mat4): Box[] {
  const out: Box[] = []
  for (let k = 0; k < part.positions.length / 24; k++) {
    const xs: number[] = []
    const ys: number[] = []
    for (let v = 0; v < 8; v++) {
      const i = (k * 8 + v) * 3
      const x = part.positions[i]!
      const y = part.positions[i + 1]!
      xs.push(t[0]! * x + t[4]! * y + t[12]!)
      ys.push(t[1]! * x + t[5]! * y + t[13]!)
    }
    out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) })
  }
  return out
}

/** Distance between two axis aligned boxes, 0 when they touch or overlap. */
const gapOf = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1))

beforeEach(() => {
  setAvoidAreas([])
  setMarginSource(() => NO_MARGINS)
})

describe('true shape nesting', () => {
  it('the outline of an L keeps its inner corner', async () => {
    const out = (await outlineOf(nestEntry('l', ell(60, 12), at(100, 50)))).polygons
    expect(out).toHaveLength(1)
    const xs = out[0]!.outer.map((p) => p[0])
    expect(Math.min(...xs)).toBeCloseTo(100, 0)
    // An L has six corners; its bounds would have four.
    expect(out[0]!.outer.length).toBeGreaterThanOrEqual(6)
    expect(out[0]!.holes).toEqual([])
  })

  it('two Ls tuck into each other on a bed too small for their boxes, with the gap kept', async () => {
    const bed = { widthMm: 84, depthMm: 84, heightMm: 50 }
    const opts = { gapMm: 2, rotate: true, stepDeg: 10, margins: NO_MARGINS }
    const items = [nestEntry('a', ell(60, 12), at(0, 0)), nestEntry('b', ell(60, 12), at(100, 100))]
    expect(arrange(items, [], bed, { gapMm: 2, rotate: true }).leftOver).toHaveLength(1)
    const r = await nestArrange(items, [], bed, opts)
    expect(r.leftOver).toEqual([])
    const a = placedBoxes(items[0]!.parts[0] as MeshPart, r.transforms['a']!)
    const b = placedBoxes(items[1]!.parts[0] as MeshPart, r.transforms['b']!)
    for (const x of [...a, ...b]) {
      expect(x.x0).toBeGreaterThanOrEqual(2 - 1e-3)
      expect(x.y1).toBeLessThanOrEqual(82 + 1e-3)
    }
    for (const x of a) for (const y of b) expect(gapOf(x, y)).toBeGreaterThanOrEqual(2 - 1e-3)
  })

  it('a small part goes inside a frame that leaves no room around it', async () => {
    const bed = { widthMm: 106, depthMm: 106, heightMm: 50 }
    const items = [nestEntry('frame', frame(100, 10), at(0, 0)), nestEntry('block', boxes([[0, 0, 30, 20]]), at(150, 0))]
    const r = await nestArrange(items, [], bed, { gapMm: 3, rotate: true, stepDeg: 15, margins: NO_MARGINS })
    expect(r.leftOver).toEqual([])
    const [blk] = placedBoxes(items[1]!.parts[0] as MeshPart, r.transforms['block']!)
    expect(blk!.x0).toBeGreaterThanOrEqual(13 - 1e-3)
    expect(blk!.x1).toBeLessThanOrEqual(93 + 1e-3)
  })

  it('brims and the skirt keep their room from each other and the bed edge', async () => {
    const BRIM: Record<string, SettingValue> = { brim_type: 'outer_only', brim_width: 6, skirt_loops: 1, skirt_distance: 3, line_width: 0.42, nozzle_diameter: 0.4 }
    const margins = marginsFor(BRIM)
    const bed = { widthMm: 140, depthMm: 140, heightMm: 50 }
    const items = ['a', 'b', 'c', 'd'].map((id, i) => nestEntry(id, boxes([[0, 0, 30, 30]]), at(i * 5, 0)))
    const r = await nestArrange(items, [], bed, { gapMm: 3, rotate: true, margins })
    expect(r.leftOver).toEqual([])
    const placed = items.map((e) => placedBoxes(e.parts[0] as MeshPart, r.transforms[e.id]!)[0]!)
    const reach = margins.reach({ w: 30, h: 30, height: 5 })
    for (const p of placed) {
      expect(p.x0).toBeGreaterThanOrEqual(reach + 1 - 1e-3)
      expect(p.x1).toBeLessThanOrEqual(140 - reach - 1 + 1e-3)
    }
    // two 6 mm brims and the 1 mm safety between parts
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(gapOf(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(13 - 1e-3)
  })

  it('stays clear of a fixed object, an excluded area and the prime tower', async () => {
    const tower = { x: 150, y: 150, w: 40, h: 40 }
    setAvoidAreas([{ x: 0, y: 0, w: 60, h: 60 }])
    setMarginSource(() => ({ ...NO_MARGINS, keepOut: [tower] }))
    const bed = { widthMm: 200, depthMm: 200, heightMm: 50 }
    const fixed = [nestEntry('f', boxes([[0, 0, 40, 40]]), at(80, 80))]
    const items = Array.from({ length: 10 }, (_, i) => nestEntry(`p${i}`, ell(30, 8), at(0, 0)))
    const r = await nestArrange(items, fixed, bed, { gapMm: 3, rotate: true })
    expect(r.leftOver).toEqual([])
    const blocks = [{ x0: 80, y0: 80, x1: 120, y1: 120 }, { x0: 0, y0: 0, x1: 60, y1: 60 }, { x0: 150, y0: 150, x1: 190, y1: 190 }]
    for (const e of items) for (const b of placedBoxes(e.parts[0] as MeshPart, r.transforms[e.id]!)) for (const k of blocks) expect(gapOf(b, k)).toBeGreaterThanOrEqual(3 - 1e-3)
  })

  it('printing by object keeps the extruder clearance between parts, and the bed edge only the gap', async () => {
    const margins = marginsFor({ print_sequence: 'by object', extruder_clearance_radius: 40 })
    expect(margins.apart).toBeGreaterThanOrEqual(40)
    const bed = { widthMm: 256, depthMm: 256, heightMm: 50 }
    const items = ['a', 'b'].map((id, i) => nestEntry(id, boxes([[0, 0, 20, 20]]), at(i * 25, 0)))
    const r = await nestArrange(items, [], bed, { gapMm: 6, rotate: true, margins })
    expect(r.leftOver).toEqual([])
    const [a, b] = items.map((e) => placedBoxes(e.parts[0] as MeshPart, r.transforms[e.id]!)[0]!)
    expect(gapOf(a!, b!)).toBeGreaterThanOrEqual(40 - 1e-3)
  })

  it('fill the bed nests more Ls than boxes would hold', async () => {
    const bed = { widthMm: 150, depthMm: 150, heightMm: 50 }
    const src = nestEntry('l', ell(40, 10), at(20, 20))
    const asBoxes = fillCount(src, [], bed, { gapMm: 2, rotate: true, margins: NO_MARGINS })
    const f = await nestFill(src, [src], bed, { gapMm: 2, rotate: true, margins: NO_MARGINS }, 100)
    expect(f.transforms.length).toBeGreaterThan(asBoxes)
    const all = [src.transform, ...f.transforms].flatMap((t) => placedBoxes(src.parts[0] as MeshPart, t).map((b) => ({ b, t })))
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (all[i]!.t !== all[j]!.t) expect(gapOf(all[i]!.b, all[j]!.b)).toBeGreaterThanOrEqual(2 - 1e-3)
  })

  it('the same plate gives the same layout every time', async () => {
    const bed = { widthMm: 180, depthMm: 180, heightMm: 50 }
    const mk = () => [ell(50, 12), ell(40, 10), frame(60, 8), boxes([[0, 0, 20, 30]]), ell(30, 8)].map((p, i) => nestEntry(`o${i}`, p, at(10 * i, 0)))
    const a = await nestArrange(mk(), [], bed, { gapMm: 3, rotate: true, margins: NO_MARGINS })
    const b = await nestArrange(mk(), [], bed, { gapMm: 3, rotate: true, margins: NO_MARGINS })
    expect(b.transforms).toEqual(a.transforms)
  })
})

describe('arrange and fill the bed in the app', () => {
  beforeEach(() => {
    installPrintMargins(get)
    setArrangeOptions({ gapMm: 2, rotate: true, stepDeg: 10 })
    set({ bed: { widthMm: 84, depthMm: 84, heightMm: 50 }, plate: [], plates: [], selection: null, selectedIds: [], overrides: { brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
  })

  it('arrange all nests what boxes could not fit', async () => {
    set({ plate: [plateEntry('a', ell(60, 12), at(10, 10)), plateEntry('b', ell(60, 12), at(20, 20))] })
    expect(await arrangePlate('all')).toBe(0)
    const [a, b] = get().plate
    for (const x of placedBoxes(a!.parts[0]!, a!.transform)) for (const y of placedBoxes(b!.parts[0]!, b!.transform)) expect(gapOf(x, y)).toBeGreaterThanOrEqual(2 - 1e-3)
    for (const p of get().plate) {
      const bb = bounds(p.parts, p.transform)!
      expect(bb.min[0]).toBeGreaterThanOrEqual(2 - 1e-3)
      expect(bb.max[1]).toBeLessThanOrEqual(82 + 1e-3)
    }
  })

  it('fill the bed adds copies as instances, clear of each other', async () => {
    set({ bed: { widthMm: 120, depthMm: 120, heightMm: 50 }, plate: [plateEntry('s', ell(40, 10), at(10, 10))], selection: 's', selectedIds: ['s'] })
    const n = await fillBed('s')
    expect(n).toBeGreaterThan(4)
    const plate = get().plate
    expect(plate).toHaveLength(n + 1)
    expect(plate.slice(1).every((p) => p.instanceOf === 's')).toBe(true)
  })
})
