// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The playback bar's tool change words: the whole line on a wide bar, the short one on a narrow bar or a phone.
import { describe, expect, it } from 'vitest'
import { changeLabel } from '../src/workspaces/preview/change-label'

const line = (l: ReturnType<typeof changeLabel>) => `${l.lead} ${l.n} of ${l.count}${l.tail}`

describe('changeLabel', () => {
  it('says the whole change with its slot on a wide bar', () => {
    expect(line(changeLabel(false, 49, 100, 1, false))).toBe('Tool change 50 of 100, to slot 2')
    expect(line(changeLabel(true, 0, 3, 2, false))).toBe('Filament change 1 of 3, to slot 3')
  })

  it('shortens to the count on a narrow bar and keeps the whole line for the tooltip', () => {
    const l = changeLabel(false, 49, 100, 1, true)
    expect(line(l)).toBe('Change 50 of 100')
    expect(l.full).toBe('Tool change 50 of 100, to slot 2')
    expect(line(changeLabel(true, 0, 3, 2, true))).toBe('Change 1 of 3')
  })
})
