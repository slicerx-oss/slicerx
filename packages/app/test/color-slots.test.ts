// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model colors to filament slots (@slicerx/contracts/color-slots): the distance is CIEDE2000, a color close to a slot
// prints with it, one that is not gets a slot of its own while the limit allows, and the nearest slot after that.
import { describe, expect, it } from 'vitest'
import { COLOR_MATCH_DELTA_E, colorDeltaE, deltaE2000Lab, nearestSlots, normalizeHex, planColorSlots } from '@slicerx/contracts/color-slots'
import { deltaE2000, parseHex } from '../src/filament/flush'
import { bodyColorLimit, bodyColorNote, planSlots } from '../src/filament/body-colors'

describe('CIEDE2000', () => {
  it('gives the reference values for the published test pairs', () => {
    // Sharma, Wu and Dalal (2005), table 1: pairs 1, 7, 17 to 20, 25 and 34
    const pairs: [[number, number, number], [number, number, number], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[50, 2.5, 0], [61, -5, 29], 22.8977],
      [[50, 2.5, 0], [56, -27, -3], 31.903],
      [[50, 2.5, 0], [58, 24, 15], 19.4535],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ]
    for (const [a, b, want] of pairs) {
      expect(deltaE2000Lab(a, b)).toBeCloseTo(want, 4)
      expect(deltaE2000Lab(b, a)).toBeCloseTo(want, 4)
    }
  })

  it('agrees with the flush volume estimate on hex colors, to the rounding of its sRGB matrix', () => {
    const hex = ['#ff0000', '#c12e1f', '#0040ff', '#0a2989', '#000000', '#282a36', '#ffffff', '#f8f8f2', '#50fa7b', '#808080', '#ff8000']
    for (const a of hex) for (const b of hex) expect(colorDeltaE(a, b)).toBeCloseTo(deltaE2000(parseHex(a)!, parseHex(b)!), 1)
  })

  it('reads colors in any case, with or without # and alpha, and refuses anything else', () => {
    expect(normalizeHex('FF0000')).toBe('#ff0000')
    expect(normalizeHex('#Ff0000aa')).toBe('#ff0000')
    expect(normalizeHex('red')).toBeNull()
    expect(normalizeHex(null)).toBeNull()
    expect(colorDeltaE('red', '#ff0000')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('planColorSlots', () => {
  const red = { index: 1, color: '#c12e1f' }
  const black = { index: 2, color: '#000000' }

  it('puts a color on the nearest slot within the threshold', () => {
    const plan = planColorSlots(['#ff0000', '#1a1a1a'], [red, black], { limit: 16 })
    expect(plan.picks.map((p) => [p?.slot, p?.match])).toEqual([[1, 'match'], [2, 'match']])
    expect(plan.picks[0]!.deltaE).toBeLessThanOrEqual(COLOR_MATCH_DELTA_E)
    expect(plan.add).toEqual([])
  })

  it('gives a color past the threshold a slot of its own after the last', () => {
    const plan = planColorSlots(['#ff8000', '#0040ff'], [red, black], { limit: 16 })
    expect(plan.picks.map((p) => [p?.slot, p?.match])).toEqual([[3, 'new'], [4, 'new']])
    expect(plan.add).toEqual([{ slot: 3, color: '#ff8000' }, { slot: 4, color: '#0040ff' }])
  })

  it('keeps the threshold: just over it adds a slot, a looser one matches', () => {
    // pure black to a near black is 13 apart
    expect(planColorSlots(['#000000'], [{ index: 1, color: '#282a36' }], { limit: 16 }).picks[0]!.match).toBe('new')
    expect(planColorSlots(['#000000'], [{ index: 1, color: '#282a36' }], { limit: 16, threshold: 14 }).picks[0]).toMatchObject({ slot: 1, match: 'match' })
  })

  it('shares one new slot between colors close to each other', () => {
    const plan = planColorSlots(['#808080', '#7f7f7f', '#828282'], [red], { limit: 16 })
    expect(plan.picks.map((p) => p?.slot)).toEqual([2, 2, 2])
    expect(plan.add).toEqual([{ slot: 2, color: '#808080' }])
  })

  it('takes over the lowest free slot before adding one', () => {
    const plan = planColorSlots(['#0040ff', '#00ff00', '#ff8000'], [red, { index: 2, color: '#f8f8f2', free: true }, { index: 3, color: '#282a36', free: true }], { limit: 16 })
    expect(plan.picks.map((p) => p?.slot)).toEqual([2, 3, 4])
    // a free slot's own color never matches: it is there to be taken over
    expect(planColorSlots(['#f8f8f2'], [{ index: 1, color: '#f8f8f2', free: true }], { limit: 16 }).picks[0]).toMatchObject({ slot: 1, match: 'new' })
  })

  it('falls back to the nearest slot once the limit is reached', () => {
    const plan = planColorSlots(['#ff0000', '#0040ff', '#ff8000'], [red, black], { limit: 2 })
    expect(plan.picks.map((p) => [p?.slot, p?.match])).toEqual([[1, 'match'], [2, 'nearest'], [1, 'nearest']])
    expect(plan.add).toEqual([])
    // room for one more: the first color without a match takes it, the next one shares the nearest
    const one = planColorSlots(['#0040ff', '#00ff00'], [red, black], { limit: 3 })
    expect(one.add).toEqual([{ slot: 3, color: '#0040ff' }])
    expect(one.picks[1]!.match).toBe('nearest')
    // the limit never goes past 16 slots
    const many = planColorSlots(Array.from({ length: 20 }, (_, i) => `#${(i * 12).toString(16).padStart(2, '0')}00ff`), [], { limit: 99, threshold: 0 })
    expect(Math.max(...many.add.map((a) => a.slot))).toBe(16)
  })

  it('leaves uncolored entries and a file without colors alone', () => {
    const plan = planColorSlots([null, '#ff0000', undefined, 'not a color'], [red], { limit: 16 })
    expect(plan.picks.map((p) => p?.slot ?? null)).toEqual([null, 1, null, null])
    expect(planColorSlots([null, null], [red], { limit: 16 })).toEqual({ picks: [null, null], add: [] })
    expect(planColorSlots([], [], { limit: 16 })).toEqual({ picks: [], add: [] })
    // nothing to fall back on and no room: no pick
    expect(planColorSlots(['#ff0000'], [], { limit: 0 }).picks).toEqual([null])
  })

  it('gives every body of a color the same pick', () => {
    const plan = planColorSlots(['#0040ff', '#ff0000', '#0040FF'], [red], { limit: 16 })
    expect(plan.picks[0]).toBe(plan.picks[2])
    expect(plan.add).toHaveLength(1)
  })
})

describe('nearestSlots', () => {
  it('gives each color the nearest filament, with no threshold and no new slots', () => {
    const filaments = ['#c12e1f', '#000000', '#f8f8f2']
    // orange is far from all three and still gets the nearest, red
    expect(nearestSlots(['#ff0000', '#1a1a1a', '#ffffff', '#ff8000'], filaments)).toEqual([1, 2, 3, 1])
  })

  it('gives a tie to the lower slot, and 0 when a color or every filament cannot be read', () => {
    expect(nearestSlots(['#ff0000'], ['#ff0000', '#ff0000'])).toEqual([1])
    expect(nearestSlots(['red', '#ff0000'], ['#000000'])).toEqual([0, 1])
    expect(nearestSlots(['#ff0000'], [])).toEqual([0])
    expect(nearestSlots(['#ff0000'], ['nope', '#00ff00'])).toEqual([2])
  })
})

describe('body colors in the app', () => {
  it('limits the plan to the printer slots when the printer reports them', () => {
    expect(bodyColorLimit({ printerSlots: [] })).toBe(16)
    expect(bodyColorLimit({ printerSlots: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }, { id: 'A4' }] })).toBe(4)
  })

  it('frees only default slots nothing prints with, and keeps slot 1 for bodies without a color', () => {
    const slots = [
      { index: 1, color: '#f8f8f2', source: 'default' as const, used: false },
      { index: 2, color: '#ff0000', source: 'printer' as const, used: false },
      { index: 3, color: '#282a36', source: 'default' as const, used: true },
      { index: 4, color: '#50fa7b', source: 'default' as const, used: false },
    ]
    expect(planSlots(slots, false).map((s) => s.free)).toEqual([true, false, false, true])
    expect(planSlots(slots, true).map((s) => s.free)).toEqual([false, false, false, true])
  })

  it('says what the plan did in one plain sentence', () => {
    const none = { printerSlots: [] }
    const ams = { printerSlots: [{ id: 'A1' }, { id: 'A2' }] }
    expect(bodyColorNote(planColorSlots([null], [], { limit: 16 }), none)).toBeNull()
    expect(bodyColorNote(planColorSlots(['#ff0000', null, '#0040ff'], [{ index: 1, color: '#f8f8f2' }], { limit: 16 }), none)).toBe("Added filaments 2 (Red) and 3 (Blue) for the file's colors.")
    expect(bodyColorNote(planColorSlots(['#ff0000', '#0040ff', '#00ff00'], [], { limit: 16 }), none)).toBe("Added filaments 1 (Red), 2 (Blue) and 3 (Green) for the file's colors.")
    expect(bodyColorNote(planColorSlots(['#ff0000'], [{ index: 1, color: '#c12e1f' }], { limit: 2 }), ams)).toBe("The file's colors matched loaded filaments.")
    expect(bodyColorNote(planColorSlots(['#ff0000', '#0040ff', '#00ff00'], [{ index: 1, color: '#c12e1f' }, { index: 2, color: '#000000' }], { limit: 2 }), ams)).toBe(
      "The file has 3 colors and the printer holds 2, so 2 print with the nearest filament's color.",
    )
  })
})
