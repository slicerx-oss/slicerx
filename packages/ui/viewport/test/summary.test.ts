// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import { summarizePreview } from '../src/summary'
import { buildPreview } from './sxpv-fixture'

describe('summarizePreview', () => {
  it('sums path length per feature and tool and finds the ranges', () => {
    const b = buildPreview([
      [
        { a: [0, 0], b: [10, 0], feature: FEATURE.outerWall, speed: 50, flow: 2 },
        { a: [10, 0], b: [10, 5], feature: FEATURE.innerWall, tool: 1, speed: 150, flow: 6 },
      ],
      [{ a: [0, 0], b: [3, 4], feature: FEATURE.sparseInfill, speed: 250, flow: 12 }],
    ])
    const s = summarizePreview(b)
    expect(s.featureMm[FEATURE.outerWall]).toBeCloseTo(10)
    expect(s.featureMm[FEATURE.innerWall]).toBeCloseTo(5)
    expect(s.featureMm[FEATURE.sparseInfill]).toBeCloseTo(5)
    expect(s.toolMm).toHaveLength(2)
    expect(s.toolMm[0]).toBeCloseTo(15)
    expect(s.toolMm[1]).toBeCloseTo(5)
    expect(s.speedRange[0]).toBeCloseTo(50)
    expect(s.speedRange[1]).toBeCloseTo(250)
    expect(s.flowRange).toEqual([2, 12])
    expect(s.layerTimeRange).toEqual([10, 11])
  })

  it('derives time per feature from length over speed, and width and height ranges', () => {
    const b = buildPreview([
      [
        { a: [0, 0], b: [10, 0], feature: FEATURE.outerWall, speed: 50 },
        { a: [10, 0], b: [10, 30], feature: FEATURE.sparseInfill, speed: 150 },
      ],
    ])
    const s = summarizePreview(b)
    expect(s.featureTimeS[FEATURE.outerWall]).toBeCloseTo(0.2)
    expect(s.featureTimeS[FEATURE.sparseInfill]).toBeCloseTo(0.2)
    expect(s.widthRange[0]).toBeCloseTo(0.42)
    expect(s.heightRange[1]).toBeCloseTo(0.2)
    expect(s.totalTimeS).toBeCloseTo(10)
  })
})
