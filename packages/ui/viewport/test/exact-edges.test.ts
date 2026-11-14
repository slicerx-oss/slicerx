// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Edge lines on an exact part (featureEdges with the kernel's normals and face ids): a line only between two faces, and
// only where the part's shading breaks (creasedArrays at CREASE_DEG): none inside a face, along a tangent edge or along
// the join of two pieces of a smooth loft, open borders as before. A part without a face id for every triangle, or
// without the kernel's normals, draws the very bytes it drew before, and the worker draws what the page does.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineBasicMaterial, MeshBasicMaterial, TorusKnotGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { NO_NORMAL, packNormals, unpackNormal } from '@slicerx/contracts'
import { creasedArrays, CREASE_DEG, featureEdges, SHADE_BREAK_DEG, weldVertices, type ExactFaces } from '../src/mesh-math'
import { MeshBuildPool, type MeshWorkerLike } from '../src/mesh-pool'
import { answerMeshBuild, type MeshBuildReply, type MeshBuildRequest } from '../src/mesh-worker'
import { buildObject, type ObjectEntry, type SharedParts } from '../src/model'
import type { ViewportObject, ViewportPart } from '../src/types'
import { boxSoup } from './exact-normals-meshes'

/** The unit normal turned `deg` from +z toward +y. */
function tilt(deg: number): number[] {
  const r = (deg * Math.PI) / 180
  return [0, Math.sin(r), Math.cos(r)]
}

/**
 * Two triangles on the edge from (0,0,0) to (1,0,0): one flat and facing +z, the other folded `fold` degrees about the
 * edge. The kernel's normals are +z on the first and, on the second, `atEdge` degrees at the edge's two corners and
 * `fold` at its far one; `faces` are the two triangles' face ids.
 */
function hinge(o: { fold: number; atEdge: number; faces: [number, number] }): { positions: Float32Array; indices: Uint32Array; exact: ExactFaces } {
  const r = (o.fold * Math.PI) / 180
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, -Math.cos(r), Math.sin(r)])
  const indices = new Uint32Array([0, 1, 2, 1, 0, 3])
  const up = [0, 0, 1]
  const e = tilt(o.atEdge)
  const normals = packNormals([...up, ...up, ...up, ...e, ...e, ...tilt(o.fold)])
  return { positions, indices, exact: { normals, faceIds: new Uint32Array(o.faces) } }
}

/** Whether the segments hold the shared edge, either way round. */
function drawsShared(segments: Float32Array): boolean {
  for (let s = 0; s + 5 < segments.length; s += 6) {
    const ends = [Array.from(segments.subarray(s, s + 3)).join(','), Array.from(segments.subarray(s + 3, s + 6)).join(',')].sort()
    if (ends[0] === '0,0,0' && ends[1] === '1,0,0') return true
  }
  return false
}

describe('edges of an exact part', () => {
  it('draw no line between two triangles of one flat face', () => {
    const m = hinge({ fold: 0, atEdge: 0, faces: [3, 3] })
    const out = featureEdges(m.positions, m.indices, 38, m.exact)
    expect(drawsShared(out)).toBe(false)
    // the four open borders
    expect(out.length / 6).toBe(4)
  })

  it('draw no line inside one face even where its triangles fold past the mesh angle', () => {
    const m = hinge({ fold: 60, atEdge: 60, faces: [3, 3] })
    expect(drawsShared(featureEdges(m.positions, m.indices, 38))).toBe(true)
    expect(drawsShared(featureEdges(m.positions, m.indices, 38, m.exact))).toBe(false)
  })

  it('draw no line along the join of two pieces of a smooth loft, which shades as one surface', () => {
    expect([CREASE_DEG, SHADE_BREAK_DEG]).toEqual([40, 1])
    // two faces of one loft, each a straight piece, 11 and 23 degrees apart: shaded the same on both sides of the join
    for (const fold of [11, 23, 39]) {
      const m = hinge({ fold, atEdge: fold, faces: [0, 1] })
      const shaded = creasedArrays(m.positions, m.indices, CREASE_DEG, m.exact.normals)
      expect(shaded.normal.subarray(3 * shaded.index[0]!, 3 * shaded.index[0]! + 3)).toEqual(shaded.normal.subarray(3 * shaded.index[4]!, 3 * shaded.index[4]! + 3))
      const out = featureEdges(m.positions, m.indices, 38, m.exact)
      expect([fold, drawsShared(out)]).toEqual([fold, false])
      expect(out.length / 6).toBe(4)
    }
  })

  it('draw a line where the shading breaks: two faces past the crease angle', () => {
    for (const fold of [41, 60]) {
      const m = hinge({ fold, atEdge: fold, faces: [0, 1] })
      const out = featureEdges(m.positions, m.indices, 38, m.exact)
      expect([fold, drawsShared(out)]).toEqual([fold, true])
      // the line and the four open borders
      expect(out.length / 6).toBe(5)
    }
  })

  it('draw no line along a fillet, where the faces meet tangent', () => {
    // the fillet's first triangle folds 45 degrees from the flat one, but at the edge the surfaces share a normal
    const m = hinge({ fold: 45, atEdge: 0, faces: [0, 1] })
    expect(drawsShared(featureEdges(m.positions, m.indices, 38))).toBe(true)
    const out = featureEdges(m.positions, m.indices, 38, m.exact)
    expect(drawsShared(out)).toBe(false)
    expect(out.length / 6).toBe(4)
  })

  it('draw a sharp edge between two faces', () => {
    const m = hinge({ fold: 90, atEdge: 90, faces: [0, 1] })
    expect(drawsShared(featureEdges(m.positions, m.indices, 38, m.exact))).toBe(true)
  })

  it('follow the crease rule shading where the kernel gave no normal: a real fold draws, a flat one does not', () => {
    // the folded triangle shades by the crease rule; at 9 degrees it averages in the flat one, 4.5 degrees off the
    // kernel's normal there, which shows
    for (const [fold, drawn] of [[45, true], [0, false], [9, true]] as const) {
      const m = hinge({ fold, atEdge: fold, faces: [0, 1] })
      // the second triangle with no kernel normal at any corner, the first exact
      const normals = m.exact.normals.slice().fill(NO_NORMAL, 6, 12)
      expect([fold, drawsShared(featureEdges(m.positions, m.indices, 38, { normals, faceIds: m.exact.faceIds }))]).toEqual([fold, drawn])
    }
    // nor inside one face, whatever the fold
    const m = hinge({ fold: 60, atEdge: 60, faces: [2, 2] })
    expect(drawsShared(featureEdges(m.positions, m.indices, 38, { normals: m.exact.normals.slice().fill(NO_NORMAL, 6, 12), faceIds: m.exact.faceIds }))).toBe(false)
  })

  it('draw the twelve edges of a box, and no diagonal inside its sides', () => {
    const { positions, indices } = boxSoup(10, 20, 30)
    const nt = indices.length / 3
    const corners: number[] = []
    // the box's quads come two triangles each, every corner with its side's normal
    const sides = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]]
    for (let t = 0; t < nt; t++) corners.push(...sides[t >> 1]!, ...sides[t >> 1]!, ...sides[t >> 1]!)
    const out = featureEdges(positions, indices, 38, { normals: packNormals(corners), faceIds: Uint32Array.from({ length: nt }, (_, t) => t >> 1) })
    expect(out.length / 6).toBe(12)
    expect(out).toEqual(featureEdges(positions, indices, 38))
  })

  it('draw open borders as before', () => {
    // one triangle alone: every side is a border
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    const exact = { normals: packNormals([0, 0, 1, 0, 0, 1, 0, 0, 1]), faceIds: new Uint32Array([0]) }
    const out = featureEdges(positions, indices, 38, exact)
    expect(out.length / 6).toBe(3)
    expect(out).toEqual(featureEdges(positions, indices, 38))
  })
})

interface Recorded {
  positions: number[]
  indices: number[]
  normals: number[]
  faceIds: number[]
}

describe('edges of the exact hull of a real design', () => {
  // the kernel's tessellation of a loft through sections of straight pieces (exact-hull.json): its pieces' faces join
  // at about 23 degrees and shade as one surface, and its corners of 60 degrees and more shade hard
  const rec = JSON.parse(readFileSync(join(__dirname, 'exact-hull.json'), 'utf8')) as Recorded
  const P = new Float32Array(rec.positions)
  const I = new Uint32Array(rec.indices)
  const exact = { normals: new Int16Array(rec.normals), faceIds: Uint32Array.from(rec.faceIds) }
  const out = featureEdges(P, I, 38, exact)

  /** Each join between two faces, by welded ends: the kernel's angle across it, at the end where it is larger. */
  function joins(): Map<string, number> {
    const { map } = weldVertices(P, 1e4)
    const at = new Map<string, number[]>()
    for (let k = 0; k < I.length; k++) {
      const a = map[I[k]!]!, b = map[I[3 * ((k / 3) | 0) + ((k % 3) + 1) % 3]!]!
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      at.set(key, [...(at.get(key) ?? []), k])
    }
    const next = (c: number): number => 3 * ((c / 3) | 0) + ((c % 3) + 1) % 3
    const angle = (x: number, y: number): number => {
      const u = [0, 0, 0], v = [0, 0, 0]
      unpackNormal(exact.normals, 2 * x, u, 0)
      unpackNormal(exact.normals, 2 * y, v, 0)
      return (Math.acos(Math.min(1, u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!)) * 180) / Math.PI
    }
    const res = new Map<string, number>()
    for (const [key, c] of at) {
      if (c.length !== 2 || exact.faceIds[(c[0]! / 3) | 0] === exact.faceIds[(c[1]! / 3) | 0]) continue
      res.set(key, Math.max(angle(c[0]!, next(c[1]!)), angle(next(c[0]!), c[1]!)))
    }
    return res
  }

  it('draws no line along the joins the shading smooths over, and one along every corner of 60 degrees and more', () => {
    const { map } = weldVertices(P, 1e4)
    const id = new Map<string, number>()
    for (let i = 0; i < P.length / 3; i++) id.set([P[3 * i], P[3 * i + 1], P[3 * i + 2]].join(','), map[i]!)
    const drawn = new Set<string>()
    for (let s = 0; s < out.length; s += 6) {
      const a = id.get(Array.from(out.subarray(s, s + 3)).join(','))!, b = id.get(Array.from(out.subarray(s + 3, s + 6)).join(','))!
      drawn.add(a < b ? `${a}-${b}` : `${b}-${a}`)
    }
    const all = joins()
    const smooth = [...all].filter(([, deg]) => deg <= 30)
    const corners = [...all].filter(([, deg]) => deg >= 60)
    expect(smooth.length).toBeGreaterThan(80)
    expect(corners.length).toBeGreaterThan(200)
    expect(smooth.filter(([key]) => drawn.has(key))).toEqual([])
    expect(corners.filter(([key]) => !drawn.has(key))).toEqual([])
    // every line on the hull is a corner of it: the joins at 23 degrees take none
    expect(out.length / 6).toBe(356)
  })
})

/** A knot of square section: its four rails fold 90 degrees, past the mesh rule's angle. */
function knot(): { positions: Float32Array; indices: Uint32Array } {
  const g = new TorusKnotGeometry(10, 3, 64, 4)
  return { positions: g.getAttribute('position').array as Float32Array, indices: new Uint32Array(g.getIndex()!.array) }
}

/** Every triangle's own normal at its three corners, packed: an exact part whose faces are the given groups. */
function exactKnot(faceOf: (t: number) => number): { positions: Float32Array; indices: Uint32Array; exact: { normals: Int16Array; faceIds: Uint32Array } } {
  const { positions: P, indices: I } = knot()
  const nt = I.length / 3
  const corners: number[] = []
  for (let t = 0; t < nt; t++) {
    const v = (j: number) => [P[3 * I[3 * t + j]!]!, P[3 * I[3 * t + j]! + 1]!, P[3 * I[3 * t + j]! + 2]!]
    const [a, b, c] = [v(0), v(1), v(2)]
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
    corners.push(...n, ...n, ...n)
  }
  return { positions: P, indices: I, exact: { normals: packNormals(corners), faceIds: Uint32Array.from({ length: nt }, (_, t) => faceOf(t)) } }
}

const sha = (a: Float32Array): string => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex')

/** featureEdges(knot, 38) as it was drawn before edges read the kernel's faces: the floats' count and sha256. */
const BEFORE = { floats: 1572, sha: 'c4075b3019856063b2a1024d092a97bf012dda6e332c7aebcef407842f1e761b' }

describe('edges of a part without the kernel faces', () => {
  it('are the bytes they were before: no faces, a face id short, normals of other triangles or none set', () => {
    const { positions: P, indices: I, exact } = exactKnot((t) => t % 7)
    const nt = I.length / 3
    // every other triangle a mesh triangle
    const partly = exact.normals.slice()
    for (let t = 1; t < nt; t += 2) partly.fill(NO_NORMAL, 6 * t, 6 * t + 6)
    const short = exact.faceIds.subarray(1)
    const cases: [string, ExactFaces | undefined][] = [
      ['no faces', undefined],
      ['a face id short', { normals: exact.normals, faceIds: short }],
      ['partly exact and a face id short', { normals: partly, faceIds: short }],
      ['normals of other triangles', { normals: exact.normals.subarray(6), faceIds: exact.faceIds }],
      // a mesh part's face ids with no corner set, as a part of the mesh engine's carries them
      ['face ids and no normal set', { normals: new Int16Array(6 * nt).fill(NO_NORMAL), faceIds: exact.faceIds }],
    ]
    for (const [what, faces] of cases) {
      const out = featureEdges(P, I, 38, faces)
      expect({ what, floats: out.length, sha: sha(out) }).toEqual({ what, ...BEFORE })
    }
  })

  it('built in a part are the bytes they were before: normals alone, partly normals alone, face ids alone', () => {
    const { positions, indices, exact } = exactKnot((t) => t % 7)
    const partly = exact.normals.slice().fill(NO_NORMAL, 0, 6)
    for (const part of [{ normals: exact.normals }, { normals: partly }, { faceIds: exact.faceIds }]) {
      const e = buildObject(object('k', { name: 'k', positions, indices, color: '#808080', ...part }), () => new MeshBasicMaterial(), edgeMat)
      const out = e.parts[0]!.edges.geometry.getAttribute('position').array as Float32Array
      expect({ floats: out.length, sha: sha(out) }).toEqual(BEFORE)
    }
  })
})

const edgeMat = new LineBasicMaterial()
const object = (id: string, part: ViewportPart): ViewportObject => ({ id, name: id, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], parts: [part] })

/** A worker in this thread that answers a tick later and counts the edges jobs it was sent. */
class CountingWorker implements MeshWorkerLike {
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  static edges: MeshBuildRequest[] = []
  postMessage(message: MeshBuildRequest): void {
    if (message.kind === 'edges') CountingWorker.edges.push(message)
    setTimeout(() => this.onmessage?.({ data: answerMeshBuild(message).reply } as MessageEvent<MeshBuildReply>), 0)
  }
  terminate(): void {}
}

describe('edges of an exact part built in the workers', () => {
  // faces of 40 triangles each: lines between them, none inside
  const m = exactKnot((t) => Math.floor(t / 40))

  it('are what the page draws, and not the mesh rule', () => {
    const inline = featureEdges(m.positions, m.indices, 38, m.exact)
    expect(inline).not.toEqual(featureEdges(m.positions, m.indices, 38))
    const r = answerMeshBuild({ id: 1, kind: 'edges', positions: m.positions, indices: m.indices, deg: 38, normals: m.exact.normals, faceIds: m.exact.faceIds })
    expect(r.reply.ok && r.reply.edges).toEqual(inline)
  })

  it('match a small part built on the page, and are asked for once for every copy', async () => {
    const part: ViewportPart = { name: 'k', positions: m.positions, indices: m.indices, color: '#808080', normals: m.exact.normals, faceIds: m.exact.faceIds }
    const page = buildObject(object('page', part), () => new MeshBasicMaterial(), edgeMat)
    CountingWorker.edges = []
    const pool = new MeshBuildPool(() => new CountingWorker(), 1)
    const store: SharedParts = new Map()
    let finished!: () => void
    const both = new Promise<void>((r) => (finished = r))
    const done: ObjectEntry[] = []
    const async = { pool, minTriangles: 100, done: (e: ObjectEntry) => (done.push(e), done.length === 2 && finished()) }
    const big = [buildObject(object('a', part), () => new MeshBasicMaterial(), edgeMat, async, store), buildObject(object('b', part), () => new MeshBasicMaterial(), edgeMat, async, store)]
    await both
    // one edges job for the two, carrying the normals and face ids
    expect(CountingWorker.edges).toHaveLength(1)
    expect(CountingWorker.edges[0]!.faceIds).toBe(part.faceIds)
    expect(CountingWorker.edges[0]!.normals).toBe(part.normals)
    const want = page.parts[0]!.edges.geometry.getAttribute('position').array
    for (const e of big) expect(e.parts[0]!.edges.geometry.getAttribute('position').array).toEqual(want)
    pool.dispose()
  })
})
