// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part sunk into what it stands on is told its exact fix, as a part on the top whose height is off is: the height to
// make it from its base, so its planned height shows above the top, or the move onto the top with its planned height.
// A ship's fix round raised a forecastle deck sunk 0.61 mm into the hull to 3 mm, guessing, when 2.61 mm was needed,
// and its second check failed it again. Each fix the failure names passes the check once made.
import { describe, expect, it } from 'vitest'
import { STANDS_OFF, stackItem, type FeatureHeights } from '../src/plan-detail'

// a hull whose top is 12 mm flat to x 180 and rises toward the bow; the forecastle deck from x 183 to 205 stands where it
// is 12.61 mm at its lowest
const deck = { axis: 'x' as const, at: [[0, 12], [180, 12], [183, 12.61], [200, 13.5], [215, 14.5]] as [number, number][] }
const hull = { lo: 0, hi: 14.5, deck, foot: { x: [0, 215] as [number, number], y: [-11.3, 11.3] as [number, number] } }
const plan = { detail: 'display' as const, features: [{ name: 'Hull', sizes: {} }, { name: 'Forecastle deck', sizes: { height: 2 }, on: 'Hull' }] }
const forecastle = (lo: number, hi: number, x: [number, number] = [183, 205]): FeatureHeights => ({ hull, 'forecastle deck': { lo, hi, foot: { x, y: [-6.5, 6.5] } } })

describe('a part sunk into its support is told its exact fix', () => {
  it('inside the support: the height to make it from its base, or the move with its planned height, word for word', () => {
    const r = stackItem(plan, forecastle(12, 15))!
    expect(r.pass).toBe(false)
    expect(r.got).toBe(
      'Forecastle deck stands on Hull, but its base is 0.61 mm below its top, so 2.39 mm of it shows of a planned 2 mm; make it 2.61 mm tall from its base at z 12, so 2 mm shows above the top of Hull, whose lowest point under it is at z 12.61 mm: with design.edit_step, set the size of the step that makes Forecastle deck to 2.61 mm along z, or move it by [0, 0, 0.61] and set its size to 2 mm along z',
    )
  })

  it('passes once made either way it says', () => {
    // 2.61 mm tall from its base at z 12
    expect(stackItem(plan, forecastle(12, 14.61))).toMatchObject({ pass: true })
    // moved up 0.61 mm onto the top, 2 mm tall
    expect(stackItem(plan, forecastle(12.61, 14.61))).toMatchObject({ pass: true })
  })

  it('past the support\'s sides: the move alone, since its sunk part shows there', () => {
    const r = stackItem(plan, forecastle(12, 15, [183, 220]))!
    expect(r.pass).toBe(false)
    expect(r.got).toMatch(/^Forecastle deck stands on Hull, but its base is \d+(\.\d+)? mm below its top, so [\d.]+ mm of it shows of a planned 2 mm, and it reaches past the sides of Hull, where its sunk part shows; build it from the top of Hull/)
    expect(r.got).toMatch(/: with design\.edit_step, move the step that makes Forecastle deck by \[0, 0, [\d.]+\] and set its size to 2 mm along z$/)
    expect(r.got).not.toContain('from its base at z')
  })

  it('STANDS_OFF gives the planned height plus what is sunk, and the base under the top, rounded as the rest of the failure is', () => {
    const top = { z: 12.6123, under: true }
    expect(STANDS_OFF('Forecastle deck', 'Hull', 0.6123, 2.3877, 2, top)).toContain('make it 2.61 mm tall from its base at z 12, so 2 mm shows above the top of Hull, whose lowest point under it is at z 12.61 mm')
    expect(STANDS_OFF('Mainmast', 'Promenade deck', 1.1, 12.9, 14, { z: 15, under: false }, false)).toBe(
      'Mainmast stands on Promenade deck, but its base is 1.1 mm below its top, so 12.9 mm of it shows of a planned 14 mm, and it reaches past the sides of Promenade deck, where its sunk part shows; build it from the top of Promenade deck, whose highest point is at z 15 mm: with design.edit_step, move the step that makes Mainmast by [0, 0, 1.1] and set its size to 14 mm along z',
    )
  })
})
