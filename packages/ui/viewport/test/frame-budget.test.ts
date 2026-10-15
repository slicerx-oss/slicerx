// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { DegradeGuard } from '../src/frame-budget'

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
