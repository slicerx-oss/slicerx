// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part keeps the faces the geometry engine sends with its mesh and sends them back with the next call, so the
// engine knows which triangles form a face across edits. A part without faces goes and comes back as before.
import { describe, expect, it } from 'vitest'
import { askFaces, fromGeom, toGeom, type GeomMesh } from '../src/geom/client'

const tile: GeomMesh = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
  faces: { ids: [0, 0], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] },
}

describe('faces on a part', () => {
  it('come with the mesh and go back with it', () => {
    const part = fromGeom(tile, 'tile', 1)
    expect(part.faces?.ids).toEqual(new Uint32Array([0, 0]))
    expect(part.faces?.table[0]).toEqual({ kind: 'plane', normal: [0, 0, 1], offset: 0 })
    expect(toGeom(part)).toEqual(tile)
  })

  it('stay out of a part that has none', () => {
    const plain = { positions: tile.positions, indices: tile.indices }
    const part = fromGeom(plain, 'tile', 1)
    expect('faces' in part).toBe(false)
    expect(toGeom(part)).toEqual(plain)
  })

  it('are asked for on every request with a body', () => {
    expect(askFaces({ op: 'union', a: [] })).toEqual({ op: 'union', a: [], withFaces: true })
    expect(askFaces([1, 2])).toEqual([1, 2])
    expect(askFaces(null)).toBe(null)
  })
})
