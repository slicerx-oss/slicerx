// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a new feature may go on a design: a cut never runs under a part standing on the face it cuts, and a new part
// never stands where another part already stands on the same face. A part joined at another height (a handle on a
// mug's side) is not held. Neutral samples: a block with a chimney and an antenna on its roof, and a mug.
import type { HistoryMesh, SolidSpec } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { boxOf, placeNote, sharesPlace, solidBox, solidsInPlace, solidsNote, undercut, type Box } from '../src/feature-place'

/** A part made of one box's corners, enough for its box. */
const part = (name: string, min: [number, number, number], max: [number, number, number]): HistoryMesh => ({
  name,
  slot: 1,
  positions: [min[0], min[1], min[2], max[0], max[1], max[2]],
  indices: [],
})
// a block 60 x 40 x 20 with a chimney and an antenna standing on its roof (z 20)
const BLOCK = [part('Block', [0, 0, 0], [60, 40, 20]), part('Chimney', [40, 10, 20], [50, 20, 35]), part('Antenna', [10, 30, 20], [12, 32, 40])]
const box = (min: [number, number, number], max: [number, number, number]): SolidSpec => ({ type: 'box', min, max })

describe('a cut on a face with parts standing on it', () => {
  it('is refused when it runs under a part standing there, naming the part and its box', () => {
    // a recess in the roof under the chimney
    const inWay = undercut(BLOCK, 0, [box([35, 5, 17], [55, 25, 20.5])])
    expect(inWay).toEqual(['Chimney (x 40 to 50, y 10 to 20, z 20 to 35)'])
    expect(placeNote('cut', inWay, solidBox(box([35, 5, 17], [55, 25, 20.5])))).toMatch(/^Nothing was cut: the cut \(x 35 to 55, y 5 to 25, z 17 to 20\.5\) runs under Chimney/)
  })

  it('goes ahead on an open area of the face, and in a side clear of what stands on top', () => {
    expect(undercut(BLOCK, 0, [box([15, 5, 17], [30, 20, 20.5])])).toEqual([])
    // slits in the block's side, well below the roof
    expect(undercut(BLOCK, 0, [box([5, -1, 8], [8, 1, 12]), box([12, -1, 8], [15, 1, 12])])).toEqual([])
  })

  it('goes ahead with a notch at the edge of where a part stands, as a hinge seat under a lid', () => {
    // a lid resting on a box's walls, and a notch in the back wall reaching a fraction of a millimeter into its seat
    const lidded = [part('Box', [0, 0, 0], [80, 50, 30.4]), part('Lid', [0, 0, 30.4], [80, 50, 35])]
    expect(undercut(lidded, 0, [box([15, 47.9, 26], [65, 50.5, 31])])).toEqual([])
    // a recess taking most of what the chimney stands on is refused
    expect(undercut(BLOCK, 0, [box([38, 10.5, 17], [52, 19.5, 20.5])])).toEqual(['Chimney (x 40 to 50, y 10 to 20, z 20 to 35)'])
  })

  it('goes ahead with a hole inside the opening of a ring standing on the face, read from its triangles', () => {
    // a square ring on a base's top (z 10): its top face as four strips around the opening x 8 to 22, y 8 to 22, and a
    // corner at its bottom for its height
    const q = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, 30, x1, y0, 30, x1, y1, 30, x0, y1, 30]
    const positions = [...q(5, 5, 25, 8), ...q(5, 22, 25, 25), ...q(5, 8, 8, 22), ...q(22, 8, 25, 22), 5, 5, 10]
    const indices = [0, 1, 2, 3].flatMap((k) => [4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3])
    const ringed = [part('Base', [0, 0, 0], [40, 40, 10]), { name: 'Ring', slot: 1, positions, indices }]
    expect(undercut(ringed, 0, [box([10, 10, 6], [20, 20, 10.5])])).toEqual([])
    // the same hole under the ring's wall is refused
    expect(undercut(ringed, 0, [box([4, 4, 6], [26, 9, 10.5])])).toEqual(['Ring (x 5 to 25, y 5 to 25, z 10 to 30)'])
  })

  it('reads a round cutter by the box around its ends', () => {
    const drill: SolidSpec = { type: 'cylinder', origin: [11, 31, 21], axis: [0, 0, -1], diameterMm: 4, heightMm: 3 }
    expect(solidBox(drill)).toEqual({ min: [9, 29, 18], max: [13, 33, 21] })
    expect(undercut(BLOCK, 0, [drill])).toEqual(['Antenna (x 10 to 12, y 30 to 32, z 20 to 40)'])
  })
})

describe('a new part on a face', () => {
  const added = (min: [number, number, number], max: [number, number, number]): Box => boxOf([...min, ...max])!

  it('is refused where another part already stands on the same face', () => {
    expect(sharesPlace(BLOCK, added([42, 12, 20], [48, 18, 23]))).toEqual(['Chimney (x 40 to 50, y 10 to 20, z 20 to 35)'])
    expect(placeNote('part', ['Chimney'], null)).toMatch(/^Nothing was built: the new part stands where Chimney already stands on the same face/)
  })

  it('goes ahead on open area, touching the side of a part, or on top of it', () => {
    expect(sharesPlace(BLOCK, added([20, 5, 20], [26, 11, 23]))).toEqual([])
    // touching the chimney's side shares no footprint
    expect(sharesPlace(BLOCK, added([50, 10, 20], [55, 20, 23]))).toEqual([])
    // a cap on the chimney stands on its top, another face
    expect(sharesPlace(BLOCK, added([40, 10, 35], [50, 20, 37]))).toEqual([])
  })

  it('lets a part joined at another height overlap, as a handle on a mug', () => {
    const mug = [part('Cup', [0, 0, 0], [80, 80, 95])]
    expect(sharesPlace(mug, added([75, 30, 20], [110, 50, 80]))).toEqual([])
  })
})

/** A part made of boxes, each with its 12 triangles, so its footprint is read from its triangles. */
function solidPart(name: string, boxes: [[number, number, number], [number, number, number]][]): HistoryMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [lo, hi] of boxes) {
    const o = positions.length / 3
    for (const z of [lo[2], hi[2]]) for (const [x, y] of [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]] as const) positions.push(x, y, z)
    const q = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
    for (const [a, b, c, d] of q) indices.push(o + a!, o + b!, o + c!, o + a!, o + c!, o + d!)
  }
  return { name, slot: 1, positions, indices }
}

describe('a new part of several solids, held solid by solid', () => {
  // a table top 100 x 60 at z 40 with a lamp standing in its middle
  const table = [solidPart('Top', [[[0, 0, 30], [100, 60, 40]]]), solidPart('Lamp', [[[40, 20, 40], [60, 40, 70]]])]

  it('builds two end posts whose box around both covers the lamp, since neither post stands in it', () => {
    const posts = [solidBox(box([2, 25, 40], [8, 35, 50])), solidBox(box([92, 25, 40], [98, 35, 50]))]
    expect(solidsInPlace(table, posts)).toEqual([])
    // read as one box, as before, the pair stood where the lamp stands
    expect(sharesPlace(table, { min: [2, 25, 40], max: [98, 35, 50] })).toEqual(['Lamp (x 40 to 60, y 20 to 40, z 40 to 70)'])
  })

  it('reads a standing part by its triangles, not its box: a post in the open corner of an L-shaped wall goes ahead', () => {
    // an L of two walls on the top: its box covers the corner at x 70 to 90, y 40 to 60, its triangles do not
    const yard = [table[0]!, solidPart('Wall', [[[50, 0, 40], [100, 10, 60]], [[90, 0, 40], [100, 60, 60]]])]
    expect(solidsInPlace(yard, [solidBox(box([72, 42, 40], [80, 50, 50]))])).toEqual([])
    expect(solidsInPlace(yard, [solidBox(box([60, 2, 40], [70, 8, 50]))]).map((h) => h.part)).toEqual(['Wall'])
  })

  it('refuses a solid that does stand in another part, naming that solid and the call that clears it', () => {
    // a box lid with two hinge knuckles centered on its back edge: each knuckle is half inside the lid
    const lid = [solidPart('Base', [[[0, 0, 0], [80, 54, 27]]]), solidPart('Lid', [[[0, 60, 0], [80, 110, 10]]])]
    // the recorded hinged-box build's lid and knuckles, as given
    const knuckles: Extract<SolidSpec, { type: 'cylinder' }>[] = [
      { type: 'cylinder', origin: [12, 110, 5], axis: [1, 0, 0], diameterMm: 8, heightMm: 22 },
      { type: 'cylinder', origin: [46, 110, 5], axis: [1, 0, 0], diameterMm: 8, heightMm: 22 },
    ]
    const inWay = solidsInPlace(lid, knuckles.map(solidBox))
    expect(inWay.map((h) => [h.solid, h.part])).toEqual([[0, 'Lid'], [1, 'Lid']])
    expect(solidsNote(inWay)).toBe(
      'Nothing was built: solids[0] (x 12 to 34, y 106 to 114, z 1 to 9) stands in Lid (x 0 to 80, y 60 to 110, z 0 to 10): raise it by 9 mm so it starts at z 10 on Lid\'s top, or move it +4 mm in y so it stands clear beside it; solids[1] (x 46 to 68, y 106 to 114, z 1 to 9) stands in Lid (x 0 to 80, y 60 to 110, z 0 to 10): raise it by 9 mm so it starts at z 10 on Lid\'s top, or move it +4 mm in y so it stands clear beside it. Send geom.build again with those solids moved, keeping the others as they are, or say why it must go there.',
    )
    // moved 4 mm back, each knuckle stands clear behind the lid's edge
    expect(solidsInPlace(lid, knuckles.map((k) => solidBox({ ...k, origin: [k.origin[0], 114, k.origin[2]] })))).toEqual([])
  })
})
