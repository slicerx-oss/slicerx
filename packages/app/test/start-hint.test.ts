// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Chamfer start hint: it lasts while the fillet tool is open, so a panel that mounts again still starts as
// Chamfer, and it is gone once the tool closes.
import { beforeEach, describe, expect, it } from 'vitest'
import { filletKindHint, startFillet } from '../src/cad/start-hint'
import { set } from '../src/state/store'

beforeEach(() => set({ objectTool: null }))

describe('start hint', () => {
  it('answers more than once while the tool is open, and ends when the tool closes', () => {
    startFillet('chamfer')
    set({ objectTool: 'fillet' })
    expect(filletKindHint()).toBe('chamfer')
    expect(filletKindHint()).toBe('chamfer')
    set({ objectTool: null })
    expect(filletKindHint()).toBeNull()
  })

  it('ends when another tool takes the place of the fillet tool', () => {
    startFillet('chamfer')
    set({ objectTool: 'fillet' })
    set({ objectTool: 'measure' })
    expect(filletKindHint()).toBeNull()
  })

  it('a new request replaces the old one', () => {
    startFillet('chamfer')
    startFillet('fillet')
    set({ objectTool: 'fillet' })
    expect(filletKindHint()).toBe('fillet')
  })
})
