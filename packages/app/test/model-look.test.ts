// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tab draws geometry in the CAD look (X-ray still works there); Slice keeps the look picked for it.
import { describe, expect, it } from 'vitest'
import { modelLook } from '../src/viewport/viewport-host'

describe('the look the view draws', () => {
  it('is the CAD look in Model, X-ray when asked, and the picked look in Slice', () => {
    expect(modelLook({ workspace: 'prepare', modelMode: 'design', look: 'studio' })).toBe('cad')
    expect(modelLook({ workspace: 'prepare', modelMode: 'design', look: 'filament' })).toBe('cad')
    expect(modelLook({ workspace: 'prepare', modelMode: 'design', look: 'xray' })).toBe('xray')
    expect(modelLook({ workspace: 'prepare', modelMode: 'slice', look: 'studio' })).toBe('studio')
    expect(modelLook({ workspace: 'prepare', modelMode: 'slice', look: 'clay' })).toBe('clay')
  })
})
