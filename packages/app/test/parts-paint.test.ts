// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint in the raw parts format (packages/core/src/mesh.rs, `from_raw`): an optional block after the parts with each
// painted triangle's text, so a painted object reaches the engine without a 3MF.
import { describe, expect, it } from 'vitest'
import type { MeshPart } from '@slicerx/contracts'
import { decodeParts, encodeParts } from '../../core/web/src/parts'
import { boxMesh } from '../src/plate/mesh-ops'

const part = (name: string, slot: number): MeshPart => ({ ...boxMesh(10, 10, 10), name, slot })

describe('paint in the raw parts format', () => {
  it('adds nothing when nothing is painted, so older readers see the same bytes', () => {
    const plain = [part('a', 1), part('b', 2)]
    const bytes = encodeParts(plain)
    const tail = bytes.subarray(bytes.length - 4)
    expect(new TextDecoder().decode(tail)).not.toBe('SXPT')
    expect(decodeParts(bytes).map((p) => p.paint)).toEqual([undefined, undefined])
    expect(encodeParts([{ ...part('a', 1), paint: { color: {} } }])).toEqual(encodeParts([part('a', 1)]))
  })

  it('carries every layer of every part through, triangle by triangle', () => {
    const parts = [
      { ...part('Body', 1), paint: { color: { 11: '8', 0: '0C34', 5: '4' }, seam: { 2: '4' } } },
      part('Plain', 2),
      { ...part('Fin', 3), paint: { support: { 1: '8' }, fuzzy: { 7: '4' } } },
    ]
    const back = decodeParts(encodeParts(parts))
    expect(back.map((p) => p.name)).toEqual(['Body', 'Plain', 'Fin'])
    expect(back[0]!.paint).toEqual({ color: { 0: '0C34', 5: '4', 11: '8' }, seam: { 2: '4' } })
    expect(back[1]!.paint).toBeUndefined()
    expect(back[2]!.paint).toEqual({ support: { 1: '8' }, fuzzy: { 7: '4' } })
    expect(back[0]!.positions).toEqual(parts[0]!.positions)
    expect(back[2]!.indices).toEqual(parts[2]!.indices)
  })

  it('leaves out texts on triangles the part does not have, and empty texts', () => {
    const back = decodeParts(encodeParts([{ ...part('a', 1), paint: { color: { 3: '8', 12: '4', 99: '4', 4: '' } } }]))
    expect(back[0]!.paint).toEqual({ color: { 3: '8' } })
  })

  it('refuses a paint block that runs past the end of the buffer', () => {
    const bytes = encodeParts([{ ...part('a', 1), paint: { color: { 3: '0C34' } } }])
    expect(() => decodeParts(bytes.subarray(0, bytes.length - 2))).toThrow(/Truncated paint/)
    expect(() => decodeParts(bytes.subarray(0, bytes.length - 8))).toThrow(/Truncated paint/)
  })
})
