// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { EASY_DEFAULTS } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { countSettings, easyGroups } from '../src/plate/easy-groups'

describe('Simple counts a control once', () => {
  const groups = Object.values(easyGroups(EASY_DEFAULTS))

  it('Supports writes several keys, and they count as one setting', () => {
    const supports = easyGroups(EASY_DEFAULTS).supports
    expect(supports.length).toBeGreaterThan(1)
    expect(countSettings(supports, groups)).toBe(1)
    expect(countSettings(supports)).toBe(supports.length)
  })

  it('keys outside the groups count one each', () => {
    expect(countSettings(['wall_loops', 'sparse_infill_pattern'], [])).toBe(2)
    expect(countSettings([...easyGroups(EASY_DEFAULTS).supports, 'seam_position'], groups)).toBe(2)
  })
})
