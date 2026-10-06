// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { layerHeights } from '../src/workspaces/layer-strip'

describe('layer strip heights', () => {
  it('reads each layer from the one below, and the first layer of each object printed by object from the bed', () => {
    // Two objects by object: 0.2 mm layers to 0.6 mm, then the second starts again at 0.2 mm.
    const h = layerHeights(new Float32Array([0.2, 0.4, 0.6, 0.2, 0.4]))
    expect(h.map((v) => Math.round(v * 100) / 100)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2])
    expect(Math.min(...h)).toBeGreaterThan(0)
    expect(layerHeights([0.28, 0.48, 0.56]).map((v) => Math.round(v * 100) / 100)).toEqual([0.28, 0.2, 0.08])
  })
})
