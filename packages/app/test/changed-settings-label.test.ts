// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The link under "Settings used" counts the values changed from the preset.
import { describe, expect, it } from 'vitest'
import { changedSettingsLabel } from '../src/workspaces/preview/preview-panes'

describe('changed settings label', () => {
  it('counts every changed value', () => {
    expect(changedSettingsLabel({})).toBe('Changed settings (0)')
    expect(changedSettingsLabel({ layer_height: 0.16 })).toBe('Changed settings (1)')
    expect(changedSettingsLabel({ layer_height: 0.16, wall_loops: 3, brim_width: 0 })).toBe('Changed settings (3)')
  })
})
