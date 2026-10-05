// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { FirstFrameGate } from '../src/firstframe'

describe('FirstFrameGate', () => {
  it('holds work until the first frame, then runs it once', () => {
    const g = new FirstFrameGate()
    const ran: number[] = []
    g.after(() => ran.push(1))
    g.after(() => ran.push(2))
    expect(ran).toEqual([])
    expect(g.ms).toBeNull()
    g.frame()
    expect(ran).toEqual([1, 2])
    expect(g.ms).not.toBeNull()
    g.frame()
    expect(ran).toEqual([1, 2])
  })
  it('runs late work at once', () => {
    const g = new FirstFrameGate()
    g.frame()
    let n = 0
    g.after(() => n++)
    expect(n).toBe(1)
  })
})
