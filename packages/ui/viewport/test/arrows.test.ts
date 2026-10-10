// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The move arrows' drag math: where a ray passes an axis, and how near it comes to an arrow.
import { describe, expect, it } from 'vitest'
import { alongAxis, rayToSegment } from '../src/arrows'

describe('a ray against a move arrow', () => {
  it('finds where the ray passes the axis', () => {
    // a ray straight down at x 30 passes the x axis through the origin at 30
    expect(alongAxis([30, 5, 100], [0, 0, -1], [0, 0, 0], [1, 0, 0])).toBeCloseTo(30, 6)
    // and the z axis from the side at the height it crosses
    expect(alongAxis([0, -200, 42], [0, 1, 0], [0, 0, 0], [0, 0, 1])).toBeCloseTo(42, 6)
  })

  it('gives nothing for a ray along the axis, so the drag holds still', () => {
    expect(alongAxis([0, 0, 300], [0, 0, -1], [0, 0, 0], [0, 0, 1])).toBeNull()
  })

  it('measures the gap to the arrow, clamped to its ends', () => {
    expect(rayToSegment([20, 3, 100], [0, 0, -1], [0, 0, 0], [1, 0, 0], 50)).toBeCloseTo(3, 6)
    // past the tip the nearest point is the tip itself
    expect(rayToSegment([80, 0, 100], [0, 0, -1], [0, 0, 0], [1, 0, 0], 50)).toBeCloseTo(30, 6)
  })
})
