// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { decodeMix, decodeMixes, encodeMix, mixColor, mixConfig, mixCost, mixLayerFilament, mixProblem, mixToolChanges, nextMixId, type MixedFilament } from './mixed'
import { SETTINGS } from './schema'

const mix = (ratio: [number, number], id = 32): MixedFilament => ({ id, name: 'Purple', components: [1, 2], ratio })
const pattern = (m: MixedFilament, n: number): string => Array.from({ length: n }, (_, l) => (mixLayerFilament(m, l) === 1 ? 'A' : 'B')).join('')

describe('mixed filaments', () => {
  it('print the layer pattern the engine prints', () => {
    expect(pattern(mix([1, 1]), 6)).toBe('ABABAB')
    expect(pattern(mix([2, 1]), 9)).toBe('AABAABAAB')
    expect(pattern(mix([3, 2]), 10)).toBe('AABABAABAB')
    // The vectors packages/core/src/mixed.rs checks too, so the two rules cannot drift.
    expect(pattern(mix([1, 2]), 6)).toBe('ABBABB')
    expect(pattern(mix([20, 20]), 6)).toBe('ABABAB')
    expect(pattern(mix([2, 1]), 6)).toBe('AABAAB')
  })

  it('round trip through the setting, names with colons included', () => {
    const m: MixedFilament = { id: 31, name: 'Sunset: warm', components: [3, 1], ratio: [1, 4] }
    expect(encodeMix(m)).toBe('31:3,1:1,4:Sunset: warm')
    expect(decodeMix(encodeMix(m))).toEqual(m)
    expect(decodeMixes([encodeMix(m), 'nonsense', '32:1,2:0,1'])).toEqual([m])
    expect(mixConfig([])).toEqual({})
    expect(mixConfig([m])).toEqual({ mixed_filaments: ['31:3,1:1,4:Sunset: warm'] })
  })

  it('count a tool change per switch of filament', () => {
    expect(mixToolChanges(mix([1, 1]), 10)).toBe(9)
    expect(mixToolChanges(mix([2, 1]), 9)).toBe(5)
    expect(mixToolChanges(mix([3, 2]), 10)).toBe(7)
    const cost = mixCost(mix([1, 1]), 10, [100, 200], 1, [1, 1])
    // 5 changes to B at 100 mm3 and 4 back to A at 200 mm3: 1300 mm3 at 1 g/cm3.
    expect(cost).toEqual({ changes: 9, grams: 1.3, many: false })
    expect(mixCost(mix([1, 1]), 50, [100, 100], 1).many).toBe(true)
  })

  it('predict the color by averaging in linear light', () => {
    expect(mixColor(['#ff0000', '#0000ff'], [1, 1])).toBe('#bc00bc')
    expect(mixColor(['#ffffff', '#000000'], [1, 0])).toBe('#ffffff')
    expect(mixColor(['#ffffff', '#000000'], [1, 1])).toBe('#bcbcbc')
  })

  it('take numbers from the top, past the loaded filaments', () => {
    expect(nextMixId([], 4)).toBe(32)
    expect(nextMixId([{ id: 32 }], 4)).toBe(31)
    expect(nextMixId([{ id: 32 }, { id: 31 }], 31)).toBe(null)
    expect(mixProblem(mix([1, 1], 3), [], 4)).toMatch(/past the 4 loaded/)
    expect(mixProblem({ ...mix([1, 1]), components: [1, 1] }, [], 4)).toMatch(/two different/)
    expect(mixProblem({ ...mix([1, 1]), components: [1, 5] }, [], 4)).toMatch(/4 loaded/)
    expect(mixProblem(mix([1, 1], 28), [], 4)).toMatch(/from 29 to 32/)
    expect(mixProblem(mix([1, 1]), [], 4)).toBe(null)
  })

  it('are a hidden plate setting the settings panels leave out', () => {
    const def = SETTINGS.find((d) => d.key === 'mixed_filaments')
    expect(def).toMatchObject({ section: 'process', type: 'strings', mode: 'hidden' })
    expect(def?.default).toBeUndefined()
  })
})
