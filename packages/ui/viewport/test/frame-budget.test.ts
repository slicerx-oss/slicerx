// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { DegradeGuard, MOTION_FLOOR, MOTION_FLOOR_WEAK, MotionTuner } from '../src/frame-budget'

const feed = (t: MotionTuner, ms: number, n: number): void => {
  for (let i = 0; i < n; i++) t.sample(ms)
}

describe('MotionTuner', () => {
  it('starts moving frames at full quality on a capable GPU and keeps them there while frames are fast', () => {
    const t = new MotionTuner()
    expect(t.level).toEqual({ full: true, scale: 1 })
    feed(t, 8, 500)
    expect(t.level).toEqual({ full: true, scale: 1 })
  })

  it('starts a weak GPU one step down, and steps it up when it has room', () => {
    const t = new MotionTuner({ weak: true })
    expect(t.level.full).toBe(false)
    feed(t, 6, 30)
    expect(t.level).toEqual({ full: true, scale: 1 })
  })

  it('drops MSAA and AO first, then shrinks, and never below the floor', () => {
    const t = new MotionTuner()
    feed(t, 25, 4)
    expect(t.level).toEqual({ full: false, scale: 1 })
    feed(t, 25, 4)
    expect(t.level.scale).toBeLessThan(1)
    expect(t.level.scale).toBeGreaterThanOrEqual(MOTION_FLOOR)
    feed(t, 200, 200)
    expect(t.level.scale).toBe(MOTION_FLOOR)
    expect(t.atFloor).toBe(true)
  })

  it('lets a weak GPU go lower, to its own floor', () => {
    const t = new MotionTuner({ weak: true })
    feed(t, 200, 200)
    expect(t.level.scale).toBe(MOTION_FLOOR_WEAK)
  })

  it('does not step down on a single slow frame', () => {
    const t = new MotionTuner()
    feed(t, 8, 10)
    t.sample(300)
    feed(t, 8, 10)
    expect(t.level).toEqual({ full: true, scale: 1 })
  })

  it('steps back up to full quality once frames are cheap again', () => {
    const t = new MotionTuner()
    feed(t, 40, 40)
    expect(t.atFloor).toBe(true)
    feed(t, 5, 30 * 6)
    expect(t.level).toEqual({ full: true, scale: 1 })
  })

  it('waits longer before stepping up again when a step up did not hold', () => {
    const t = new MotionTuner()
    feed(t, 25, 4)
    expect(t.full).toBe(false)
    feed(t, 5, 30)
    expect(t.full).toBe(true)
    // the step up was too much: down again soon after
    feed(t, 25, 4)
    expect(t.full).toBe(false)
    feed(t, 5, 30)
    expect(t.full).toBe(false)
    feed(t, 5, 30)
    expect(t.full).toBe(true)
  })
})

describe('DegradeGuard', () => {
  it('never steps down while moving frames can still shrink', () => {
    const g = new DegradeGuard()
    for (let i = 0; i < 100; i++) expect(g.sample(80, false, 1)).toBe(null)
    expect(g.degraded).toBe(false)
  })

  it('steps down only after a run of slow frames at the floor, not a stall or two', () => {
    const g = new DegradeGuard()
    for (let i = 0; i < 5; i++) expect(g.sample(500, true, 1)).toBe(null)
    for (let i = 0; i < 10; i++) g.sample(10, true, 1)
    expect(g.degraded).toBe(false)
    let step = null
    for (let i = 0; i < 8 && !step; i++) step = g.sample(50, true, 1)
    expect(step).toBe('degrade')
    expect(g.degraded).toBe(true)
  })

  it('comes back when frames show the full size would be fast, and waits longer after another step down', () => {
    const g = new DegradeGuard()
    for (let i = 0; i < 8; i++) g.sample(50, true, 1)
    expect(g.degraded).toBe(true)
    // 2x screen at a pixel ratio of 1: 4 times the pixels. 5 ms now would be about 20 ms at full size: not yet.
    for (let i = 0; i < 200; i++) expect(g.sample(5, false, 4)).toBe(null)
    let n = 0
    let step = null
    while (!step && n < 1000) {
      step = g.sample(2, false, 4)
      n++
    }
    expect(step).toBe('recover')
    expect(n).toBe(60)
    for (let i = 0; i < 8; i++) g.sample(50, true, 1)
    expect(g.degraded).toBe(true)
    n = 0
    step = null
    while (!step && n < 1000) {
      step = g.sample(2, false, 4)
      n++
    }
    expect(n).toBe(120)
  })
})
