// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The landing rule in @slicerx/cad-history (landing.ts), which the app's design host and the creative eval's share,
// over a stub bed: what it asks the bed in which order, and what it decides, and the landing moves a design keeps
// (design-frame.ts), lift included. (cad-history has no test runner of its own; its tests run here.)
import { designFrame, IDENTITY, landEdit, landNew, landShift, movedBy, placedAfter, storedToDesign, withPlaced, type BedLanding, type History, type Mat4 } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const at = (x: number, y: number, z = 0): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

/**
 * A stub bed: parts named in `prints` print where they stand when their lowest point is not under the bed; `to` is
 * where a part lands (null: no room), at the height it was given, as the hosts' beds land one. `lows` is each part's
 * lowest point in its own frame, 0 when not named.
 */
function stubBed(prints: readonly string[], to: Mat4 | null, lows: Record<string, number> = {}): BedLanding<string> & { asked: string[] } {
  const asked: string[] = []
  const lowest = (parts: string, t: Mat4) => (lows[parts] ?? 0) + t[14]!
  return {
    asked,
    printsOnBed(parts, t) {
      asked.push(`prints ${parts} at ${t[12]},${t[13]}`)
      return prints.includes(parts) && lowest(parts, t) >= -0.01
    },
    landOnBed(parts, t) {
      asked.push(`land ${parts} at ${t[12]},${t[13]}`)
      return to && at(to[12]!, to[13]!, t[14])
    },
    lowest,
  }
}

describe('landShift', () => {
  it('is the move in X and Y, to the hundredth', () => {
    expect(landShift(at(1, 2), at(129.456, -3.001))).toEqual({ dxMm: 128.46, dyMm: -5 })
  })

  it('has the lift in Z when there is one', () => {
    expect(landShift(at(1, 2, -10), at(1, 2, 0.004))).toEqual({ dxMm: 0, dyMm: 0, dzMm: 10 })
  })
})

describe('landNew', () => {
  it('leaves a body that prints where it was built, and does not look for a spot', () => {
    const bed = stubBed(['body'], at(9, 9))
    const t = at(10, 20)
    const r = landNew('body', t, bed)
    expect(r).toEqual({ transform: t })
    expect(r.transform).not.toBe(t)
    expect(bed.asked).toEqual(['prints body at 10,20'])
  })

  it('moves a body that does not print there to where the bed lands it, and says how far', () => {
    const bed = stubBed([], at(128, 100))
    expect(landNew('body', at(-50, -20), bed)).toEqual({ transform: at(128, 100), moved: { dxMm: 178, dyMm: 120 } })
    expect(bed.asked).toEqual(['prints body at -50,-20', 'land body at -50,-20'])
  })

  it('leaves a body with no room anywhere where it was built, and says so', () => {
    expect(landNew('body', at(-50, 0), stubBed([], null))).toEqual({ transform: at(-50, 0), moved: { offBed: true } })
  })
})

describe('landNew of a body under the bed', () => {
  it('lifts a part built centered on z 0 that stands on the bed in X and Y, and says how far', () => {
    const bed = stubBed(['body'], at(9, 9), { body: -10 })
    expect(landNew('body', at(118, 128), bed)).toEqual({ transform: at(118, 128, 10), moved: { dxMm: 0, dyMm: 0, dzMm: 10 } })
    expect(bed.asked).toEqual(['prints body at 118,128'])
  })

  it('lifts a part built 28 mm under the bed and off it, then moves it onto the bed', () => {
    const bed = stubBed([], at(128, 100), { body: -28 })
    expect(landNew('body', at(-50, -20), bed)).toEqual({ transform: at(128, 100, 28), moved: { dxMm: 178, dyMm: 120, dzMm: 28 } })
    expect(bed.asked).toEqual(['prints body at -50,-20', 'land body at -50,-20'])
  })

  it('lifts an arc that dips 0.118 mm under the body onto the bed', () => {
    const r = landNew('body', at(128, 128), stubBed(['body'], null, { body: -0.118 }))
    expect(r.transform[14]).toBe(0.118)
    expect(r.moved).toEqual({ dxMm: 0, dyMm: 0, dzMm: 0.12 })
  })

  it('leaves a part 0.01 mm or less under the bed where it was built', () => {
    expect(landNew('body', at(128, 128), stubBed(['body'], null, { body: -0.01 }))).toEqual({ transform: at(128, 128) })
  })

  it('never lowers a part built standing above the bed', () => {
    expect(landNew('body', at(128, 128, 5), stubBed(['body'], at(0, 0), { body: 0 }))).toEqual({ transform: at(128, 128, 5) })
  })

  it('leaves a part with no room anywhere where it was built, not lifted', () => {
    expect(landNew('body', at(-50, 0), stubBed([], null, { body: -10 }))).toEqual({ transform: at(-50, 0), moved: { offBed: true } })
  })
})

describe('landEdit', () => {
  it('keeps a part that still prints where it stands', () => {
    const bed = stubBed(['new'], at(0, 0))
    expect(landEdit({ parts: 'old', transform: at(5, 5) }, 'new', bed)).toEqual({})
    expect(bed.asked).toEqual(['prints new at 5,5'])
  })

  it('lands a part the edit took off the bed again, and says it was the edit', () => {
    const bed = stubBed(['old'], at(100, 5))
    expect(landEdit({ parts: 'old', transform: at(5, 5) }, 'new', bed)).toEqual({ to: at(100, 5), landed: { dxMm: 95, dyMm: 0, edit: true } })
    expect(bed.asked).toEqual(['prints new at 5,5', 'prints old at 5,5', 'land new at 5,5'])
  })

  it('leaves a part that was off the bed before the edit parked there', () => {
    const bed = stubBed([], at(100, 5))
    expect(landEdit({ parts: 'old', transform: at(-90, 5) }, 'new', bed)).toEqual({ landed: { offBed: true, edit: true, parked: true } })
    expect(bed.asked).toEqual(['prints new at -90,5', 'prints old at -90,5'])
  })

  it('leaves a locked part, and says it is locked', () => {
    const bed = stubBed(['old'], at(100, 5))
    expect(landEdit({ parts: 'old', transform: at(5, 5), locked: true }, 'new', bed)).toEqual({ landed: { offBed: true, edit: true, locked: true } })
    expect(bed.asked).not.toContain('land new at 5,5')
  })

  it('says a part the edit took off the bed has no room anywhere', () => {
    expect(landEdit({ parts: 'old', transform: [...IDENTITY] }, 'new', stubBed(['old'], null))).toEqual({ landed: { offBed: true, edit: true } })
  })
})

describe('landEdit of a part under the bed', () => {
  it('lifts a part saved under the bed at its first edit', () => {
    const bed = stubBed(['old', 'new'], null, { old: -10, new: -10 })
    expect(landEdit({ parts: 'old', transform: at(128, 128) }, 'new', bed)).toEqual({ to: at(128, 128, 10), landed: { dxMm: 0, dyMm: 0, dzMm: 10, edit: true } })
  })

  it('lifts a part an edit took under the bed', () => {
    const bed = stubBed(['old', 'new'], null, { new: -3 })
    expect(landEdit({ parts: 'old', transform: at(128, 128) }, 'new', bed)).toEqual({ to: at(128, 128, 3), landed: { dxMm: 0, dyMm: 0, dzMm: 3, edit: true } })
  })

  it('lifts and moves a part an edit took under the bed and off it', () => {
    const bed = stubBed(['old'], at(100, 5), { new: -4 })
    expect(landEdit({ parts: 'old', transform: at(5, 5) }, 'new', bed)).toEqual({ to: at(100, 5, 4), landed: { dxMm: 95, dyMm: 0, dzMm: 4, edit: true } })
  })

  it('never lowers a part that stands above the bed', () => {
    expect(landEdit({ parts: 'old', transform: at(128, 128, 5) }, 'new', stubBed(['old', 'new'], null))).toEqual({})
  })

  it('leaves a locked part under the bed where it is', () => {
    const bed = stubBed(['old', 'new'], null, { old: -10, new: -10 })
    expect(landEdit({ parts: 'old', transform: at(128, 128), locked: true }, 'new', bed)).toEqual({ landed: { offBed: true, edit: true, locked: true } })
  })

  it('leaves a part under the bed and off it parked where it is', () => {
    const bed = stubBed([], at(100, 5), { old: -10, new: -10 })
    expect(landEdit({ parts: 'old', transform: at(-90, 5) }, 'new', bed)).toEqual({ landed: { offBed: true, edit: true, parked: true } })
  })
})

describe('landing moves with a lift', () => {
  const h: History = { version: 1, base: [], steps: [] }

  it('keep the lift after a move, and two numbers when there is none', () => {
    expect(placedAfter([128, 128], at(128, 128), at(128, 128, 10))).toEqual([128, 128, 10])
    expect(placedAfter(undefined, at(5, 5), at(100, 5))).toEqual([95, 0])
    expect(placedAfter([128, 128, 10], at(128, 128, 10), at(0, 0, 0))).toBeUndefined()
    expect(withPlaced(h, [128, 128, 0]).placed).toEqual([128, 128])
    expect(withPlaced(h, [0, 0, 0.118]).placed).toEqual([0, 0, 0.118])
    expect(withPlaced(h, [0, 0, 0])).not.toHaveProperty('placed')
  })

  it('move the design frame back down by the lift', () => {
    expect(designFrame(at(128, 128, 10), { placed: [128, 128, 10] })).toEqual(at(0, 0, 0))
    expect(designFrame(at(128, 128), { placed: [128, 128] })).toEqual(at(0, 0, 0))
    expect(movedBy(at(0, 0), [128, 128, 10])).toEqual(at(128, 128, 10))
    expect(storedToDesign(at(0, 0), [128, 128, 10])).toEqual(at(-128, -128, -10))
  })
})
