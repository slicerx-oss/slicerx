// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An exact part shades by the crease rule a mesh part shades by, where faces of the solid meet: a fold under the
// app's crease angle is smooth and one over it stays hard, while inside each face the engine's normals stay as they
// are. On the hull of a real design (exact-hull.json, the kernel's tessellation of its first loft) the exact route and
// the mesh route, the same triangles without their normals, leave the same edges hard.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packNormals, unpackNormal } from '@slicerx/contracts'
import { weldVertices, type CreasedArrays } from '../src/mesh-math'
import { creasedGeometry } from '../src/model'

/** The arrays of the geometry a part draws with (creasedGeometry, at the app's own crease angle). */
function drawn(P: Float32Array, I: Uint32Array, N?: Int16Array): CreasedArrays {
  const g = creasedGeometry(P, I, N)
  return {
    position: g.getAttribute('position').array as Float32Array,
    normal: g.getAttribute('normal').array as Float32Array,
    index: g.getIndex()!.array as Uint32Array,
  }
}

type V = [number, number, number]

/** The normal the result gives corner k (3 * triangle + corner). */
function cornerNormal(c: CreasedArrays, k: number): V {
  const o = c.index[k]! * 3
  return [c.normal[o]!, c.normal[o + 1]!, c.normal[o + 2]!]
}

/** The packed normal of corner k, unpacked and rounded to float32 as the geometry stores it. */
function supplied(packed: Int16Array, k: number): V {
  const n = [0, 0, 0]
  unpackNormal(packed, 2 * k, n, 0)
  return [Math.fround(n[0]!), Math.fround(n[1]!), Math.fround(n[2]!)]
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const d = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!))
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI
}

function facet(P: Float32Array, I: Uint32Array, t: number): V {
  const q = (k: number): V => [P[3 * I[3 * t + k]!]!, P[3 * I[3 * t + k]! + 1]!, P[3 * I[3 * t + k]! + 2]!]
  const [a, b, c] = [q(0), q(1), q(2)]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
}

interface Edge {
  /** The two corners at each end: [corner of the first triangle, corner of the second] at the lower and higher end. */
  ends: [[number, number], [number, number]]
  triangles: [number, number]
}

/** The edges two triangles share, by welded vertices (the weld the crease rule uses), keyed "lower-higher". */
function sharedEdges(P: Float32Array, I: Uint32Array): Map<string, Edge> {
  const { map } = weldVertices(P, 1000)
  const sides = new Map<string, { t: number; at: [number, number] }[]>()
  for (let t = 0; t < I.length / 3; t++) {
    for (let j = 0; j < 3; j++) {
      const ka = 3 * t + j, kb = 3 * t + ((j + 1) % 3)
      const a = map[I[ka]!]!, b = map[I[kb]!]!
      if (a === b) continue
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      const list = sides.get(key) ?? []
      list.push({ t, at: a < b ? [ka, kb] : [kb, ka] })
      sides.set(key, list)
    }
  }
  const out = new Map<string, Edge>()
  for (const [key, list] of sides) {
    if (list.length !== 2) continue
    const [s, r] = list as [{ t: number; at: [number, number] }, { t: number; at: [number, number] }]
    out.set(key, { ends: [[s.at[0], r.at[0]], [s.at[1], r.at[1]]], triangles: [s.t, r.t] })
  }
  return out
}

/** The shared edges the result splits: a different normal at either end on its two sides. */
function hardEdges(edges: Map<string, Edge>, c: CreasedArrays): Set<string> {
  const hard = new Set<string>()
  const same = (a: V, b: V) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  for (const [key, e] of edges) {
    if (!same(cornerNormal(c, e.ends[0][0]), cornerNormal(c, e.ends[0][1])) || !same(cornerNormal(c, e.ends[1][0]), cornerNormal(c, e.ends[1][1]))) hard.add(key)
  }
  return hard
}

/**
 * Two flat strips 10 mm long meeting along the x axis at `foldDeg`, each with its own copy of the vertices on the
 * fold as a kernel's faces have, and each corner given its strip's normal.
 */
function fold(foldDeg: number): { P: Float32Array; I: Uint32Array; N: Int16Array; normals: [V, V]; onFold: (k: number) => boolean } {
  const th = (foldDeg * Math.PI) / 180
  const across: [V, V] = [[0, 1, 0], [0, -Math.cos(th), Math.sin(th)]]
  const normals: [V, V] = [[0, 0, 1], [0, Math.sin(th), Math.cos(th)]]
  const pts: number[] = []
  const ix: number[] = []
  const corners: number[] = []
  for (let s = 0; s < 2; s++) {
    const base = pts.length / 3
    for (let r = 0; r <= 2; r++) for (let x = 0; x <= 5; x++) pts.push(2 * x, 2 * r * across[s]![1], 2 * r * across[s]![2])
    const v = (x: number, r: number) => base + r * 6 + x
    for (let r = 0; r < 2; r++) {
      for (let x = 0; x < 5; x++) {
        for (const tri of [[v(x, r), v(x + 1, r), v(x + 1, r + 1)], [v(x, r), v(x + 1, r + 1), v(x, r + 1)]]) {
          const n = normals[s]!
          // wound so the facet faces the strip's normal
          const P3 = (i: number): V => [pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!]
          const [a, b, c] = tri.map(P3) as [V, V, V]
          const f = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
          if (f[0]! * n[0] + f[1]! * n[1] + f[2]! * n[2] < 0) tri.reverse()
          ix.push(...tri)
          for (let k = 0; k < 3; k++) corners.push(...n)
        }
      }
    }
  }
  const P = new Float32Array(pts)
  const I = new Uint32Array(ix)
  // a corner is on the fold when its vertex is in the first row of its strip
  const onFold = (k: number) => (I[k]! % 18) < 6
  return { P, I, N: packNormals(corners), normals, onFold }
}

describe('exact corners where two faces meet', () => {
  it('a fold of 23 degrees shades smooth: the corners on it share one normal between the faces', () => {
    const m = fold(23)
    const c = drawn(m.P, m.I, m.N)
    const bisector: V = [0, Math.sin((11.5 * Math.PI) / 180), Math.cos((11.5 * Math.PI) / 180)]
    for (let k = 0; k < m.I.length; k++) {
      if (m.onFold(k)) expect(angleDeg(cornerNormal(c, k), bisector)).toBeLessThan(0.01)
      // inside each face, the engine's normal as it is
      else expect(cornerNormal(c, k)).toEqual(supplied(m.N, k))
    }
    // and the mesh route, the same triangles without normals, leaves the same edges hard: none
    const edges = sharedEdges(m.P, m.I)
    expect(hardEdges(edges, c)).toEqual(new Set())
    expect(hardEdges(edges, drawn(m.P, m.I))).toEqual(new Set())
  })

  it('a fold of 90 degrees stays hard: every corner keeps its face normal', () => {
    const m = fold(90)
    const c = drawn(m.P, m.I, m.N)
    for (let k = 0; k < m.I.length; k++) expect(cornerNormal(c, k)).toEqual(supplied(m.N, k))
    const edges = sharedEdges(m.P, m.I)
    const hard = hardEdges(edges, c)
    expect(hard.size).toBe(5)
    expect(hardEdges(edges, drawn(m.P, m.I))).toEqual(hard)
  })
})

interface Recorded {
  triangles: number
  positions: number[]
  indices: number[]
  normals: number[]
  faceIds: number[]
}

describe('the exact hull of a real design', () => {
  const rec = JSON.parse(readFileSync(join(__dirname, 'exact-hull.json'), 'utf8')) as Recorded
  const P = new Float32Array(rec.positions)
  const I = new Uint32Array(rec.indices)
  const N = new Int16Array(rec.normals)
  const exact = drawn(P, I, N)
  const mesh = drawn(P, I)
  const edges = sharedEdges(P, I)
  const exactHard = hardEdges(edges, exact)
  const meshHard = hardEdges(edges, mesh)
  /** The fold an edge between faces makes, by the engine's normals at its two ends: [smaller, larger]. */
  const foldOf = (e: Edge): [number, number] => {
    const [a, b] = e.ends.map(([k, l]) => angleDeg(supplied(N, k), supplied(N, l))) as [number, number]
    return [Math.min(a, b), Math.max(a, b)]
  }
  const between = [...edges].filter(([, e]) => rec.faceIds[e.triangles[0]] !== rec.faceIds[e.triangles[1]])
  const inside = [...edges].filter(([, e]) => rec.faceIds[e.triangles[0]] === rec.faceIds[e.triangles[1]])
  // The two routes measure a fold in different places (the engine's normals at the vertex, a mesh part's facets across
  // its triangles), so a fold within 5 degrees of the crease angle can fall on either side; the comparison leaves those
  // out. Folds of 35 degrees and under, and of 45 and over, are compared.
  const clear = between.filter(([, e]) => foldOf(e)[1] <= 35 || foldOf(e)[0] >= 45)

  it('has folds of about 23 degrees between its faces and corners of 60 and more', () => {
    expect(rec.triangles).toBe(I.length / 3)
    expect(between.filter(([, e]) => foldOf(e)[0] >= 20 && foldOf(e)[1] <= 30).length).toBeGreaterThan(20)
    expect(between.filter(([, e]) => foldOf(e)[0] >= 60).length).toBeGreaterThan(20)
    expect(clear.length).toBeGreaterThan(400)
  })

  it('leaves the same folds hard as the mesh route on the same triangles, and no edge inside a face', () => {
    for (const [key, e] of clear) {
      const why = `${key} at ${foldOf(e).map((d) => d.toFixed(1)).join(' to ')} degrees`
      expect(exactHard.has(key), why).toBe(meshHard.has(key))
      if (foldOf(e)[1] <= 30) expect(exactHard.has(key), why).toBe(false)
      if (foldOf(e)[0] >= 60) expect(exactHard.has(key), why).toBe(true)
    }
    expect(inside.filter(([key]) => exactHard.has(key))).toEqual([])
  })

  it('shades the corners of a smoothed fold close to the mesh route: within 1 degree at z 6, within 7 anywhere', () => {
    let atSix = 0
    let anywhere = 0
    let corners = 0
    for (const [key, e] of clear) {
      if (exactHard.has(key) || meshHard.has(key)) continue
      for (const k of e.ends.flat()) {
        const off = angleDeg(cornerNormal(exact, k), cornerNormal(mesh, k))
        anywhere = Math.max(anywhere, off)
        if (Math.abs(P[3 * I[k]! + 2]! - 6) < 0.5) atSix = Math.max(atSix, off)
        corners++
      }
    }
    console.log(`CREASE hull: ${corners} smoothed fold corners, at most ${atSix.toFixed(3)} degrees from the mesh route at z 6 and ${anywhere.toFixed(3)} anywhere`)
    expect(corners).toBeGreaterThan(300)
    expect(atSix).toBeGreaterThan(0)
    expect(atSix).toBeLessThan(1)
    expect(anywhere).toBeLessThan(7)
  })

  it('keeps the engine normal bit for bit at every corner with no other normal within the angle', () => {
    const { map } = weldVertices(P, 1000)
    const at = new Map<number, number[]>()
    for (let k = 0; k < I.length; k++) at.set(map[I[k]!]!, [...(at.get(map[I[k]!]!) ?? []), k])
    let kept = 0
    for (let k = 0; k < I.length; k++) {
      const own = supplied(N, k)
      const others = at.get(map[I[k]!]!)!.filter((l) => (N[2 * l] !== N[2 * k] || N[2 * l + 1] !== N[2 * k + 1]) && angleDeg(supplied(N, l), own) < 40)
      if (others.length) continue
      expect(cornerNormal(exact, k)).toEqual(own)
      kept++
    }
    expect(kept).toBeGreaterThan(I.length / 4)
  })
})
