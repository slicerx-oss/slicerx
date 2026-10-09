// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { boxDir, boxPicks } from '../src/box-select'

describe('box select', () => {
  const box = { l: 100, r: 300, t: 100, b: 200 }
  it('reads the direction from the drag', () => {
    expect(boxDir(10, 50)).toBe('inside')
    expect(boxDir(50, 10)).toBe('touch')
  })
  it('picks only what is fully inside left to right, and anything touched right to left', () => {
    const inside = { l: 120, r: 180, t: 120, b: 180 }
    const crossing = { l: 280, r: 360, t: 150, b: 190 }
    const outside = { l: 320, r: 360, t: 150, b: 190 }
    expect([inside, crossing, outside].map((o) => boxPicks(box, o, 'inside'))).toEqual([true, false, false])
    expect([inside, crossing, outside].map((o) => boxPicks(box, o, 'touch'))).toEqual([true, true, false])
  })
})
