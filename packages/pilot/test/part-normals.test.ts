// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact corner normals (MeshPart.normals) through the skills' own copies of a part: a straight move keeps them, a
// turn or a scale leaves them behind. Never a normal that no longer fits its triangle.
import type { MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { transformParts } from '../skills/orientation_search/geometry'
import { dropToBed } from '../skills/resume_from_layer/index'
import { scaleParts } from '../skills/scale_with_tolerance/index'

// one triangle facing up, its three corners' packed normals straight up
const part = (): MeshPart => ({ name: 'Plate', slot: 2, positions: new Float32Array([0, 0, 5, 10, 0, 5, 0, 10, 5]), indices: new Uint32Array([0, 1, 2]), normals: new Int16Array(6) })

describe('exact normals through the skills', () => {
  it('a turned copy has none', () => {
    const [turned] = transformParts([part()], [90, 0, 0])
    expect(turned).toBeDefined()
    expect('normals' in turned!).toBe(false)
    // the rest of the part came along, and the vertices did turn
    expect(turned!.name).toBe('Plate')
    expect(turned!.slot).toBe(2)
    expect(Array.from(turned!.indices)).toEqual([0, 1, 2])
    expect(Array.from(turned!.positions)).not.toEqual(Array.from(part().positions))
  })

  it('no turn hands the same parts back, normals and all', () => {
    const parts = [part()]
    expect(transformParts(parts, [0, 0, 0])).toBe(parts)
  })

  it('a part moved down to the bed keeps them', () => {
    const p = part()
    const moved = dropToBed(p, 5)
    expect(moved.normals).toBe(p.normals)
    expect(Array.from(moved.positions)).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0])
  })

  it('a scaled copy has none', () => {
    const [scaled] = scaleParts([part()], 2)
    expect('normals' in scaled!).toBe(false)
    expect(scaled!.name).toBe('Plate')
    expect(Array.from(scaled!.positions)).toEqual([0, 0, 10, 20, 0, 10, 0, 20, 10])
  })
})
