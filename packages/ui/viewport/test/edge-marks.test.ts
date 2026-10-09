// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { EdgeMarks } from '../src/edge-marks'

describe('picked edge marks', () => {
  const line = { from: [0, 0, 0] as [number, number, number], to: [10, 0, 0] as [number, number, number] }
  it('draws a bar per picked and hovered edge, sized from the screen scale', () => {
    const m = new EdgeMarks()
    expect(m.set([line], [line], () => 0.1)).toBe(true)
    expect(m.group.children).toHaveLength(2)
    const picked = m.group.children[1]!
    expect(picked.scale.y).toBeCloseTo(10)
    expect(picked.scale.x).toBeCloseTo(0.26)
    expect(m.set([], [], () => 0.1)).toBe(true)
    expect(m.group.children).toHaveLength(0)
  })
  it('redraws only when the camera has moved enough to change the width', () => {
    const m = new EdgeMarks()
    m.set([line], [], () => 0.1)
    expect(m.refresh(() => 0.11)).toBe(false)
    expect(m.refresh(() => 0.2)).toBe(true)
    expect(m.group.children[0]!.scale.x).toBeCloseTo(0.52)
  })
})
