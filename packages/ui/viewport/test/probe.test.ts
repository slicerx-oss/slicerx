// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { spread } from '../src/probe'

describe('frame probe', () => {
  it('summarizes frame times', () => {
    const s = spread([16, 17, 15, 50, 16, 16, 17, 16, 15, 16])
    expect(s.n).toBe(10)
    expect(s.p50).toBe(16)
    expect(s.max).toBe(50)
    expect(s.p95).toBe(50)
    expect(s.mean).toBeCloseTo(19.4)
  })

  it('reads zero for no frames', () => {
    expect(spread([])).toEqual({ n: 0, mean: 0, p50: 0, p95: 0, max: 0 })
  })
})
