// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { layerCoordAt, layerHeightStats, layerThicknesses, layerTopsProblems } from '../src/layerheights'

const tops = [0.2, 0.4, 0.6, 0.9, 1.2, 1.4]

describe('layer tops', () => {
  it('accepts ascending tops and names the first bad one', () => {
    expect(layerTopsProblems(tops)).toEqual([])
    expect(layerTopsProblems([])).toHaveLength(1)
    expect(layerTopsProblems([0.2, 0.2])).toEqual(['layer 1 top 0.2 is not above the previous top 0.2'])
    expect(layerTopsProblems([0.2, Number.NaN])).toHaveLength(1)
    expect(layerTopsProblems([0, 0.2])).toHaveLength(1)
  })

  it('derives thicknesses from the bed up', () => {
    expect([...layerThicknesses(tops)].map((v) => +v.toFixed(3))).toEqual([0.2, 0.2, 0.2, 0.3, 0.3, 0.2])
  })

  it('finds range and the most common height', () => {
    const s = layerHeightStats(tops)
    expect(s.layers).toBe(6)
    expect(s.minMm).toBeCloseTo(0.2)
    expect(s.maxMm).toBeCloseTo(0.3)
    expect(s.commonMm).toBe(0.2)
  })
})

describe('layerCoordAt', () => {
  it('is the layer index plus the fraction through the layer', () => {
    expect(layerCoordAt(tops, 0.1).coord).toBeCloseTo(0.5)
    expect(layerCoordAt(tops, 0.2).coord).toBeCloseTo(1)
    expect(layerCoordAt(tops, 0.75).coord).toBeCloseTo(3.5)
    expect(layerCoordAt(tops, 0.75).thicknessMm).toBeCloseTo(0.3)
  })

  it('clamps below the bed and above the last top', () => {
    expect(layerCoordAt(tops, -1).coord).toBe(0)
    expect(layerCoordAt(tops, 9).coord).toBeCloseTo(6)
    expect(layerCoordAt([], 1).coord).toBe(0)
  })
})
