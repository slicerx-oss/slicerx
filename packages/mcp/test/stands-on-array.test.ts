// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The stands-on item of design.check does not read an array or a pattern as standing on its `on` when that `on` is the
// part it copies: the copies start where that part starts, and that part's own pair reads where they stand. An array
// planned on a deck is still held to that deck. Read as a stacked part, an array of funnels "stood on" its own funnel and failed by the funnel's height, a
// failure no fix round could clear. The plans are two stage 1 ship runs' own; the heights are the ones their steps
// built, after the fix round's moves.
import { describe, expect, it } from 'vitest'
import { stackItem, type FeatureHeights } from '../src/plan-detail'

// the run whose array names its funnel as its on, and whose final check failed on it alone among the funnels
const ARRAY_ON_SOURCE = {
  detail: 'display' as const,
  features: [
    { name: 'Hull (loft)', kind: 'loft', sizes: { length: 215, width: 22.4, height: 14.7, sections: 9 } },
    { name: 'Forecastle deck', kind: 'extrude', on: 'Hull (loft)', sizes: { length: 20, width: 9, height: 1.8 } },
    { name: 'Promenade deck house', kind: 'extrude', on: 'Hull (loft)', sizes: { length: 120, width: 14, height: 3.55 } },
    { name: 'Boat deck house', kind: 'extrude', on: 'Promenade deck house', sizes: { length: 96, width: 9, height: 3.25 } },
    { name: 'Bridge', kind: 'extrude', on: 'Boat deck house', sizes: { length: 14, width: 11, height: 3.2 } },
    { name: 'Funnel', kind: 'extrude', on: 'Promenade deck house', sizes: { width: 5.6, depth: 5.2, height: 15.1 } },
    { name: 'Funnels (array)', kind: 'array', on: 'Funnel', sizes: { count: 4, spacing: 20 } },
    { name: 'Foremast', kind: 'extrude', on: 'Hull (loft)', sizes: { diameter: 1.2, height: 19.7 } },
    { name: 'Mainmast', kind: 'extrude', on: 'Hull (loft)', sizes: { diameter: 1.2, height: 18 } },
    { name: 'Poop deck', kind: 'extrude', on: 'Hull (loft)', sizes: { length: 22, width: 9, height: 1.8 } },
  ],
  tiers: { 'Promenade deck house': ['Promenade deck house', 'Boat deck house', 'Bridge'] },
}
const ON_SOURCE_HEIGHTS: FeatureHeights = {
  'hull (loft)': { lo: 0, hi: 14.7 },
  'promenade deck house': { lo: 14.65, hi: 18.2 },
  funnel: { lo: 18.15, hi: 33.25 },
  // four copies along x in the funnel's plane: the same heights as the funnel
  'funnels (array)': { lo: 18.15, hi: 33.25 },
}

// the run whose array names the deckhouse its funnels stand on, and whose final check passed
const ARRAY_ON_SUPPORT = {
  detail: 'display' as const,
  features: [
    { name: 'Hull (loft)', kind: 'loft', sizes: { length: 215, beam: 22, height: 13, sections: 8 } },
    { name: 'Lower deckhouse', kind: 'extrude', on: 'Hull (loft)', sizes: { length: 130, width: 16, height: 3.5 } },
    { name: 'Upper deckhouse', kind: 'extrude', on: 'Lower deckhouse', sizes: { length: 100, width: 12, height: 3.2 } },
    { name: 'Funnel', kind: 'extrude', on: 'Upper deckhouse', sizes: { length: 6, width: 5, height: 12 } },
    { name: 'Funnels (array)', kind: 'array', on: 'Upper deckhouse', sizes: { count: 4, spacing: 20 } },
  ],
  tiers: { 'Lower deckhouse': ['Lower deckhouse', 'Upper deckhouse'] },
}
const ON_SUPPORT_HEIGHTS: FeatureHeights = {
  'hull (loft)': { lo: 0, hi: 11.5 },
  'lower deckhouse': { lo: 11.4, hi: 15 },
  'upper deckhouse': { lo: 14.95, hi: 18.2 },
  funnel: { lo: 18.15, hi: 30.2 },
  'funnels (array)': { lo: 18.15, hi: 30.2 },
}

describe('stands on, with an array of a stacked part', () => {
  it('does not read an array as standing on the part it copies', () => {
    expect(stackItem(ARRAY_ON_SOURCE, ON_SOURCE_HEIGHTS)).toEqual({
      name: 'stands on',
      want: expect.any(String),
      got: '2 stacked parts on their supports',
      pass: true,
    })
  })

  it('still fails a funnel sunk into its deckhouse beside its array', () => {
    // 14.1 mm of a planned 15.1 mm showing is within SCALE_SLACK, so the sunk funnel passes as a seated one does
    const within: FeatureHeights = { ...ON_SOURCE_HEIGHTS, funnel: { lo: 17.2, hi: 32.3 }, 'funnels (array)': { lo: 17.2, hi: 32.3 } }
    expect(stackItem(ARRAY_ON_SOURCE, within)).toMatchObject({ got: '2 stacked parts on their supports', pass: true })
    // 8 mm of it showing is short past SCALE_SLACK: the funnel's own pair fails, and the array is not read against it
    const sunk: FeatureHeights = { ...ON_SOURCE_HEIGHTS, funnel: { lo: 17.2, hi: 26.2 }, 'funnels (array)': { lo: 17.2, hi: 26.2 } }
    expect(stackItem(ARRAY_ON_SOURCE, sunk)).toMatchObject({
      got: "Funnel stands on Promenade deck house, but its base sits 1 mm below Promenade deck house's top, so 8 mm of it shows where the plan has 15.1 mm. Promenade deck house's highest point is at z 18.2 mm. With design.edit_step, set the size of the step that makes Funnel to 16.1 mm along z (it grows up from its base at z 17.2), or move that step by [0, 0, 1] and set its size to 15.1 mm along z.",
      pass: false,
    })
  })

  it('still reads an array planned on the deck its copies stand on, as before', () => {
    expect(stackItem(ARRAY_ON_SUPPORT, ON_SUPPORT_HEIGHTS)).toMatchObject({ got: '4 stacked parts on their supports', pass: true })
    // sunk 1 mm with 11.05 mm of its planned 12 mm showing: within SCALE_SLACK, so it passes as a seated funnel does
    expect(stackItem(ARRAY_ON_SUPPORT, { ...ON_SUPPORT_HEIGHTS, funnel: { lo: 17.2, hi: 29.25 } })).toMatchObject({ got: '4 stacked parts on their supports', pass: true })
    // sunk 1 mm with 5 mm of it showing: short past SCALE_SLACK, so it fails
    const sunk: FeatureHeights = { ...ON_SUPPORT_HEIGHTS, funnel: { lo: 17.2, hi: 23.2 } }
    expect(stackItem(ARRAY_ON_SUPPORT, sunk)).toMatchObject({ pass: false, got: expect.stringMatching(/^Funnel stands on Upper deckhouse, but its base sits 1 mm below Upper deckhouse's top, so 5 mm of it shows where the plan has 12 mm\. /) })
  })
})
