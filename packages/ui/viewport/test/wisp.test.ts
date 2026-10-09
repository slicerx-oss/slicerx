// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The loading wisp keeps to the plate edge, laps it once, and fades in and out.
import { describe, expect, it } from 'vitest'
import { lapPoint, lightStudio, WISP_FADE_MS, wispAlpha } from '../src/wisp'

describe('the loading wisp', () => {
  it('stays on the plate outline all the way round, never inside it', () => {
    const p = { x: 0, y: 0 }
    const hx = 128
    const hy = 110
    for (let i = 0; i <= 200; i++) {
      lapPoint(i / 200, hx, hy, p)
      const onX = Math.abs(Math.abs(p.x) - hx) < 1e-6 && Math.abs(p.y) <= hy + 1e-6
      const onY = Math.abs(Math.abs(p.y) - hy) < 1e-6 && Math.abs(p.x) <= hx + 1e-6
      expect(onX || onY, `u ${i / 200} at ${p.x}, ${p.y}`).toBe(true)
    }
  })

  it('goes round once a lap: front middle, right side, back, left side, front middle', () => {
    const at = (u: number) => ({ ...lapPoint(u, 100, 100, { x: 0, y: 0 }) })
    expect(at(0)).toEqual({ x: 0, y: -100 })
    expect(at(0.25).x).toBeCloseTo(100)
    expect(at(0.5).y).toBeCloseTo(100)
    expect(at(0.75).x).toBeCloseTo(-100)
    expect(at(1)).toEqual(at(0))
  })

  it('fades in, holds, and fades out after a stop', () => {
    expect(wispAlpha(0, null)).toBe(0)
    expect(wispAlpha(WISP_FADE_MS / 2, null)).toBeCloseTo(0.5)
    expect(wispAlpha(5000, null)).toBe(1)
    expect(wispAlpha(5000 + WISP_FADE_MS / 2, 5000)).toBeCloseTo(0.5)
    expect(wispAlpha(5000 + WISP_FADE_MS, 5000)).toBe(0)
  })

  it('paints over a light studio and adds light on a dark one', () => {
    expect(lightStudio('#f4f5f7')).toBe(true)
    expect(lightStudio('#2f3241')).toBe(false)
  })
})
