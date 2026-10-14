// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tool the 3D view runs for the app's tool. Scale shows the view's scale handles; before, it ran plain selection,
// so picking Scale and clicking a model showed nothing on the plate.
import { describe, expect, it } from 'vitest'
import { viewportTool } from '../src/viewport/viewport-host'

describe('the viewport tool', () => {
  it('shows the scale handles for the scale tool', () => {
    expect(viewportTool('scale', false, true)).toBe('scale')
  })

  it('passes the handle tools through', () => {
    for (const t of ['move', 'rotate', 'face', 'paint', 'probe', 'select'] as const) expect(viewportTool(t, false, true)).toBe(t)
  })

  it('only selects on a phone in Slice', () => {
    for (const t of ['scale', 'move', 'rotate'] as const) expect(viewportTool(t, 'slim', true)).toBe('select')
  })

  it('keeps the move, rotate and scale handles on a phone in Model, and selects for every other tool', () => {
    for (const t of ['scale', 'move', 'rotate'] as const) expect(viewportTool(t, 'model', true)).toBe(t)
    for (const t of ['face', 'paint', 'probe', 'brim', 'select'] as const) expect(viewportTool(t, 'model', true)).toBe('select')
  })

  it('runs the brim tool as a selection when the view has no brim mode', () => {
    expect(viewportTool('brim', false, true)).toBe('brim')
    expect(viewportTool('brim', false, false)).toBe('select')
  })
})
