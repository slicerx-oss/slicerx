// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar's pinned top, when taller than its cap, ends under the last row that fits whole.
import { describe, expect, it } from 'vitest'
import { pinClip } from '../src/shell/pane'

describe('pinClip', () => {
  it('ends under the last row that fits, with a little room', () => {
    // Rows end at 217, 269, 355, 391 and 457 below a pinned top at 113, capped at 314 px (bottom 427).
    expect(pinClip(113, 314, [217, 269, 355, 391, 457])).toBe(391 - 113 + 6)
  })

  it('keeps a row that fits exactly with its room', () => {
    expect(pinClip(0, 106, [50, 100, 150])).toBe(106)
    expect(pinClip(0, 105, [50, 100, 150])).toBe(56)
  })

  it('leaves the cap alone when no row fits', () => {
    expect(pinClip(100, 20, [150, 200])).toBeNull()
  })
})
