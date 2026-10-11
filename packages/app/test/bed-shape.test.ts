// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A delta's printable area is a ring of points, not a box. The bed reads it as a circle, and the off-bed check,
// arrange and the pasted-copy placement keep what prints inside the circle rather than its bounding square.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bed } from '@slicerx/contracts'
import { setProfileLayer } from '../src/adapters/config'
import { bedSettings } from '../src/adapters/generic-bed'
import { bedOf } from '../src/adapters/profile'
import { areaOrigin } from '../src/plate/bed-origin'
import { arrange, NO_MARGINS, setAvoidAreas, setMarginSource, type ArrangeItem } from '../src/plate/arrange'
import { bedCircle, boxInBed, circleArea, circleOfArea } from '../src/plate/bed-shape'
import { nearestFreeShift } from '../src/plate/clipboard'
import { bounds, compose, fitsBed, type Box } from '../src/plate/transform'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

afterEach(() => {
  set({ printerModel: null, plate: [] })
  setProfileLayer(null, [])
})

/** The ring Orca writes for a delta: 72 points, as `AxB` text, centered on 0, 0. */
const centered = (diameter: number, points = 72): string[] =>
  Array.from({ length: points }, (_, i) => {
    const a = (i / points) * Math.PI * 2
    return `${((diameter / 2) * Math.cos(a)).toFixed(4)}x${((diameter / 2) * Math.sin(a)).toFixed(4)}`
  })

describe('reading a printable area as a circle', () => {
  it('finds the circle of a ring centered on 0, 0', () => {
    const c = circleOfArea(centered(300))!
    expect(c.cx).toBeCloseTo(0, 2)
    expect(c.cy).toBeCloseTo(0, 2)
    expect(c.r).toBeCloseTo(150, 1)
  })

  it('finds a ring whose box starts at 0, 0, as number pairs', () => {
    const c = circleOfArea(circleArea(250))!
    expect(c.cx).toBeCloseTo(125, 2)
    expect(c.cy).toBeCloseTo(125, 2)
    expect(c.r).toBeCloseTo(125, 1)
  })

  it('leaves rectangles, squares and coarse polygons as rectangles', () => {
    expect(circleOfArea([[0, 0], [256, 0], [256, 256], [0, 256]])).toBeNull()
    expect(circleOfArea(centered(300, 8))).toBeNull()
    expect(circleOfArea(undefined)).toBeNull()
    // Many points on a long rectangle are not a circle either.
    const long = Array.from({ length: 40 }, (_, i) => [i * 10, i % 2 ? 0 : 100])
    expect(circleOfArea(long)).toBeNull()
  })

  it('makes the bed round with the box of the ring, and keeps the origin at its front left', () => {
    const values = { printable_area: centered(300).map((p) => p.split('x').map(Number)), printable_height: 410 }
    const bed = bedOf(values as never)
    expect(bed.round).toBe(true)
    expect(bed.widthMm).toBeCloseTo(300, 1)
    expect(bed.depthMm).toBeCloseTo(300, 1)
    expect(bed.heightMm).toBe(410)
    expect(areaOrigin(values.printable_area)[0]).toBeCloseTo(-150, 1)
    expect(bedOf({ printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]], printable_height: 256 } as never).round).toBeUndefined()
  })

  it('the FLSUN V400 profile gives a 300 mm round bed', async () => {
    set({ printerModel: { vendor: 'FLSUN', model: 'V400' } })
    await profileReady()
    const bed = get().bed
    expect(bed.round).toBe(true)
    expect(bed.widthMm).toBeCloseTo(300, 0)
  })

  it('writes a round bed back as a ring and a rectangle as four corners', () => {
    const ring = bedSettings({ widthMm: 300, depthMm: 300, heightMm: 400, round: true }).printable_area as number[][]
    expect(ring.length).toBe(72)
    expect(circleOfArea(ring)?.r).toBeCloseTo(150, 1)
    expect(bedSettings({ widthMm: 200, depthMm: 100, heightMm: 50 }).printable_area).toEqual([[0, 0], [200, 0], [200, 100], [0, 100]])
  })
})

const round: Bed = { widthMm: 300, depthMm: 300, heightMm: 400, round: true }
const square: Bed = { widthMm: 300, depthMm: 300, heightMm: 400 }
const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ min: [x0, y0, 0], max: [x1, y1, 20] })

describe('the off-bed check on a circular bed', () => {
  it('holds a box when its corners are inside the circle', () => {
    expect(bedCircle(round)).toEqual({ cx: 150, cy: 150, r: 150 })
    expect(bedCircle(square)).toBeNull()
    expect(fitsBed(box(130, 130, 170, 170), round)).toBe(true)
  })

  it('refuses a box that sits in the corner of the square, outside the circle', () => {
    const corner = box(0, 0, 40, 40)
    expect(fitsBed(corner, square)).toBe(true)
    expect(fitsBed(corner, round)).toBe(false)
  })

  it('accepts a box up to the edge of the circle and not past it', () => {
    // Corners at distance 100 * sqrt(2) = 141.4 from the center: inside 150, outside 140.
    expect(boxInBed(round, 50, 50, 250, 250)).toBe(true)
    expect(boxInBed(round, 50, 50, 250, 250, 10)).toBe(false)
    expect(boxInBed(round, 40, 40, 260, 260)).toBe(false)
    // The same boxes on the rectangle only need to be inside it.
    expect(boxInBed(square, 40, 40, 260, 260, 10)).toBe(true)
  })

  it('still limits the height of a round bed', () => {
    expect(fitsBed({ min: [140, 140, 0], max: [160, 160, 401] }, round)).toBe(false)
  })
})

const blockOf = (w: number, d: number): ArrangeItem['parts'] => {
  const p: number[] = []
  for (const x of [-w / 2, w / 2]) for (const y of [-d / 2, d / 2]) for (const z of [0, 20]) p.push(x, y, z)
  return [{ positions: new Float32Array(p) }]
}
const item = (id: string, w: number, d: number): ArrangeItem => ({ id, parts: blockOf(w, d), transform: compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

describe('arrange on a circular bed', () => {
  beforeEach(() => {
    setAvoidAreas([])
    setMarginSource(() => NO_MARGINS)
  })

  it('puts a lone object in the middle', () => {
    const r = arrange([item('a', 40, 40)], [], round)
    const b = bounds(blockOf(40, 40), r.transforms['a']!)!
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(150, 0)
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(150, 0)
  })

  it('keeps every object inside the circle', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`o${i}`, 50, 50))
    const r = arrange(items, [], round, { gapMm: 6, rotate: false })
    expect(r.leftOver).toEqual([])
    for (const it of items) {
      const b = bounds(it.parts, r.transforms[it.id]!)!
      expect(boxInBed(round, b.min[0], b.min[1], b.max[0], b.max[1])).toBe(true)
    }
  })

  it('fits fewer objects than the square bed of the same size', () => {
    const items = Array.from({ length: 16 }, (_, i) => item(`o${i}`, 70, 70))
    const onSquare = arrange(items, [], square, { gapMm: 6, rotate: false })
    const onRound = arrange(items, [], round, { gapMm: 6, rotate: false })
    expect(onSquare.leftOver.length).toBeLessThan(onRound.leftOver.length)
  })

  it('reports an object too large for the circle, though it fits the square', () => {
    // The 220 mm square has a 311 mm diagonal: inside the 300 mm square, outside the 300 mm circle.
    const big = item('big', 220, 220)
    expect(arrange([big], [], square).leftOver).toEqual([])
    const r = arrange([big], [], round)
    expect(r.leftOver).toEqual(['big'])
    expect(r.tooLarge.map((t) => t.id)).toEqual(['big'])
  })
})

describe('placing a copy on a circular bed', () => {
  it('moves a group that started outside the circle to the middle', () => {
    const shift = nearestFreeShift(box(0, 0, 40, 40), [], round)!
    expect(boxInBed(round, 0 + shift[0], 0 + shift[1], 40 + shift[0], 40 + shift[1])).toBe(true)
  })

  it('finds nothing for a group wider than the circle allows', () => {
    expect(nearestFreeShift(box(0, 0, 230, 230), [], round)).toBeNull()
    expect(nearestFreeShift(box(0, 0, 230, 230), [], square)).not.toBeNull()
  })
})
