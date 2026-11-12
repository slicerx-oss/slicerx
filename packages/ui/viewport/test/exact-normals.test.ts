// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact corner normals from the engine (ViewportPart.normals): without them, or with none set, a part shades exactly as
// before; triangles with all three corners set take those normals as they are and the rest crease; the worker gets
// the buffer, the shared geometry tells parts apart by it, and a big part with every triangle exact needs no stand-in.
import { LineBasicMaterial, MeshBasicMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import { NO_NORMAL, packNormals, unpackNormal } from '@slicerx/contracts'
import { allExact, creasedArrays, exactTriangles, type CreasedArrays } from '../src/mesh-math'
import { MeshBuildPool, type MeshWorkerLike } from '../src/mesh-pool'
import { answerMeshBuild, type MeshBuildReply, type MeshBuildRequest } from '../src/mesh-worker'
import { buildObject, creasedGeometry, disposeObject, type ObjectEntry, type SharedParts } from '../src/model'
import type { ViewportObject, ViewportPart } from '../src/types'
import { boxSoup, cylinder, digest, sphere, type TestMesh } from './exact-normals-meshes'

/**
 * creasedArrays(positions, indices, 40) of each shape on main before exact normals came in (the digests in
 * exact-normals-meshes.ts, made from that version of mesh-math.ts). Bit for bit: positions, normals and index.
 */
const BEFORE: Record<string, string> = {
  sphere: '13272/13272/26496:8fd90a34',
  cylinder: '2328/2328/2304:3dfe9c6a',
  jittered: '10272/10272/11520:961e7c34',
  box: '432/432/144:577b4da5',
}

const shapes = (): Record<string, { positions: Float32Array; indices: Uint32Array }> => ({
  sphere: sphere(10, 48, 24),
  cylinder: cylinder(5, 20, 48),
  jittered: sphere(10, 32, 16, 0.6),
  box: boxSoup(20, 10, 5),
})

const crease = (m: { positions: Float32Array; indices: Uint32Array }, normals?: Int16Array): CreasedArrays => creasedArrays(m.positions, m.indices, 40, normals)
const sentinels = (triangles: number): Int16Array => new Int16Array(triangles * 6).fill(NO_NORMAL)

/** The normal the result gives corner k (3 * triangle + corner). */
function cornerNormal(c: CreasedArrays, k: number): [number, number, number] {
  const o = c.index[k]! * 3
  return [c.normal[o]!, c.normal[o + 1]!, c.normal[o + 2]!]
}

/** The packed normal of corner k, unpacked and rounded to float32 as the geometry stores it. */
function supplied(packed: Int16Array, k: number): [number, number, number] {
  const n = [0, 0, 0]
  unpackNormal(packed, 2 * k, n, 0)
  return [Math.fround(n[0]!), Math.fround(n[1]!), Math.fround(n[2]!)]
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const d = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!))
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI
}

describe('creased normals with no exact normals', () => {
  for (const [name, m] of Object.entries(shapes())) {
    it(`${name}: field absent gives the output from before, bit for bit`, () => {
      const c = crease(m)
      expect(digest(c.position, c.normal, c.index)).toBe(BEFORE[name])
    })

    it(`${name}: every corner set to no normal gives the same`, () => {
      const c = crease(m, sentinels(m.indices.length / 3))
      expect(digest(c.position, c.normal, c.index)).toBe(BEFORE[name])
    })

    it(`${name}: a buffer of the wrong length is ignored`, () => {
      const short = packNormals(new Float32Array(m.indices.length * 3 - 9).fill(1))
      const c = crease(m, short)
      expect(digest(c.position, c.normal, c.index)).toBe(BEFORE[name])
    })
  }
})

describe('creased normals with exact normals', () => {
  const check = (m: TestMesh): void => {
    const packed = packNormals(m.corners)
    expect(allExact(packed, m.indices.length / 3)).toBe(true)
    const c = crease(m, packed)
    expect(c.index).toHaveLength(m.indices.length)
    for (let k = 0; k < m.indices.length; k++) {
      // the same vertex as the input corner, carrying exactly the supplied normal
      const o = c.index[k]! * 3
      const p = m.indices[k]! * 3
      expect([c.position[o], c.position[o + 1], c.position[o + 2]]).toEqual([m.positions[p], m.positions[p + 1], m.positions[p + 2]])
      expect(cornerNormal(c, k)).toEqual(supplied(packed, k))
      expect(angleDeg(cornerNormal(c, k), [m.corners[3 * k]!, m.corners[3 * k + 1]!, m.corners[3 * k + 2]!])).toBeLessThan(0.01)
    }
  }

  it('a unit sphere comes out with exactly its analytic normals', () => {
    const m = sphere(1, 48, 24)
    check(m)
    // smooth: corners of one vertex share one output vertex, as one normal per vertex
    expect(crease(m, packNormals(m.corners)).position.length).toBe(m.positions.length)
  })

  it('a cylinder comes out with exactly its analytic normals, split at the rims', () => {
    const m = cylinder(5, 20, 48)
    check(m)
    // each rim vertex: one side normal and one cap normal; the cap centers: one each
    expect(crease(m, packNormals(m.corners)).position.length / 3).toBe(4 * 48 + 2)
  })

  it('a part with one triangle left out takes the crease rule there and the exact normals elsewhere', () => {
    const m = sphere(10, 48, 24)
    const packed = packNormals(m.corners)
    const out = 100
    packed.fill(NO_NORMAL, 6 * out, 6 * out + 6)
    // and one with a single corner left out counts as not exact
    const half = 200
    packed.fill(NO_NORMAL, 6 * half + 2, 6 * half + 4)
    const { exact, count } = exactTriangles(packed, m.indices.length / 3)
    expect(count).toBe(m.indices.length / 3 - 2)
    expect(exact![out]).toBe(0)
    expect(exact![half]).toBe(0)
    const mixed = crease(m, packed)
    const plain = crease(m)
    for (let t = 0; t < m.indices.length / 3; t++) {
      for (let j = 0; j < 3; j++) {
        const k = 3 * t + j
        if (t === out || t === half) expect(cornerNormal(mixed, k)).toEqual(cornerNormal(plain, k))
        else expect(cornerNormal(mixed, k)).toEqual(supplied(packed, k))
      }
    }
  })
})

/** A worker in this thread that keeps the jobs it was sent. */
class FakeWorker implements MeshWorkerLike {
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  sent: MeshBuildRequest[] = []
  postMessage(message: MeshBuildRequest): void {
    this.sent.push(message)
    setTimeout(() => this.onmessage?.({ data: answerMeshBuild(message).reply } as MessageEvent<MeshBuildReply>), 0)
  }
  terminate(): void {}
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const object = (id: string, part: ViewportPart): ViewportObject => ({ id, name: id, transform: identity, parts: [part] })
const normalsOf = (o: ObjectEntry): number[] => Array.from(o.parts[0]!.mesh.geometry.getAttribute('normal').array)

describe('parts with exact normals in the viewport', () => {
  const mat = new MeshBasicMaterial()
  const edgeMat = new LineBasicMaterial()

  it('the worker gets the packed buffer and answers with what the page makes', async () => {
    const m = sphere(10, 64, 32)
    const packed = packNormals(m.corners)
    packed.fill(NO_NORMAL, 0, 60)
    const worker = new FakeWorker()
    const pool = new MeshBuildPool(() => worker, 1)
    const c = await pool.crease(m.positions, m.indices, 40, packed)
    expect(worker.sent[0]!.normals).toBe(packed)
    const local = crease(m, packed)
    expect(c.normal).toEqual(local.normal)
    expect(c.index).toEqual(local.index)
    // without normals the request carries none
    await pool.crease(m.positions, m.indices, 40)
    expect('normals' in worker.sent[1]!).toBe(false)
  })

  it('a big part with some triangles exact shows the stand-in, then the creased geometry with its normals', async () => {
    const m = sphere(10, 64, 32)
    const packed = packNormals(m.corners)
    packed.fill(NO_NORMAL, 0, 60)
    const worker = new FakeWorker()
    const pool = new MeshBuildPool(() => worker, 1)
    let finished!: () => void
    const done = new Promise<void>((r) => (finished = r))
    const entry = buildObject(object('a', { name: 'a', positions: m.positions, indices: m.indices, normals: packed, color: '#808080' }), () => mat, edgeMat, { pool, minTriangles: 100, done: () => finished() })
    const standIn = entry.parts[0]!.mesh.geometry
    // the stand-in: the part's own arrays
    expect(standIn.getAttribute('position').array).toBe(m.positions)
    await done
    expect(worker.sent.map((r) => r.kind).sort()).toEqual(['crease', 'edges'])
    expect(worker.sent.find((r) => r.kind === 'crease')!.normals).toBe(packed)
    expect(entry.parts[0]!.mesh.geometry).not.toBe(standIn)
    expect(normalsOf(entry)).toEqual(Array.from(creasedGeometry(m.positions, m.indices, packed).getAttribute('normal').array))
    disposeObject(entry)
  })

  it('a big part with every triangle exact draws its final geometry at once and only waits for its edges', async () => {
    const m = cylinder(5, 20, 48)
    const packed = packNormals(m.corners)
    const worker = new FakeWorker()
    const pool = new MeshBuildPool(() => worker, 1)
    let finished!: () => void
    const done = new Promise<void>((r) => (finished = r))
    const entry = buildObject(object('a', { name: 'a', positions: m.positions, indices: m.indices, normals: packed, color: '#808080' }), () => mat, edgeMat, { pool, minTriangles: 100, done: () => finished() })
    const first = entry.parts[0]!.mesh.geometry
    const noEdges = entry.parts[0]!.edges.geometry
    expect(normalsOf(entry)).toEqual(Array.from(creasedGeometry(m.positions, m.indices, packed).getAttribute('normal').array))
    expect(entry.parts[0]!.edges.geometry.getAttribute('position').count).toBe(0)
    await done
    expect(worker.sent.map((r) => r.kind)).toEqual(['edges'])
    // no swap: the very geometry it showed first
    expect(entry.parts[0]!.mesh.geometry).toBe(first)
    // the edges came from the worker: the two rims
    expect(entry.parts[0]!.edges.geometry).not.toBe(noEdges)
    expect(entry.parts[0]!.edges.geometry.getAttribute('position').count).toBe(4 * 48)
    disposeObject(entry)
  })

  it('shares geometry only between parts with the same normal buffer too', () => {
    const m = sphere(10, 24, 12)
    const packed = packNormals(m.corners)
    const store: SharedParts = new Map()
    const part = (normals?: Int16Array): ViewportPart => ({ name: 'p', positions: m.positions, indices: m.indices, color: '#808080', ...(normals ? { normals } : {}) })
    const build = (id: string, p: ViewportPart) => buildObject(object(id, p), () => mat, edgeMat, undefined, store)
    const plain = build('a', part())
    const plainCopy = build('b', part())
    const exact = build('c', part(packed))
    const exactCopy = build('d', part(packed))
    const other = build('e', part(packNormals(m.corners)))
    expect(plainCopy.parts[0]!.mesh.geometry).toBe(plain.parts[0]!.mesh.geometry)
    expect(exactCopy.parts[0]!.mesh.geometry).toBe(exact.parts[0]!.mesh.geometry)
    expect(exact.parts[0]!.mesh.geometry).not.toBe(plain.parts[0]!.mesh.geometry)
    // a new buffer (new normals from the engine for the same triangles) is never served the old geometry
    expect(other.parts[0]!.mesh.geometry).not.toBe(exact.parts[0]!.mesh.geometry)
    expect(normalsOf(exact)).not.toEqual(normalsOf(plain))
    for (const o of [plain, plainCopy, exact, exactCopy, other]) disposeObject(o)
    expect(store.size).toBe(0)
  })
})
