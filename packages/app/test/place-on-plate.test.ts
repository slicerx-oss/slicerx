// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where objects moved to another plate land (placeOnPlate): in the middle of an empty plate, as one group, the way the
// MCP project lays out a plate; around what a plate already holds, with no overlap; and where arrange puts them when
// the middle is taken by an excluded area, or when a skirt round the whole print would cross one from there. Move to
// plate, plate edge drag, the app link's plate move and Arrange's new plates all use it.
import { afterEach, describe, expect, it } from 'vitest'
import { ARRANGE_DEFAULTS, arrange, NO_MARGINS, placeOnPlate, setAvoidAreas, type ArrangeItem, type PrintMargins } from '../src/plate/arrange'
import { bounds, compose } from '../src/plate/transform'

const BED = { widthMm: 180, depthMm: 180, heightMm: 180 }

/** A `w` x `d` x 10 mm box with its footprint's corner at (x, y). */
function box(id: string, x: number, y: number, w = 20, d = 20): ArrangeItem {
  const p: number[] = []
  for (const px of [0, w]) for (const py of [0, d]) for (const pz of [0, 10]) p.push(px, py, pz)
  return { id, parts: [{ positions: new Float32Array(p) }], transform: compose({ position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

const opts = (margins: PrintMargins = NO_MARGINS) => ({ ...ARRANGE_DEFAULTS, margins })
const footprint = (it: ArrangeItem, t: number[]) => {
  const b = bounds(it.parts, t)!
  return { x0: b.min[0], y0: b.min[1], x1: b.max[0], y1: b.max[1] }
}
const overlaps = (a: ReturnType<typeof footprint>, b: ReturnType<typeof footprint>) => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6

afterEach(() => setAvoidAreas([]))

describe('placeOnPlate', () => {
  it('sets one part in the middle of an empty plate, keeping its height', () => {
    const part = box('a', 80, 80)
    part.transform[14] = 3
    const r = placeOnPlate([part], [], BED, opts())
    expect(r.leftOver).toEqual([])
    const f = footprint(part, r.transforms['a']!)
    expect([(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2]).toEqual([90, 90])
    expect(r.transforms['a']![14]).toBe(3)
  })

  it('sets a group in the middle of an empty plate as arrange spaced it', () => {
    const parts = [box('a', 10, 10), box('b', 140, 140, 30, 20)]
    const packed = arrange(parts, [], BED, opts())
    const r = placeOnPlate(parts, [], BED, opts())
    const feet = parts.map((p) => footprint(p, r.transforms[p.id]!))
    const all = { x0: Math.min(...feet.map((f) => f.x0)), y0: Math.min(...feet.map((f) => f.y0)), x1: Math.max(...feet.map((f) => f.x1)), y1: Math.max(...feet.map((f) => f.y1)) }
    expect((all.x0 + all.x1) / 2).toBeCloseTo(90, 6)
    expect((all.y0 + all.y1) / 2).toBeCloseTo(90, 6)
    expect(overlaps(feet[0]!, feet[1]!)).toBe(false)
    // the same spacing as arrange gave, moved as one
    const shift = (id: string) => [r.transforms[id]![12]! - packed.transforms[id]![12]!, r.transforms[id]![13]! - packed.transforms[id]![13]!]
    expect(shift('a')[0]).toBeCloseTo(shift('b')[0]!, 6)
    expect(shift('a')[1]).toBeCloseTo(shift('b')[1]!, 6)
  })

  it('places a part around what a plate holds, with no overlap, as arrange does', () => {
    const there = box('z', 80, 80)
    const part = box('a', 80, 80)
    const r = placeOnPlate([part], [there], BED, opts())
    expect(r).toEqual(arrange([part], [there], BED, opts()))
    expect(overlaps(footprint(part, r.transforms['a']!), footprint(there, there.transform))).toBe(false)
  })

  it('keeps room for what prints around the part, and stays where arrange put it when the middle is an excluded area', () => {
    const brim: PrintMargins = { ...NO_MARGINS, grow: () => 5, reach: () => 8 }
    const part = box('a', 0, 0)
    const centered = footprint(part, placeOnPlate([part], [], BED, opts(brim)).transforms['a']!)
    expect([centered.x0, centered.y0]).toEqual([80, 80])
    setAvoidAreas([{ x: 70, y: 70, w: 40, h: 40 }])
    const r = placeOnPlate([part], [], BED, opts(brim))
    expect(r).toEqual(arrange([part], [], BED, opts(brim)))
    expect(footprint(part, r.transforms['a']!).x0).toBeLessThan(70)
  })

  it('stays where arrange put it when a skirt round the whole print would cross an excluded area from the middle', () => {
    // A hand placed prime tower in the front left corner, which the skirt goes round too, and an excluded area on the
    // way from it to the middle of the bed, clear of the centered part itself.
    const tower = { x: 10, y: 10, w: 20, h: 20 }
    const skirt: PrintMargins = { ...NO_MARGINS, reach: () => 3, skirt: true, keepOut: [tower] }
    const part = box('a', 0, 0)
    setAvoidAreas([{ x: 50, y: 50, w: 10, h: 10 }])
    // Without a skirt round the whole print the middle is clear, so the part goes there.
    const alone = footprint(part, placeOnPlate([part], [], BED, opts({ ...skirt, skirt: false })).transforms['a']!)
    expect([alone.x0, alone.y0]).toEqual([80, 80])
    // With one, its hull from the tower to the part in the middle crosses the excluded area: arrange's spot is kept.
    const r = placeOnPlate([part], [], BED, opts(skirt))
    expect(r).toEqual(arrange([part], [], BED, opts(skirt)))
    const f = footprint(part, r.transforms['a']!)
    expect(f.x1 < 50 || f.y1 < 50).toBe(true)
  })
})
