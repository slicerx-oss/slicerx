// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The stand-in slicer (used when the engine's wasm is not built) keeps a model's parts and filament slots, as the
// real engine does, so a two color plate stays two colors in local runs and their multi-filament cases behave as in CI.
import { describe, expect, it } from 'vitest'
import { createFakeSlicer } from '../../core/web/src/fake'

const part = (name: string, slot: number, z: number) => ({ name, slot, positions: new Float32Array([0, 0, 0, 10, 20, z]), indices: new Uint32Array([0, 1, 0]) })

describe('the stand-in slicer', () => {
  it('keeps each part, its filament slot and the real size', async () => {
    const h = await createFakeSlicer().loadParts('Layered X', [part('X', 1, 30), part('Base', 2, 5)])
    expect(h.parts.map((p) => [p.name, p.slot, p.triangles])).toEqual([['X', 1, 1], ['Base', 2, 1]])
    expect(h.bboxMm).toEqual([10, 20, 30])
  })

  it('still answers a file it cannot read with one part on the first filament', async () => {
    const h = await createFakeSlicer().loadModel(new ArrayBuffer(184), 'cube.stl')
    expect(h.parts).toEqual([{ name: 'cube.stl', slot: 1, triangles: 2 }])
  })
})
