// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The look's own slice, export and command bar keys, bound by the global key handler.
import { keymapFor } from '@slicerx/ui'
import { describe, expect, it } from 'vitest'
import { lookCommandFor } from '../src/controls/global-keys'

describe("the look's own keys outside the plate", () => {
  const key = (k: string, code: string, o: Partial<KeyboardEventInit> = {}) => new KeyboardEvent('keydown', { key: k, code, ...o })
  const at = { layers: false, onControl: false }

  it('slices and exports with the look keys', () => {
    expect(lookCommandFor(key('g', 'KeyG', { ctrlKey: true }), keymapFor('bambu-studio'), at)).toBe('slice')
    expect(lookCommandFor(key('r', 'KeyR', { ctrlKey: true }), keymapFor('prusaslicer'), at)).toBe('slice')
    expect(lookCommandFor(key('g', 'KeyG', { ctrlKey: true }), keymapFor('prusaslicer'), at)).toBe('export-gcode')
    expect(lookCommandFor(key('g', 'KeyG', { ctrlKey: true }), keymapFor('slicerx'), at)).toBeNull()
  })

  it('opens the command bar with Space in the OrcaSlicer style, but not on a control or while the toolpaths show', () => {
    expect(lookCommandFor(key(' ', 'Space'), keymapFor('orcaslicer'), at)).toBe('palette')
    expect(lookCommandFor(key(' ', 'Space'), keymapFor('orcaslicer'), { ...at, onControl: true })).toBeNull()
    expect(lookCommandFor(key(' ', 'Space'), keymapFor('orcaslicer'), { ...at, layers: true })).toBeNull()
    expect(lookCommandFor(key(' ', 'Space'), keymapFor('bambu-studio'), at)).toBeNull()
  })
})
