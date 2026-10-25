// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { Rect } from './arrange-room'
import { findSpot, type Placed } from './box-pack'

// A part beside a keep-out corner and a block over the rest leave a new part only the strip on the corner's other
// side, where the skirt's hull round all of them would cross it. The A1 keeps its wrap check corner at the back right,
// the P1S its excluded corner at the front left: the same plate turned half round.
const turn = (r: Rect): Rect => ({ x: 80 - r.x - r.w, y: 80 - r.y - r.h, w: r.w, h: r.h })
const BACK_RIGHT = { corner: { x: 56, y: 56, w: 24, h: 24 }, around: [{ x: 0, y: 62, w: 50, h: 16 }, { x: 0, y: 0, w: 50, h: 54 }] }
const CASES = [
  ['back right, as on an A1', BACK_RIGHT],
  ['front left, as on a P1S', { corner: turn(BACK_RIGHT.corner), around: BACK_RIGHT.around.map(turn) }],
] as const

describe.each(CASES)('the box packer with a skirt round the whole print, a keep-out corner at the %s', (_name, c) => {
  const placed: Placed[] = c.around.map((r) => ({ r, grow: 0, reach: 2.5 }))
  const want = { w: 12, h: 12, grow: 0, reach: 2.5 }
  const bed = { widthMm: 80, depthMm: 80 }

  it('places the part flanking the corner without a skirt', () => {
    expect(findSpot(want, placed, [c.corner], [], bed, 4, false, 0, [c.corner])).not.toBeNull()
  })

  it('keeps the skirt hull off the corner, so it leaves the part over', () => {
    expect(findSpot(want, placed, [c.corner], [], bed, 4, true, 0, [c.corner])).toBeNull()
  })
})
