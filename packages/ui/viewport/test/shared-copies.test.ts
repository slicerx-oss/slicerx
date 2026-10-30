// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Copies of one object share their geometry: one creased mesh and one set of feature edges for every copy built from
// the very same arrays, each copy with its own place, material and pick. The geometry goes when its last copy does.
import { BufferGeometry, LineBasicMaterial, MeshBasicMaterial, TorusKnotGeometry, type Material } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { describe, expect, it } from 'vitest'
import { featureEdges } from '../src/mesh-math'
import { MeshBuildPool, type MeshWorkerLike } from '../src/mesh-pool'
import { answerMeshBuild, type MeshBuildReply, type MeshBuildRequest } from '../src/mesh-worker'
import { buildObject, creasedGeometry, disposeObject, wideEdges, type ObjectEntry, type PartEntry, type SharedParts } from '../src/model'
import type { ViewportObject } from '../src/types'

function knot(): { positions: Float32Array; indices: Uint32Array } {
  const g = new TorusKnotGeometry(10, 3, 64, 12)
  return { positions: g.getAttribute('position').array as Float32Array, indices: new Uint32Array(g.getIndex()!.array) }
}

const at = (x: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]

/** Copies of one source: the same part arrays under new ids and places, as Duplicate makes them. */
function copies(n: number, src = knot()): ViewportObject[] {
  return Array.from({ length: n }, (_, i) => ({ id: `obj-${i}`, name: 'knot', transform: at(30 * i), parts: [{ name: 'p', positions: src.positions, indices: src.indices, color: '#cccccc' }] }))
}

const edgeMat = new LineBasicMaterial()

function build(objs: ViewportObject[], shared: SharedParts, async?: Parameters<typeof buildObject>[3]): ObjectEntry[] {
  // a material of its own for each copy, as each can take its own color
  return objs.map((o) => buildObject(o, (p) => new MeshBasicMaterial({ color: p.color }), edgeMat, async, shared))
}

/** How many times each geometry was disposed. */
function watch(...gs: BufferGeometry[]): number[] {
  const n = gs.map(() => 0)
  gs.forEach((g, i) => g.addEventListener('dispose', () => n[i]!++))
  return n
}

class FakeWorker implements MeshWorkerLike {
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  static jobs = 0
  postMessage(message: MeshBuildRequest): void {
    FakeWorker.jobs++
    setTimeout(() => this.onmessage?.({ data: answerMeshBuild(message).reply } as MessageEvent<MeshBuildReply>), 0)
  }
  terminate(): void {}
}

describe('copies of one object', () => {
  it('make one geometry and one set of edges, not one per copy', () => {
    const shared: SharedParts = new Map()
    const all = build(copies(8), shared)
    const meshes = new Set(all.map((e) => e.parts[0]!.mesh.geometry))
    const edges = new Set(all.map((e) => e.parts[0]!.edges.geometry))
    expect(meshes.size).toBe(1)
    expect(edges.size).toBe(1)
    // each copy is still its own mesh: its own place, material and pick
    expect(new Set(all.map((e) => e.parts[0]!.mesh)).size).toBe(8)
    expect(new Set(all.map((e) => e.parts[0]!.mesh.material as Material)).size).toBe(8)
    expect(all.map((e) => e.group.matrix.elements[12])).toEqual([0, 30, 60, 90, 120, 150, 180, 210])
    expect(all.map((e) => e.parts[0]!.mesh.userData.objectId)).toEqual(all.map((e) => e.id))
    // the shared geometry is the one a single build makes
    const src = copies(1)[0]!.parts[0]!
    expect(all[0]!.parts[0]!.mesh.geometry.getAttribute('normal').array).toEqual(creasedGeometry(src.positions, src.indices).getAttribute('normal').array)
  })

  it('share the CAD look wide edges too', () => {
    const shared: SharedParts = new Map()
    const all = build(copies(3), shared)
    const m = new LineMaterial()
    const wide = all.map((e) => wideEdges(e.parts[0]!, m))
    expect(new Set(wide).size).toBe(3)
    expect(new Set(wide.map((w) => w.geometry)).size).toBe(1)
  })

  it('keep drawing when one copy is removed', () => {
    const shared: SharedParts = new Map()
    const src = knot()
    const all = build(copies(4, src), shared)
    const wide = wideEdges(all[0]!.parts[0]!, new LineMaterial())
    const part = all[1]!.parts[0]!
    const n = watch(part.mesh.geometry, part.edges.geometry, wide.geometry)
    disposeObject(all[0]!)
    expect(n).toEqual([0, 0, 0])
    expect(all[1]!.parts[0]!.mesh.geometry.getAttribute('position').count).toBeGreaterThan(0)
    expect(all[1]!.parts[0]!.edges.geometry.getAttribute('position').count).toBeGreaterThan(0)
    // a copy made after that still shares it
    const [late] = build([{ ...copies(1, src)[0]!, id: 'late' }], shared)
    expect(late!.parts[0]!.mesh.geometry).toBe(part.mesh.geometry)
  })

  it('free the geometry with the last copy, once', () => {
    const shared: SharedParts = new Map()
    const all = build(copies(3), shared)
    const wide = wideEdges(all[2]!.parts[0]!, new LineMaterial())
    const part = all[0]!.parts[0]!
    const n = watch(part.mesh.geometry, part.edges.geometry, wide.geometry)
    disposeObject(all[0]!)
    disposeObject(all[1]!)
    expect(n).toEqual([0, 0, 0])
    disposeObject(all[2]!)
    expect(n).toEqual([1, 1, 1])
    expect(shared.size).toBe(0)
    // disposing a copy twice frees nothing more
    disposeObject(all[2]!)
    expect(n).toEqual([1, 1, 1])
  })

  it('give a copy with other arrays (scaled, painted) its own geometry', () => {
    const shared: SharedParts = new Map()
    const src = knot()
    const [a, b] = copies(2, src)
    // scaled into its own positions
    const scaled = { ...b!, id: 'scaled', parts: [{ ...b!.parts[0]!, positions: src.positions.map((v) => v * 2) }] }
    // split into its own triangles by paint: the same points, another index
    const painted = { ...b!, id: 'painted', parts: [{ ...b!.parts[0]!, indices: src.indices.slice() }] }
    const [ea, eb, es, ep] = build([a!, b!, scaled, painted], shared)
    expect(eb!.parts[0]!.mesh.geometry).toBe(ea!.parts[0]!.mesh.geometry)
    expect(es!.parts[0]!.mesh.geometry).not.toBe(ea!.parts[0]!.mesh.geometry)
    expect(ep!.parts[0]!.mesh.geometry).not.toBe(ea!.parts[0]!.mesh.geometry)
    expect(ep!.parts[0]!.mesh.geometry).not.toBe(es!.parts[0]!.mesh.geometry)
    expect(es!.parts[0]!.edges.geometry).not.toBe(ea!.parts[0]!.edges.geometry)
    // removing the scaled one leaves the others
    const n = watch(ea!.parts[0]!.mesh.geometry, ep!.parts[0]!.mesh.geometry)
    disposeObject(es!)
    expect(n).toEqual([0, 0])
  })

  it('without a shared store, each object builds its own as before', () => {
    const all = copies(2).map((o) => buildObject(o, () => new MeshBasicMaterial(), edgeMat))
    expect(all[0]!.parts[0]!.mesh.geometry).not.toBe(all[1]!.parts[0]!.mesh.geometry)
    const n = watch(all[0]!.parts[0]!.mesh.geometry)
    disposeObject(all[0]!)
    expect(n).toEqual([1])
  })
})

describe('copies of a big object built in the workers', () => {
  it('ask the workers once, and every copy takes the final geometry', async () => {
    const shared: SharedParts = new Map()
    const pool = new MeshBuildPool(() => new FakeWorker(), 2)
    FakeWorker.jobs = 0
    const done: [ObjectEntry, PartEntry][] = []
    let finished!: () => void
    const all4 = new Promise<void>((r) => (finished = r))
    const async = { pool, minTriangles: 100, done: (e: ObjectEntry, p: PartEntry) => (done.push([e, p]), done.length === 4 && finished()) }
    const src = knot()
    const all = build(copies(4, src), shared, async)
    // one stand-in for all
    expect(new Set(all.map((e) => e.parts[0]!.mesh.geometry)).size).toBe(1)
    const standIn = all[0]!.parts[0]!.mesh.geometry
    const n = watch(standIn)
    await all4
    expect(FakeWorker.jobs).toBe(2)
    expect(done.map(([e]) => e.id).sort()).toEqual(all.map((e) => e.id))
    const final = all[0]!.parts[0]!.mesh.geometry
    expect(final).not.toBe(standIn)
    expect(n).toEqual([1])
    expect(all.every((e) => e.parts[0]!.mesh.geometry === final)).toBe(true)
    expect(new Set(all.map((e) => e.parts[0]!.edges.geometry)).size).toBe(1)
    expect(all[3]!.parts[0]!.edges.geometry.getAttribute('position').array).toEqual(featureEdges(src.positions, src.indices, 38))
    // a copy made now takes the final geometry at once, with no work left
    const later: ObjectEntry[] = []
    const more = build([{ ...copies(1, src)[0]!, id: 'more' }], shared, { ...async, done: (e) => later.push(e) })
    expect(more[0]!.parts[0]!.mesh.geometry).toBe(final)
    await new Promise((r) => setTimeout(r, 5))
    expect(later).toEqual([])
    expect(FakeWorker.jobs).toBe(2)
  })

  it('still finish the copies left when one is removed while the workers run', async () => {
    const shared: SharedParts = new Map()
    const pool = new MeshBuildPool(() => new FakeWorker(), 1)
    const done: string[] = []
    let finished!: () => void
    const all3 = new Promise<void>((r) => (finished = r))
    const all = build(copies(3), shared, { pool, minTriangles: 100, done: (e) => (done.push(e.id), done.length === 3 && finished()) })
    const standIn = all[0]!.parts[0]!.mesh.geometry
    disposeObject(all[0]!)
    await all3
    expect(done.sort()).toEqual(['obj-0', 'obj-1', 'obj-2'])
    // the removed copy keeps its stand-in; the others take the final geometry
    expect(all[0]!.parts[0]!.mesh.geometry).toBe(standIn)
    expect(all[1]!.parts[0]!.mesh.geometry).not.toBe(standIn)
    expect(all[2]!.parts[0]!.mesh.geometry).toBe(all[1]!.parts[0]!.mesh.geometry)
  })

  it('drop the work when every copy is removed before it comes', async () => {
    const shared: SharedParts = new Map()
    const pool = new MeshBuildPool(() => new FakeWorker(), 1)
    let n = 0
    let finished!: () => void
    const both = new Promise<void>((r) => (finished = r))
    const all = build(copies(2), shared, { pool, minTriangles: 100, done: () => ++n === 2 && finished() })
    const standIn = all[0]!.parts[0]!.mesh.geometry
    const d = watch(standIn)
    all.forEach(disposeObject)
    expect(d).toEqual([1])
    await both
    await new Promise((r) => setTimeout(r, 5))
    expect(all[0]!.parts[0]!.mesh.geometry).toBe(standIn)
    expect(shared.size).toBe(0)
  })
})
