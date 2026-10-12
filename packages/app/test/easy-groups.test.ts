// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { EASY_DEFAULTS } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { BRIM_PATCHES, controlKeys, countSettings, easyGroups, LAYER_PATCHES, STRENGTH_PATCHES, SUPPORT_PATCHES } from '../src/plate/easy-groups'

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

describe('the groups are worked out once for the same values and profile layer', () => {
  it('a new object with the same Easy values gets the same answer without working it out again', () => {
    const first = easyGroups({ ...EASY_DEFAULTS })
    expect(easyGroups({ ...EASY_DEFAULTS })).toBe(first)
    // Other values: their own answer, and the first one is still there for the first values.
    const other = easyGroups({ ...EASY_DEFAULTS, strength: EASY_DEFAULTS.strength === 50 ? 75 : 50 })
    expect(other).not.toBe(first)
    expect(easyGroups({ ...EASY_DEFAULTS })).toBe(first)
  })

  it('a new profile layer works the groups out again, as they were before the cache', async () => {
    const { setProfileLayer } = await import('../src/adapters/config')
    const before = easyGroups({ ...EASY_DEFAULTS })
    setProfileLayer({ layer_height: 0.16 }, ['detail'])
    try {
      const withLayer = easyGroups({ ...EASY_DEFAULTS })
      expect(withLayer).not.toBe(before)
      expect(withLayer).toEqual({
        layer: controlKeys({ ...EASY_DEFAULTS }, LAYER_PATCHES, ['detail', 'varyLayerHeight']),
        supports: controlKeys({ ...EASY_DEFAULTS }, SUPPORT_PATCHES, ['supports']),
        brim: controlKeys({ ...EASY_DEFAULTS }, BRIM_PATCHES, ['brim']),
        strength: controlKeys({ ...EASY_DEFAULTS }, STRENGTH_PATCHES, ['strength']),
      })
    } finally {
      setProfileLayer(null, [])
    }
    expect(easyGroups({ ...EASY_DEFAULTS })).toBe(before)
  })
})
