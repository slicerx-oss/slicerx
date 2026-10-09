// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Objects card's words and counts: the header count, the override badge and the part swatches on a row.
import { describe, expect, it } from 'vitest'
import { overrideCount, overrideText, ROLE_ICON, rowSwatches } from '../src/workspaces/prepare/object-row'
import { onPlate } from '../src/workspaces/prepare/objects-card'

describe('Objects card', () => {
  it('counts what is on the plate', () => {
    expect(onPlate(1)).toBe('1 on plate')
    expect(onPlate(3)).toBe('3 on plate')
  })

  it('counts an object\'s own settings with its parts\' and says so', () => {
    expect(overrideCount(undefined, undefined)).toBe(0)
    expect(overrideCount({ wall_loops: 4 }, { Hull: { sparse_infill_density: '20%', top_shell_layers: 5 } })).toBe(3)
    expect(overrideText(1)).toBe('1 setting differs from the plate')
    expect(overrideText(2)).toBe('2 settings differ from the plate')
  })

  it('shows up to four part colors, then three and a count', () => {
    expect(rowSwatches(['#1', '#2'])).toEqual({ shown: ['#1', '#2'], more: 0 })
    expect(rowSwatches(['#1', '#2', '#3', '#4'])).toEqual({ shown: ['#1', '#2', '#3', '#4'], more: 0 })
    expect(rowSwatches(['#1', '#2', '#3', '#4', '#5'])).toEqual({ shown: ['#1', '#2', '#3'], more: 2 })
  })

  it('draws each volume role with its icon', () => {
    expect(ROLE_ICON).toEqual({ negative: 'negative-part', support_blocker: 'support-blocker', support_enforcer: 'support-enforcer', modifier: 'modifier' })
  })
})
