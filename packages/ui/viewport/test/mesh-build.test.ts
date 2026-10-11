// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Big parts built off the main thread: the worker answers with the same geometry the page makes, the pool spreads jobs
// over its workers and survives one that fails, and a part shows its stand-in at once and its final geometry after.
import { MeshBasicMaterial, LineBasicMaterial, TorusKnotGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { creasedArrays, featureEdges, smoothNormals } from '../src/mesh-math'
import { MeshBuildPool, meshPoolSize, type MeshWorkerLike } from '../src/mesh-pool'
import { answerMeshBuild, type MeshBuildReply, type MeshBuildRequest } from '../src/mesh-worker'
import { buildObject, creasedGeometry, disposeObject, type ObjectEntry, type PartEntry } from '../src/model'
import type { ViewportObject } from '../src/types'

function knot(): { positions: Float32Array; indices: Uint32Array } {
  const g = new TorusKnotGeometry(10, 3, 64, 12)
  return { positions: g.getAttribute('position').array as Float32Array, indices: new Uint32Array(g.getIndex()!.array) }
}

/** A worker in this thread: answers each job a tick later, as a real one would, unless told to fail. */
class FakeWorker implements MeshWorkerLike {
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  jobs = 0
  constructor(private readonly broken = false) {}
  postMessage(message: MeshBuildRequest): void {
    this.jobs++
    setTimeout(() => {
      if (this.terminated) return
      if (this.broken) return this.onerror?.({ message: 'boom' } as ErrorEvent)
      this.onmessage?.({ data: answerMeshBuild(message).reply } as MessageEvent<MeshBuildReply>)
    }, 0)
  }
  terminate(): void {
    this.terminated = true
  }
}

describe('the mesh worker', () => {
  it('answers with what the page makes itself', () => {
    const { positions, indices } = knot()
    const c = answerMeshBuild({ id: 1, kind: 'crease', positions, indices, deg: 40 })
    const e = answerMeshBuild({ id: 2, kind: 'edges', positions, indices, deg: 38 })
    const local = creasedArrays(positions, indices, 40)
    expect(c.reply.ok && c.reply.crease?.index).toEqual(local.index)
    expect(c.reply.ok && c.reply.crease?.normal).toEqual(local.normal)
    expect(c.transfer).toHaveLength(3)
    expect(e.reply.ok && e.reply.edges).toEqual(featureEdges(positions, indices, 38))
  })
})

describe('the mesh build pool', () => {
  it('keeps a couple of cores free and uses at most four workers', () => {
    expect(meshPoolSize(2)).toBe(1)
    expect(meshPoolSize(8)).toBe(4)
    expect(meshPoolSize(24)).toBe(4)
    expect(meshPoolSize(0)).toBe(2)
  })

  it('spreads jobs over its workers, starting them as work comes', async () => {
    const made: FakeWorker[] = []
    const pool = new MeshBuildPool(() => (made.push(new FakeWorker()), made.at(-1)!), 3)
    const { positions, indices } = knot()
    const all = await Promise.all([pool.crease(positions, indices, 40), pool.edges(positions, indices, 38), pool.crease(positions, indices, 40), pool.edges(positions, indices, 38)])
    expect(made).toHaveLength(3)
    expect(made.map((w) => w.jobs).sort()).toEqual([1, 1, 2])
    expect(all[0].index).toEqual(creasedArrays(positions, indices, 40).index)
    expect(pool.pending).toBe(0)
    pool.dispose()
    expect(made.every((w) => w.terminated)).toBe(true)
  })

  it('fails the jobs of a worker that breaks, and starts a fresh one for the next', async () => {
    let n = 0
    const pool = new MeshBuildPool(() => new FakeWorker(n++ === 0), 1)
    const { positions, indices } = knot()
    await expect(pool.crease(positions, indices, 40)).rejects.toThrow('boom')
    await expect(pool.edges(positions, indices, 38)).resolves.toBeInstanceOf(Float32Array)
  })

  it('refuses work once disposed', async () => {
    const pool = new MeshBuildPool(() => new FakeWorker(), 1)
    pool.dispose()
    const { positions, indices } = knot()
    await expect(pool.crease(positions, indices, 40)).rejects.toThrow('disposed')
  })
})

describe('smoothNormals', () => {
  it('gives unit normals that point out of a closed shape', () => {
    const { positions, indices } = knot()
    const n = smoothNormals(positions, indices)
    for (let i = 0; i < n.length; i += 3) expect(Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!)).toBeCloseTo(1, 4)
  })
})

describe('a big part built in a worker', () => {
  const obj = (): ViewportObject => {
    const { positions, indices } = knot()
    return { id: 'o1', name: 'knot', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], parts: [{ name: 'p', positions, indices, color: '#cccccc' }] }
  }
  const mat = new MeshBasicMaterial()
  const edgeMat = new LineBasicMaterial()

  it('shows its stand-in at once and takes the creased geometry and edges when they come', async () => {
    const o = obj()
    const pool = new MeshBuildPool(() => new FakeWorker(), 2)
    const done: [ObjectEntry, PartEntry][] = []
    let finished!: () => void
    const all = new Promise<void>((r) => (finished = r))
    const entry = buildObject(o, () => mat, edgeMat, { pool, minTriangles: 100, done: (e, p) => (done.push([e, p]), finished()) })
    const part = entry.parts[0]!
    // the stand-in: the part's own arrays, smooth normals, no edges yet
    expect(part.mesh.geometry.getAttribute('position').array).toBe(o.parts[0]!.positions)
    expect(part.mesh.geometry.getIndex()?.count).toBe(o.parts[0]!.indices.length)
    expect(part.edges.geometry.getAttribute('position').count).toBe(0)
    await all
    const local = creasedGeometry(o.parts[0]!.positions, o.parts[0]!.indices)
    expect(part.mesh.geometry.getAttribute('normal').array).toEqual(local.getAttribute('normal').array)
    expect(part.mesh.geometry.getIndex()?.array).toEqual(local.getIndex()?.array)
    expect(part.edges.geometry.getAttribute('position').array).toEqual(featureEdges(o.parts[0]!.positions, o.parts[0]!.indices, 38))
    expect(done).toEqual([[entry, part]])
  })

  it('is built on the page when its worker fails', async () => {
    const o = obj()
    const pool = new MeshBuildPool(() => new FakeWorker(true), 1)
    let finished!: () => void
    const all = new Promise<void>((r) => (finished = r))
    const entry = buildObject(o, () => mat, edgeMat, { pool, minTriangles: 100, done: () => finished() })
    await all
    const local = creasedGeometry(o.parts[0]!.positions, o.parts[0]!.indices)
    expect(entry.parts[0]!.mesh.geometry.getAttribute('normal').array).toEqual(local.getAttribute('normal').array)
  })

  it('keeps the stand-in of an object disposed before its geometry came, and still says it is done', async () => {
    const o = obj()
    const pool = new MeshBuildPool(() => new FakeWorker(), 1)
    let finished!: () => void
    const all = new Promise<void>((r) => (finished = r))
    const entry = buildObject(o, () => mat, edgeMat, { pool, minTriangles: 100, done: () => finished() })
    const standIn = entry.parts[0]!.mesh.geometry
    disposeObject(entry)
    await all
    expect(entry.parts[0]!.mesh.geometry).toBe(standIn)
  })

  it('builds a part below the size on the page, as before', () => {
    const o = obj()
    let asked = 0
    const pool = { crease: () => (asked++, Promise.reject(new Error('no'))), edges: () => (asked++, Promise.reject(new Error('no'))) }
    const entry = buildObject(o, () => mat, edgeMat, { pool, minTriangles: 1e9, done: () => undefined })
    expect(asked).toBe(0)
    expect(entry.parts[0]!.edges.geometry.getAttribute('position').count).toBeGreaterThan(0)
  })
})
