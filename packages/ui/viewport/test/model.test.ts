// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { BufferAttribute, BufferGeometry, EdgesGeometry, IcosahedronGeometry, SphereGeometry, TorusKnotGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { creasedGeometry, featureEdges, weldVertices } from '../src/model'
import { displayHex } from '../src/palette'

// Unit cube, 8 shared corners, 12 outward-wound triangles.
const P = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])
const I = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])

describe('creasedGeometry', () => {
  it('keeps cube faces flat: every normal is a unit axis vector', () => {
    const g = creasedGeometry(P, I)
    const n = g.getAttribute('normal').array
    // Indexed: each corner of the cube is shared by the two triangles of each face it touches, so 24 vertices.
    expect(g.getAttribute('position').count).toBe(24)
    expect(g.getIndex()?.count).toBe(36)
    for (let i = 0; i < n.length; i += 3) {
      const v = [n[i] ?? 0, n[i + 1] ?? 0, n[i + 2] ?? 0].map((x) => Math.abs(x)).sort()
      expect(v[0]).toBeCloseTo(0)
      expect(v[1]).toBeCloseTo(0)
      expect(v[2]).toBeCloseTo(1)
    }
  })
})

/** The unindexed creased geometry as it was built before it was indexed: string-keyed weld, one vertex per corner. */
function creasedReference(P: Float32Array, I: ArrayLike<number>): { pos: Float32Array; nrm: Float32Array } {
  const nt = Math.floor(I.length / 3)
  const n = P.length / 3
  const seen = new Map<string, number>()
  const wmap = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(P[3 * i]! * 1000)},${Math.round(P[3 * i + 1]! * 1000)},${Math.round(P[3 * i + 2]! * 1000)}`
    let id = seen.get(k)
    if (id === undefined) seen.set(k, (id = seen.size))
    wmap[i] = id
  }
  const fn: number[] = []
  const fu: number[] = []
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [I[3 * t]! * 3, I[3 * t + 1]! * 3, I[3 * t + 2]! * 3]
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    fu.push(Math.fround(x), Math.fround(y), Math.fround(z))
    fn.push(Math.fround(x / l), Math.fround(y / l), Math.fround(z / l))
  }
  const faces = new Map<number, number[]>()
  for (let i = 0; i < nt * 3; i++) {
    const w = wmap[I[i]!]!
    faces.set(w, [...(faces.get(w) ?? []), (i / 3) | 0])
  }
  const pos = new Float32Array(nt * 9)
  const nrm = new Float32Array(nt * 9)
  const cosA = Math.cos((40 * Math.PI) / 180)
  for (let t = 0; t < nt; t++) {
    for (let j = 0; j < 3; j++) {
      const vi = I[3 * t + j]!
      let x = 0, y = 0, z = 0
      for (const g of faces.get(wmap[vi]!)!) {
        if (fn[3 * g]! * fn[3 * t]! + fn[3 * g + 1]! * fn[3 * t + 1]! + fn[3 * g + 2]! * fn[3 * t + 2]! >= cosA) {
          x += fu[3 * g]!; y += fu[3 * g + 1]!; z += fu[3 * g + 2]!
        }
      }
      const l = Math.hypot(x, y, z) || 1
      const o = 9 * t + 3 * j
      pos.set([P[3 * vi]!, P[3 * vi + 1]!, P[3 * vi + 2]!], o)
      nrm.set([x / l, y / l, z / l], o)
    }
  }
  return { pos, nrm }
}

const meshOf = (g: BufferGeometry): { P: Float32Array; I: Uint32Array } => {
  const P = new Float32Array(g.getAttribute('position').array)
  const idx = g.getIndex()
  return { P, I: idx ? new Uint32Array(idx.array) : Uint32Array.from({ length: P.length / 3 }, (_, i) => i) }
}

const shapes = (): [string, { P: Float32Array; I: Uint32Array }][] => [
  ['cube', { P, I }],
  ['sphere with a seam', meshOf(new SphereGeometry(10, 24, 16))],
  ['torus knot', meshOf(new TorusKnotGeometry(10, 3, 64, 8))],
  ['unindexed icosahedron', meshOf(new IcosahedronGeometry(5, 1))],
]

describe('creasedGeometry against the unindexed build', () => {
  it.each(shapes())('%s: every corner keeps its position and normal', (_name, m) => {
    const g = creasedGeometry(m.P, m.I)
    const ref = creasedReference(m.P, m.I)
    const pos = g.getAttribute('position').array
    const nrm = g.getAttribute('normal').array
    const idx = g.getIndex()!.array
    expect(idx.length).toBe(m.I.length)
    for (let c = 0; c < idx.length; c++) {
      const v = idx[c]!
      for (let k = 0; k < 3; k++) {
        expect(pos[3 * v + k]).toBe(ref.pos[3 * c + k])
        expect(nrm[3 * v + k]).toBeCloseTo(ref.nrm[3 * c + k]!, 5)
      }
    }
  })

  it('shares vertices on a smooth surface', () => {
    const m = meshOf(new TorusKnotGeometry(10, 3, 128, 32))
    const g = creasedGeometry(m.P, m.I)
    // Far fewer vertices than corners: an unindexed build had one per corner.
    expect(g.getAttribute('position').count).toBeLessThan(m.I.length / 4)
  })
})

describe('weldVertices', () => {
  it('gives equal ids to positions within the grid and new ids in first-seen order', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0.0001, -0.0002, 0, 1.0004, 0, 0, -5, 3, 2])
    const { map, count } = weldVertices(pos, 1000)
    expect([...map]).toEqual([0, 1, 0, 1, 2])
    expect(count).toBe(3)
  })

  it('welds many vertices through table collisions', () => {
    const n = 20000
    const pos = new Float32Array(n * 6)
    for (let i = 0; i < n; i++) pos.set([i % 97, (i * 7) % 89, i % 13, i % 97, (i * 7) % 89, i % 13], 6 * i)
    const { map, count } = weldVertices(pos, 1000)
    const seen = new Map<string, number>()
    for (let i = 0; i < 2 * n; i++) {
      const k = `${pos[3 * i]},${pos[3 * i + 1]},${pos[3 * i + 2]}`
      if (!seen.has(k)) seen.set(k, seen.size)
      expect(map[i]).toBe(seen.get(k))
    }
    expect(count).toBe(seen.size)
  })
})

/** Segments as sorted text, each one as it was drawn (from, to). */
function segments(a: ArrayLike<number>): string[] {
  const out: string[] = []
  for (let i = 0; i + 5 < a.length; i += 6) out.push(Array.from({ length: 6 }, (_, k) => a[i + k]!.toFixed(4)).join(' '))
  return out.sort()
}

function threeEdges(m: { P: Float32Array; I: Uint32Array | null }, deg: number): string[] {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.P, 3))
  if (m.I) g.setIndex(new BufferAttribute(m.I, 1))
  return segments(new EdgesGeometry(g, deg).getAttribute('position').array)
}

describe('featureEdges', () => {
  // An open fan with a duplicate face, a flipped face, a degenerate one and a non-manifold fin on one edge.
  const odd = {
    P: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1, 0.5, 0.5, -1, 0.5, 0.5, 0, 0.50001, 0.5, 0]),
    I: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 2, 2, 1, 4, 1, 2, 5, 3, 2, 4, 6, 7, 0, 0, 2, 4, 3, 0, 4]),
  }
  const cases: [string, { P: Float32Array; I: Uint32Array | null }][] = [...shapes(), ['odd fan', odd], ['unindexed sphere', { P: new Float32Array(new SphereGeometry(4, 12, 8).toNonIndexed().getAttribute('position').array), I: null }]]
  it.each(cases)('%s: the same segments as EdgesGeometry', (_name, m) => {
    for (const deg of [1, 38, 80]) expect(segments(featureEdges(m.P, m.I, deg))).toEqual(threeEdges(m, deg))
  })
})

describe('displayHex', () => {
  it('lifts pure black and tames pure white so shading still reads', () => {
    expect(displayHex('#000000')).toBe('#1d1d21')
    expect(displayHex('#ffffff')).toBe('#ebebe6')
    expect(displayHex('#ff9016')).toBe('#ff9016')
  })
})
