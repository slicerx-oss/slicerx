// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mesh's connected pieces (src/mesh-pieces.ts): corners shared by number or by place to 1 micrometer, indexed or as a
// triangle soup, and the order the pieces come in.
import { describe, expect, it } from 'vitest'
import { meshPieces } from '../src/mesh-pieces'

// a tetrahedron, its four corners `dx` along X
const tetra = (dx = 0) => ({ positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10].map((v, i) => (i % 3 === 0 ? v + dx : v)), indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] })

describe('meshPieces', () => {
  it('finds one piece in a closed mesh', () => {
    const t = tetra()
    const p = meshPieces(t.positions, t.indices)
    expect(p.triangles).toEqual([[0, 1, 2, 3]])
    expect(p.vertices()).toEqual([[0, 1, 2, 3]])
  })

  it('keeps separate pieces apart, in the order of their first triangle and of their lowest vertex', () => {
    const a = tetra()
    const b = tetra(30)
    // the second tetrahedron's triangles first, its vertices after the first one's
    const p = meshPieces([...a.positions, ...b.positions], [...b.indices.map((i) => i + 4), ...a.indices])
    expect(p.triangles).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]])
    expect(p.vertices()).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]])
  })

  it('joins corners at one place to 1 micrometer, and no farther', () => {
    // a triangle soup: two triangles, the second's first corner at the first's last, then 0.4 and 2 micrometers off
    const soup = (off: number) => [0, 0, 0, 10, 0, 0, 0, 10, 0, off, 10, 0, 10, 10, 0, 0, 20, 0]
    expect(meshPieces(soup(0)).triangles).toEqual([[0, 1]])
    expect(meshPieces(soup(0.0004)).triangles).toEqual([[0, 1]])
    expect(meshPieces(soup(0.002)).triangles).toEqual([[0], [1]])
  })

  it('makes a vertex no triangle uses a piece of its own, in no triangle list', () => {
    const t = tetra()
    const p = meshPieces([...t.positions, 50, 50, 50, 10, 0, 0], t.indices)
    expect(p.triangles).toEqual([[0, 1, 2, 3]])
    // the last vertex sits on corner 1, so it is part of the tetrahedron
    expect(p.vertices()).toEqual([[0, 1, 2, 3, 5], [4]])
  })

  it('finds nothing in an empty mesh', () => {
    expect(meshPieces([], []).triangles).toEqual([])
    expect(meshPieces(new Float32Array(0)).vertices()).toEqual([])
  })
})
