// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { adjacencyOf, facePatch, layOnFaceTransform, rotationBetween, triangleAdjacency } from '../src/faces'

// Unit cube, outward wound, two triangles per face; the top (+Z) face is triangles 8 and 9.
const P = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
const I = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])

function apply(m: number[], v: [number, number, number]): [number, number, number] {
  return [
    (m[0] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[8] ?? 0) * v[2] + (m[12] ?? 0),
    (m[1] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[9] ?? 0) * v[2] + (m[13] ?? 0),
    (m[2] ?? 0) * v[0] + (m[6] ?? 0) * v[1] + (m[10] ?? 0) * v[2] + (m[14] ?? 0),
  ]
}

describe('facePatch', () => {
  it('finds both triangles of a cube face and nothing else', () => {
    for (let t = 0; t < 12; t++) {
      const p = facePatch(P, I, t)
      expect(p?.triangles).toHaveLength(2)
      expect(p?.areaMm2).toBeCloseTo(1, 5)
    }
  })

  it('reports the outward normal', () => {
    const top = facePatch(P, I, I.length / 3 - 1 - 3)
    const found = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((t) => facePatch(P, I, t)?.normal ?? [0, 0, 0])
    expect(found.some((n) => (n[2] ?? 0) > 0.99)).toBe(true)
    expect(found.some((n) => (n[2] ?? 0) < -0.99)).toBe(true)
    expect(top).not.toBeNull()
  })

  it('has three neighbors per triangle on a closed mesh', () => {
    expect([...triangleAdjacency(I)].every((n) => n >= 0)).toBe(true)
  })

  it('does not leak across a gentle curve', () => {
    // Fan of triangles bending 5 degrees per step around a shared axis.
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i <= 6; i++) {
      const a = (i * 5 * Math.PI) / 180
      pos.push(i, 0, 0, i, Math.cos(a), Math.sin(a))
    }
    for (let i = 0; i < 6; i++) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3)
    const p = facePatch(pos, idx, 0, 1)
    expect(p?.triangles.length).toBeLessThanOrEqual(2)
  })

  it('returns null for a bad seed or a degenerate triangle', () => {
    expect(facePatch(P, I, 99)).toBeNull()
    expect(facePatch(new Float32Array(9), new Uint32Array([0, 1, 2]), 0)).toBeNull()
  })
})

describe('rotationBetween and layOnFaceTransform', () => {
  it('takes one direction onto another and keeps the center fixed', () => {
    const c: [number, number, number] = [10, 20, 30]
    const m = rotationBetween([1, 0, 0], [0, 0, -1], c)
    const d = apply(m, [11, 20, 30])
    expect(d[0]).toBeCloseTo(10, 6)
    expect(d[2]).toBeCloseTo(29, 6)
    expect(apply(m, c)).toEqual(c.map((v) => expect.closeTo(v, 6)))
  })

  it('handles opposite and equal directions', () => {
    const flip = rotationBetween([0, 0, 1], [0, 0, -1])
    expect(apply(flip, [0, 0, 1])[2]).toBeCloseTo(-1, 6)
    expect(rotationBetween([0, 1, 0], [0, 1, 0])).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('lays a side face down: the face normal ends up pointing down', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const t = layOnFaceTransform(identity, [1, 0, 0], [0.5, 0.5, 0.5])
    const n = apply(t, [1, 0.5, 0.5])
    const c = apply(t, [0.5, 0.5, 0.5])
    expect(n[2] - c[2]).toBeCloseTo(-0.5, 6)
    expect(Math.hypot(n[0] - c[0], n[1] - c[1])).toBeCloseTo(0, 6)
  })
})

describe('unwelded meshes', () => {
  it('finds neighbors across duplicated vertices', () => {
    // The cube with every triangle given its own three vertices, as an STL loader produces.
    const pos: number[] = []
    const idx: number[] = []
    for (let t = 0; t < 12; t++) {
      for (let k = 0; k < 3; k++) {
        const v = 3 * (I[3 * t + k] ?? 0)
        pos.push(P[v] ?? 0, P[v + 1] ?? 0, P[v + 2] ?? 0)
        idx.push(3 * t + k)
      }
    }
    const adj = adjacencyOf(pos, idx)
    expect([...adj].every((n) => n >= 0)).toBe(true)
    expect(facePatch(pos, idx, 0)?.triangles).toHaveLength(2)
    // Raw indices alone would see no shared edges at all.
    expect([...triangleAdjacency(idx)].every((n) => n === -1)).toBe(true)
  })
})
