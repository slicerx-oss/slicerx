// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Ctrl (Cmd) and a click add an object to the selection or take it out; the primary stays unless it is taken out.
import { describe, expect, it } from 'vitest'
import { toggledSelection } from '../src/state/store'

describe('toggling an object in the selection', () => {
  it('adds an object, keeping the primary', () => {
    expect(toggledSelection({ selection: 'a', selectedIds: [] }, 'b')).toEqual({ selection: 'a', selectedIds: ['a', 'b'], towerSelected: false })
  })

  it('takes one out, and the last one left becomes the primary when the primary goes', () => {
    expect(toggledSelection({ selection: 'a', selectedIds: ['a', 'b', 'c'] }, 'b')).toEqual({ selection: 'a', selectedIds: ['a', 'c'], towerSelected: false })
    expect(toggledSelection({ selection: 'a', selectedIds: ['a', 'c'] }, 'a')).toEqual({ selection: 'c', selectedIds: ['c'], towerSelected: false })
  })

  it('starts a selection from nothing and ends it at nothing', () => {
    expect(toggledSelection({ selection: null, selectedIds: [] }, 'a')).toEqual({ selection: 'a', selectedIds: ['a'], towerSelected: false })
    expect(toggledSelection({ selection: 'a', selectedIds: ['a'] }, 'a')).toEqual({ selection: null, selectedIds: [], towerSelected: false })
  })
})
