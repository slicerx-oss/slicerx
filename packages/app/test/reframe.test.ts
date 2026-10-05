// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { reframesOnRebuild } from '../src/viewport/viewport-host'

const plate = (ids: string[], activePlate = 'plate-1') => ({ plate: ids.map((id) => ({ id })), activePlate })

describe('the camera after the plate is rebuilt', () => {
  it('frames the new objects when they replace the old ones wholesale', () => {
    // A project opened or New project: none of the objects were there before.
    expect(reframesOnRebuild(plate(['a', 'b']), plate(['c', 'd', 'e']))).toBe(true)
    // A cut of the only model: two new parts, no old id left.
    expect(reframesOnRebuild(plate(['a']), plate(['a-1', 'a-2']))).toBe(true)
    // Another plate, even one holding objects with the same ids.
    expect(reframesOnRebuild(plate(['a']), plate(['a'], 'plate-2'))).toBe(true)
    // From or to an empty plate.
    expect(reframesOnRebuild(plate([]), plate(['a']))).toBe(true)
    expect(reframesOnRebuild(plate(['a']), plate([]))).toBe(true)
  })

  it("keeps the user's camera through edits, moves and small changes", () => {
    expect(reframesOnRebuild(plate(['a', 'b']), plate(['a', 'b']))).toBe(false)
    expect(reframesOnRebuild(plate(['a', 'b']), plate(['a', 'b', 'c']))).toBe(false)
    expect(reframesOnRebuild(plate(['a', 'b']), plate(['b']))).toBe(false)
    // A cut beside other models: the others stay where the user was looking.
    expect(reframesOnRebuild(plate(['a', 'b']), plate(['a', 'b-1', 'b-2']))).toBe(false)
  })
})
