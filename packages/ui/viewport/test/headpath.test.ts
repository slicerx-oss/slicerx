// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { CORNER_MM, headAt, type HeadSeg } from '../src/headpath'

const path = (segs: HeadSeg[]) => (i: number) => segs[i] ?? null

describe('head along a move during playback', () => {
  it('is part of the way along the move, with that much of the bead drawn', () => {
    const get = path([{ x0: 0, y0: 0, x1: 100, y1: 0, z: 0.2 }])
    const h = headAt(get, 0, 0.5)
    expect(h.x).toBeCloseTo(50)
    expect(h.y).toBeCloseTo(0)
    expect(h.z).toBeCloseTo(0.2)
    expect(h.reveal).toBeCloseTo(0.5)
  })

  it('travels from the last move before it lays any bead, instead of jumping', () => {
    // A 10 mm move that starts 30 mm from where the last one ended.
    const get = path([
      { x0: 0, y0: 0, x1: 10, y1: 0, z: 0.2 },
      { x0: 40, y0: 0, x1: 50, y1: 0, z: 0.2 },
    ])
    const early = headAt(get, 1, 0.1)
    expect(early.reveal).toBe(0)
    expect(early.x).toBeGreaterThan(10)
    expect(early.x).toBeLessThan(40)
    // The travel takes at most half the move's time; the bead then runs to its end.
    const late = headAt(get, 1, 0.75)
    expect(late.reveal).toBeCloseTo(0.5)
    expect(late.x).toBeCloseTo(45)
    expect(headAt(get, 1, 1).reveal).toBe(1)
  })

  it('eases a corner, continuous across the join and never more than CORNER_MM off the path', () => {
    const get = path([
      { x0: 0, y0: 0, x1: 20, y1: 0, z: 0.2 },
      { x0: 20, y0: 0, x1: 20, y1: 20, z: 0.2 },
    ])
    const end = headAt(get, 0, 1)
    const start = headAt(get, 1, 0)
    expect(end.x).toBeCloseTo(start.x, 6)
    expect(end.y).toBeCloseTo(start.y, 6)
    // Rounded: the head cuts inside the square corner, by less than the corner radius.
    expect(Math.hypot(end.x - 20, end.y)).toBeGreaterThan(0.01)
    expect(Math.hypot(end.x - 20, end.y)).toBeLessThan(CORNER_MM)
    // Away from the corner it is exactly on the move.
    const mid = headAt(get, 0, 0.5)
    expect(mid.x).toBeCloseTo(10)
    expect(mid.y).toBeCloseTo(0)
    // The bead itself is never rounded: the reveal is the share of the move.
    expect(end.reveal).toBe(1)
  })

  it('moves smoothly: small steps in time give small steps in place through a corner', () => {
    const get = path([
      { x0: 0, y0: 0, x1: 4, y1: 0, z: 0.2 },
      { x0: 4, y0: 0, x1: 4, y1: 4, z: 0.2 },
    ])
    let last = headAt(get, 0, 0)
    let worst = 0
    for (let k = 1; k <= 200; k++) {
      const t = k / 100
      const h = t <= 1 ? headAt(get, 0, t) : headAt(get, 1, t - 1)
      worst = Math.max(worst, Math.hypot(h.x - last.x, h.y - last.y))
      last = h
    }
    // 8 mm of path in 200 steps is 0.04 mm a step on a straight line; nothing near a jump.
    expect(worst).toBeLessThan(0.08)
  })
})
