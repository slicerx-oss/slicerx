// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The perceptual color difference (CIEDE2000, colorDeltaE) against published test pairs, and the filament colors it
// reads as the same color under SAME_COLOR_DE00 or as different ones.
import { describe, expect, it } from 'vitest'
import { colorDeltaE, deltaE2000Lab, type Lab } from '../src/color-slots'
import { colorDistance, SAME_COLOR_DE00 } from '../src/slot-match'

const lab = (L: number, a: number, b: number): Lab => [L, a, b]

describe('deltaE2000Lab', () => {
  // Pairs and differences from Sharma, Wu and Dalal (2005), "The CIEDE2000 color-difference formula: implementation
  // notes, supplementary test data, and mathematical observations", Table 1.
  const sharma: [Lab, Lab, number][] = [
    [lab(50, 2.6772, -79.7751), lab(50, 0, -82.7485), 2.0425],
    [lab(50, 3.1571, -77.2803), lab(50, 0, -82.7485), 2.8615],
    [lab(50, -1.3802, -84.2814), lab(50, 0, -82.7485), 1.0],
    [lab(50, 0, 0), lab(50, -1, 2), 2.3669],
    [lab(50, 2.49, -0.001), lab(50, -2.49, 0.0009), 7.1792],
    [lab(50, 2.49, -0.001), lab(50, -2.49, 0.0011), 7.2195],
    [lab(50, -0.001, 2.49), lab(50, 0.0009, -2.49), 4.8045],
    [lab(50, -0.001, 2.49), lab(50, 0.0011, -2.49), 4.7461],
    [lab(50, 2.5, 0), lab(73, 25, -18), 27.1492],
    [lab(50, 2.5, 0), lab(56, -27, -3), 31.903],
    [lab(60.2574, -34.0099, 36.2677), lab(60.4626, -34.1751, 39.4387), 1.2644],
    [lab(61.2901, 3.7196, -5.3901), lab(61.4292, 2.248, -4.962), 1.8731],
    [lab(22.7233, 20.0904, -46.694), lab(23.0331, 14.973, -42.5619), 2.0373],
    [lab(90.9257, -0.5406, -0.9208), lab(88.6381, -0.8985, -0.7239), 1.5381],
    [lab(2.0776, 0.0795, -1.135), lab(0.9033, -0.0636, -0.5514), 0.9082],
  ]

  it.each(sharma)('matches the published difference, both ways round: %o to %o is %d', (p, q, want) => {
    expect(deltaE2000Lab(p, q)).toBeCloseTo(want, 4)
    expect(deltaE2000Lab(q, p)).toBeCloseTo(want, 4)
  })

  it('is 0 for the same color', () => {
    expect(deltaE2000Lab(lab(50, 2.5, 0), lab(50, 2.5, 0))).toBe(0)
  })
})

describe('colorDeltaE and SAME_COLOR_DE00', () => {
  const pairs: [string, string, number][] = [
    ['#1a1a1a', '#000000', 5.5229],
    ['#f2f2ee', '#ffffff', 3.4068],
    ['#c8a23c', '#d9a441', 4.6523],
    ['#909090', '#808080', 5.7263],
    ['#e6e6e6', '#ffffff', 5.1783],
    ['#d1d3d5', '#ffffff', 9.6211],
    ['#333333', '#000000', 13.389],
    ['#cccccc', '#ffffff', 11.1398],
    ['#ff8000', '#d9a441', 16.7314],
    ['#000080', '#0000ff', 16.5494],
    ['#a82a22', '#c8102e', 6.9052],
  ]

  it.each(pairs)('%s to %s is %d', (a, b, want) => {
    expect(colorDeltaE(a, b)).toBeCloseTo(want, 4)
    expect(colorDeltaE(b, a)).toBeCloseTo(want, 4)
  })

  it('reads near black, near white, light gray, mid grays and two buffs as the same color, and the rest apart', () => {
    const same = pairs.filter(([a, b]) => colorDeltaE(a, b) < SAME_COLOR_DE00).map(([a, b]) => `${a} ${b}`)
    expect(same).toEqual(['#1a1a1a #000000', '#f2f2ee #ffffff', '#c8a23c #d9a441', '#909090 #808080', '#e6e6e6 #ffffff'])
  })

  it('weighs a step near black more than plain RGB does', () => {
    // 45 apart in RGB, over NEAR_COLOR, yet under SAME_COLOR_DE00
    expect(colorDistance('#1a1a1a', '#000000')).toBeGreaterThan(40)
    expect(colorDeltaE('#1a1a1a', '#000000')).toBeLessThan(SAME_COLOR_DE00)
  })

  it('keeps colors that cannot be read far apart', () => {
    expect(colorDeltaE('#ffffff', 'white')).toBe(Infinity)
  })
})
