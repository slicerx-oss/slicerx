// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The landing rule in @slicerx/cad-history (landing.ts), which the app's design host and the creative eval's share,
// over a stub bed: what it asks the bed in which order, and what it decides. (cad-history has no test runner of its
// own; its tests run here.)
import { IDENTITY, landEdit, landNew, landShift, type BedLanding, type Mat4 } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

const at = (x: number, y: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]

/** A stub bed: parts named in `prints` print where they stand; `to` is where a part lands (null: no room). */
function stubBed(prints: readonly string[], to: Mat4 | null): BedLanding<string> & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    printsOnBed(parts, t) {
      asked.push(`prints ${parts} at ${t[12]},${t[13]}`)
      return prints.includes(parts)
    },
    landOnBed(parts, t) {
      asked.push(`land ${parts} at ${t[12]},${t[13]}`)
      return to
    },
  }
}

describe('landShift', () => {
  it('is the move in X and Y, to the hundredth', () => {
    expect(landShift(at(1, 2), at(129.456, -3.001))).toEqual({ dxMm: 128.46, dyMm: -5 })
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
