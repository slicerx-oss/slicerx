// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange all with more objects than one bed holds: the ones with no room go to new plates, laid out by the same nest
// as the shown plate, turns included. Long thin bars standing at an angle show the difference: the nest turns them
// flat and fits about a dozen on a bed, while boxes around the angled bars fit two. Before, the new plates used the
// box packer, so the same bars spread over many more plates. On a new plate the nest sets the layout in the middle of
// the bed, as Move to plate sets a group (placeOnPlate), unless the middle is blocked. Runs the real engine when it is built, else replies
// recorded from it (test/geom-engine.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { setAvoidAreas } from '../src/plate/arrange'
import { arrangePlate, setArrangeOptions } from '../src/plate/edit'
import { installPrintMargins } from '../src/plate/footprint'
import { history } from '../src/plate/history'
import { compose, type Mat4 } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('arrange-overflow-nest')

const BED = { widthMm: 100, depthMm: 100, heightMm: 50 }
const LEN = 80
const WIDTH = 6
const GAP = 2

/** A bar `LEN` by `WIDTH` mm and 5 mm tall, its corner at the origin, as one closed mesh. */
function bar(): MeshPart {
  const positions: number[] = []
  for (const z of [0, 5]) for (const [x, y] of [[0, 0], [LEN, 0], [LEN, WIDTH], [0, WIDTH]] as const) positions.push(x, y, z)
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  return { name: 'bar', slot: 1, positions: new Float32Array(positions), indices: new Uint32Array(quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])) }
}

/** `n` bars turned 30 degrees, overlapping near the middle of the bed as a careless import leaves them. */
function bars(n: number): PlateEntry[] {
  const part = bar()
  return Array.from({ length: n }, (_, k) => {
    const id = `bar${k + 1}`
    const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [LEN, WIDTH, 5], openEdges: 0, parts: [] } as MeshHandle
    const transform: Mat4 = compose({ position: [10 + k, 20 + k, 0], rotation: [0, 0, 30], scale: [1, 1, 1] })
    return { id, name: `Bar ${k + 1}`, handle, parts: [part], colors: ['#bd93f9'], transform }
  })
}

/** `n` cubes of `s` mm, overlapping near the front left corner. */
function cubes(n: number, s: number): PlateEntry[] {
  const positions: number[] = []
  for (const z of [0, s]) for (const [x, y] of [[0, 0], [s, 0], [s, s], [0, s]] as const) positions.push(x, y, z)
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const part: MeshPart = { name: 'cube', slot: 1, positions: new Float32Array(positions), indices: new Uint32Array(quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])) }
  return Array.from({ length: n }, (_, k) => {
    const id = `cube${k + 1}`
    const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [s, s, s], openEdges: 0, parts: [] } as MeshHandle
    return { id, name: `Cube ${k + 1}`, handle, parts: [part], colors: ['#bd93f9'], transform: compose({ position: [5 + k, 5 + k, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  })
}

/** The box round a plate's cubes of `s` mm. */
function around(objects: readonly PlateEntry[], s: number) {
  const xs = objects.map((e) => e.transform[12]!)
  const ys = objects.map((e) => e.transform[13]!)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs) + s, y1: Math.max(...ys) + s }
}

type Pt = [number, number]

/** The bar's footprint corners on the bed. */
function corners(e: PlateEntry): Pt[] {
  const t = e.transform
  return ([[0, 0], [LEN, 0], [LEN, WIDTH], [0, WIDTH]] as const).map(([x, y]) => [t[0]! * x + t[4]! * y + t[12]!, t[1]! * x + t[5]! * y + t[13]!])
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

/** Each plate's objects, the shown plate's from `plate`. */
const platesNow = () => get().plates.map((p) => (p.id === get().activePlate ? get().plate : p.objects))

describe('arrange all moves what does not fit to new plates laid out by the nest', () => {
  beforeEach(() => {
    setAvoidAreas([])
    installPrintMargins(get)
    setArrangeOptions({ gapMm: GAP, rotate: true, stepDeg: 10 })
    set({ bed: BED, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', plate: [], selection: null, selectedIds: [], toast: null, overrides: { brim_type: 'no_brim', skirt_loops: 0, enable_support: false } })
    history().clear()
  })

  it('24 angled bars: the overflow plate holds as many as the nest fits, none lost or off the bed', { timeout: 120_000 }, async () => {
    const start = bars(24)
    set({ plate: start })
    history().clear()
    const left = await arrangePlate('all')
    const plates = platesNow()
    const first = plates[0]!.length
    // The nest turns the bars flat: far more than the two angled bars a box packer fits.
    expect(first).toBeGreaterThanOrEqual(10)
    // The rest fit on one new plate, as they would on the shown one; the box packer needed several.
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2'])
    expect(left).toBe(24 - first)
    expect(plates[1]!.length).toBe(24 - first)
    // Every bar is on exactly one plate.
    expect(plates.flat().map((e) => e.id).sort()).toEqual(start.map((e) => e.id).sort())
    for (const objects of plates) {
      for (const e of objects) for (const [x, y] of corners(e)) {
        expect(x).toBeGreaterThanOrEqual(-1e-3)
        expect(y).toBeGreaterThanOrEqual(-1e-3)
        expect(x).toBeLessThanOrEqual(BED.widthMm + 1e-3)
        expect(y).toBeLessThanOrEqual(BED.depthMm + 1e-3)
      }
      for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++) expect(separation(corners(objects[i]!), corners(objects[j]!))).toBeGreaterThanOrEqual(GAP - 1e-2)
    }
    // At least one bar on the new plate was turned out of its 30 degree start, as the nest turns them on the shown plate.
    const angle = (e: PlateEntry) => Math.round((Math.atan2(e.transform[1]!, e.transform[0]!) * 180) / Math.PI)
    expect(plates[1]!.some((e) => angle(e) !== 30)).toBe(true)
    // One undo puts every bar back on one plate where it was.
    expect(history().undo()).toBe(true)
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1'])
    expect(get().plate.map((e) => [e.id, e.transform[12], e.transform[13]])).toEqual(start.map((e) => [e.id, e.transform[12], e.transform[13]]))
  })

  it('sets the cube moved to a new plate in the middle of the bed', { timeout: 60_000 }, async () => {
    // Four 40 mm cubes fill the bed; the fifth goes to Plate 2 on its own.
    set({ plate: cubes(5, 40) })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    const plates = platesNow()
    expect(plates.map((p) => p.length)).toEqual([4, 1])
    const b = around(plates[1]!, 40)
    expect((b.x0 + b.x1) / 2).toBeCloseTo(BED.widthMm / 2, 3)
    expect((b.y0 + b.y1) / 2).toBeCloseTo(BED.depthMm / 2, 3)
  })

  it('keeps the cubes on the last new plate where the nest put them when the middle of the bed is an excluded area', { timeout: 60_000 }, async () => {
    const zone = { x: 45, y: 45, w: 10, h: 10 }
    setAvoidAreas([zone])
    set({ plate: cubes(10, 30) })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    const plates = platesNow()
    const last = plates.at(-1)!
    expect(plates.length).toBeGreaterThan(1)
    expect(plates.flat()).toHaveLength(10)
    // packed from the front left corner, as the nest packs them, and none on the excluded area
    const b = around(last, 30)
    expect(b.x0).toBeCloseTo(b.y0, 3)
    expect((b.x0 + b.x1) / 2).toBeLessThan(BED.widthMm / 2 - 1)
    for (const e of last) {
      const [x, y] = [e.transform[12]!, e.transform[13]!]
      expect(x + 30 <= zone.x || x >= zone.x + zone.w || y + 30 <= zone.y || y >= zone.y + zone.h).toBe(true)
    }
  })
})
