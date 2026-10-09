// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { decodeParts, encodeParts } from '../../core/web/src/parts'

describe('the raw parts encoding', () => {
  it('round-trips typed arrays, views into larger buffers and plain arrays', () => {
    const big = new Float32Array([9, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0])
    const parts = [
      { name: 'a', slot: 2, positions: big.subarray(2, 11), indices: new Uint32Array([0, 1, 2]) },
      { name: 'b', slot: 1, positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0.5]), indices: [2, 1, 0] as unknown as Uint32Array },
    ]
    const back = decodeParts(encodeParts(parts))
    expect(back.map((p) => [p.name, p.slot, [...p.positions], [...p.indices]])).toEqual([
      ['a', 2, [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]],
      ['b', 1, [0, 0, 0, 2, 0, 0, 0, 2, 0.5], [2, 1, 0]],
    ])
  })
})
