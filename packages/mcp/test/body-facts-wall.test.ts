// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The thinnest wall design.check reads skips what booleans leave where faces meet: a facet folded under its neighbor,
// a needle with no reliable normal and a speck far smaller than a nozzle. A live Pi 5 case read 0.001 mm and a headphone
// stand 0 mm from such facets, so both failed "minimum wall" though their walls were 1.1 mm and more, and mimir could
// not call either finished.
import { describe, expect, it } from 'vitest'
import { minWall } from '../src/body-facts'

type V = [number, number, number]
const mesh = (tris: V[][]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })

// the far side: a large facet 3 mm under the rest, facing down, so its ray goes up
const FAR: V[] = [[-25, -28.33, -3], [5, 61.67, -3], [35, -28.33, -3]]

describe('the thinnest wall', () => {
  it('a facet folded 0.01 mm under the facet it shares an edge with reads the wall, not the fold', () => {
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    const fold: V[] = [[10, 0, 0], [0, 0, 0], [5, 5, -0.01]]
    const r = minWall([mesh([top, fold, FAR])])
    expect(r.mm).toBeGreaterThan(2.9)
  })

  it('a speck 0.001 mm across, 0.0005 mm over the far side, reads nothing', () => {
    const speck: V[] = [[20, -10, -2.9995], [20.001, -10, -2.9995], [20, -10.001, -2.9995]].reverse() as V[]
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    const r = minWall([mesh([top, speck, FAR])])
    expect(r.mm).toBeGreaterThan(2.9)
  })

  it('a real 1 mm wall still reads 1 mm', () => {
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    const under: V[] = [[-25, -28.33, -1], [5, 61.67, -1], [35, -28.33, -1]]
    expect(minWall([mesh([top, under])]).mm).toBeCloseTo(1, 3)
  })
})
