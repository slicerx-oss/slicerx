// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The toolpath legend's lengths. With sleipnir's thin layers on a slope the overhang test has about 4 cm of overhang
// wall, which tenths of a meter showed as "Overhang wall 0.0 m", as if overhangs were not found at all.
import { describe, expect, it } from 'vitest'
import { lengthLabel } from '../src/lib/preview-stats'

describe('legend lengths', () => {
  it('keep tenths of a meter from 1 m up', () => {
    expect(lengthLabel(32.09)).toBe('32.1 m')
    expect(lengthLabel(1)).toBe('1.0 m')
  })

  it('show a short stretch in hundredths, never as 0.0 m', () => {
    expect(lengthLabel(0.04)).toBe('0.04 m')
    expect(lengthLabel(0.46)).toBe('0.46 m')
    expect(lengthLabel(0.001)).toBe('<0.01 m')
  })
})
