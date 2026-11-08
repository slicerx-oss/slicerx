// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The thinnest wall design.check reads skips what booleans leave where faces meet: a facet folded under its neighbor,
// a needle with no reliable normal and a speck far smaller than a nozzle. A live Pi 5 case read 0.001 mm and a headphone
// stand 0 mm from such facets, so both failed "minimum wall" though their walls were 1.1 mm and more, and mimir could
// not call either finished. A planter with 3 mm walls read 0.025 mm the same way, from a needle at a drain hole rim.
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

  it('a needle facet standing on edge is skipped, so its ray along the surface reads no wall of 0.05 mm', () => {
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    // doubled area 0.01 against a longest edge squared of 100: its normal points sideways, at a facet 0.05 mm off
    const needle: V[] = [[0, 0, 0], [10, 0, 0], [5, 0, 0.001]]
    const beside: V[] = [[-5, 0.05, -1], [5, 0.05, 1], [15, 0.05, -1]]
    expect(minWall([mesh([top, needle, beside, FAR])]).mm).toBeCloseTo(3, 3)
  })

  it('a needle lying in the floor at a drain hole rim reads the 3 mm floor, not the hole wall its ray grazes', () => {
    // from a planter built as a 120 mm cylinder, a 114 mm cut down to a 3 mm floor and five 6 mm drain holes: at the
    // rim of the hole around (30, 0), the subtract left a needle facet in the bottom face, 0.016 mm long, and the hole's
    // wall facet beside it leans 0.004 mm over its 3 mm height. The needle's ray goes up along that wall and met it
    // 0.025 mm up, so design.check failed "minimum wall" at 0.03 mm on a part whose walls are 3 mm.
    const needle: V[] = [[32.91094207763672, 0.7071242928504944, 0], [32.910587310791016, 0.7081326842308044, 0], [32.90554428100586, 0.7225484251976013, 0]]
    const holeWall: V[] = [[32.70290756225586, 1.3016512393951416, 3], [32.910587310791016, 0.7081326842308044, 0], [32.91094207763672, 0.7071242928504944, 0]]
    // a plain facet of the bottom beside the needle, facing down, and the floor's top face 3 mm over it, facing up
    const bottom: V[] = [[31, -2, 0], [29, -0.5, 0], [32, -0.5, 0]]
    const floorTop: V[] = [[20, -10, 3], [45, -10, 3], [32, 20, 3]]
    expect(minWall([mesh([needle, holeWall, bottom, floorTop])]).mm).toBeCloseTo(3, 3)
  })

  it('a closed plate 20 x 20 x 0.4 mm still reads its 0.4 mm wall, too thin for twice a 0.4 mm nozzle', () => {
    const r = minWall([box(20, 20, 0.4)])
    expect(r.mm).toBeCloseTo(0.4, 3)
    expect(r.mm!).toBeLessThan(0.8)
  })

  it('a closed strip 2 mm wide and 0.4 mm thick still reads 0.4 mm', () => {
    expect(minWall([box(20, 2, 0.4)]).mm).toBeCloseTo(0.4, 3)
  })

  it('a wedge tapering to a knife edge, whose top and bottom share that edge, reads its thin wall', () => {
    // 10 mm long, 20 mm wide, 0.4 mm tall at x = 0 down to nothing at x = 10
    const p: V[] = [[0, 0, 0], [10, 0, 0], [0, 20, 0], [10, 20, 0], [0, 0, 0.4], [0, 20, 0.4]]
    const [a, b, c, d, e, f] = p as [V, V, V, V, V, V]
    const tris: V[][] = [
      [a, c, b], [b, c, d], // bottom, facing down
      [e, b, d], [e, d, f], // sloped top, facing up
      [a, e, f], [a, f, c], // the 0.4 mm end at x = 0, facing -x
      [a, b, e], // side at y = 0
      [c, f, d], // side at y = 20
    ]
    // each facet's ray starts at its center, so the reading is the wedge's thickness two thirds of the way to the edge,
    // 0.4 x (1 - 2/3): thin, as a knife edge is, and far under twice a 0.4 mm nozzle
    expect(minWall([mesh(tris)]).mm).toBeCloseTo(0.133, 3)
  })
})

/** A closed box from the origin, outward facing, two facets a side. */
function box(x: number, y: number, z: number) {
  const v = (i: number): V => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  return mesh(quads.flatMap(([a, b, c, d]) => [[v(a!), v(b!), v(c!)], [v(a!), v(c!), v(d!)]]))
}

