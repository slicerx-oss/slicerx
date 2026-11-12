// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a new feature may go on a design: a cut never runs under a part standing on the face it cuts, and a new part
// never stands where another part already stands on the same face. A part joined at another height (a handle on a
// mug's side) is not held. Neutral samples: a block with a chimney and an antenna on its roof, and a mug.
import type { HistoryMesh, SolidSpec } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { boxOf, placeNote, sharesPlace, solidBox, undercut, type Box } from '../src/feature-place'

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
