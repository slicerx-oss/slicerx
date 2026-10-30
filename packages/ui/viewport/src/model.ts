// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns plate objects into scene meshes: creased normals so flat faces and
// pixel steps stay crisp, thin feature edges, and per-part polygon offset so
// coplanar faces between stacked color parts resolve the same way every frame. Copies of one object share all of that
// but their place: every part built from the very same arrays draws the one geometry, freed with its last copy.
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineSegments,
  Matrix4,
  Mesh,
  type Material,
} from 'three'
import type { FilamentFinish, ViewportObject, ViewportPart } from './types'
import { creasedArrays, featureEdges, smoothNormals, type CreasedArrays } from './mesh-math'
import type { MeshBuildPool } from './mesh-pool'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { LineMaterial } from 'three/addons/lines/LineMaterial.js'

export { featureEdges, weldVertices } from './mesh-math'

const CREASE_DEG = 40
const EDGE_DEG = 38

export interface PartEntry {
  mesh: Mesh
  edges: LineSegments
  /** The geometry this part draws, shared with the copies built from the same arrays. */
  shared?: SharedPart
  /** The same edges as screen-space quads for the CAD look, made the first time it shows them. */
  wide?: LineSegments2
  color: string
  finish: FilamentFinish
  index: number
  /** The part's filament slot (1-based), when the app says which: highlighting a slot dims the others. */
  slot?: number
}

export interface ObjectEntry {
  id: string
  name: string
  group: Group
  parts: PartEntry[]
  /** Set by disposeObject: a part geometry that arrives later is dropped. */
  disposed?: boolean
}

/**
 * One part's geometry for every part built from the very same position and index arrays: copies of an object (Duplicate,
 * paste, fill bed) keep their source's arrays, so they draw one creased mesh and one set of edges and differ only by
 * their group's transform. A copy whose arrays differ (scaled into new positions, split by paint) gets its own.
 */
export interface SharedPart {
  positions: Float32Array
  indices: Uint32Array | Uint16Array
  mesh: BufferGeometry
  edges: BufferGeometry
  /** The CAD look's wide edges, made the first time a copy shows them. */
  wide: LineSegmentsGeometry | null
  /** The parts drawing it; the geometry is freed when the last one goes. */
  users: Set<PartEntry>
  /** While it shows its stand-in: the parts to tell when the final geometry comes (AsyncPartBuild.done). */
  waiting: Map<PartEntry, () => void> | null
  /** Freed: a final geometry that arrives later is dropped. */
  gone: boolean
  store: SharedParts
}

/** Shared part geometry by position array, then index array (identity: comparing contents would cost what sharing saves). */
export type SharedParts = Map<Float32Array, Map<Uint32Array | Uint16Array, SharedPart>>

function findShared(store: SharedParts, P: Float32Array, I: Uint32Array | Uint16Array): SharedPart | undefined {
  return store.get(P)?.get(I)
}

/** Whether these arrays already have their final geometry in the store, so a part built from them waits for nothing. */
export function sharedFinal(store: SharedParts, P: Float32Array, I: Uint32Array | Uint16Array): boolean {
  const s = findShared(store, P, I)
  return !!s && s.waiting === null
}

/** Lets go of a part's share; the last part to go frees the geometry. */
function release(part: PartEntry): void {
  const s = part.shared
  if (!s) return
  delete part.shared
  s.users.delete(part)
  const tell = s.waiting?.get(part)
  if (tell) {
    s.waiting!.delete(part)
    // after the caller's own work (setPlate disposing what left the plate), as the worker's answer would come
    queueMicrotask(tell)
  }
  if (s.users.size > 0) return
  s.gone = true
  s.mesh.dispose()
  s.edges.dispose()
  s.wide?.dispose()
  const byIndex = s.store.get(s.positions)
  byIndex?.delete(s.indices)
  if (byIndex?.size === 0) s.store.delete(s.positions)
}

/**
 * Indexed geometry whose normals average only faces within CREASE_DEG of each other (creasedArrays in mesh-math.ts).
 * Triangle t of the result is triangle t of the input.
 */
export function creasedGeometry(P: Float32Array, I: ArrayLike<number>): BufferGeometry {
  return creasedMesh(creasedArrays(P, I, CREASE_DEG))
}

/** A mesh geometry from creased arrays, with its bounds. */
function creasedMesh(a: CreasedArrays): BufferGeometry {
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(a.position, 3))
  out.setAttribute('normal', new BufferAttribute(a.normal, 3))
  out.setIndex(new BufferAttribute(a.index, 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

function edgeGeometry(part: ViewportPart): BufferGeometry {
  return edgeLines(featureEdges(part.positions, part.indices, EDGE_DEG))
}

function edgeLines(positions: Float32Array): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(positions, 3))
  return g
}

/**
 * The quick stand-in for a big part while its creased geometry is made elsewhere: the part's own arrays with smooth
 * normals, so the model shows at once in its place and shape. Triangle t is triangle t of the part, as in the creased one.
 */
function standInGeometry(P: Float32Array, I: Uint32Array | Uint16Array): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(P, 3))
  g.setAttribute('normal', new BufferAttribute(smoothNormals(P, I), 3))
  g.setIndex(new BufferAttribute(I, 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/**
 * Building big parts off the main thread: a part of at least `minTriangles` triangles shows its stand-in geometry and
 * no edges at first; its creased geometry and feature edges come from the pool and replace them in place. `done` is
 * called once per such part, when it has its final geometry (made here instead if the pool failed), or was disposed. A
 * copy of a part that already has its final geometry takes it at once and gets no call (sharedFinal tells which).
 */
export interface AsyncPartBuild {
  pool: Pick<MeshBuildPool, 'crease' | 'edges'>
  minTriangles: number
  done(entry: ObjectEntry, part: PartEntry): void
}

/** Later parts win coplanar ties, the same way every frame. */
function partOffset(i: number): Mesh['onBeforeRender'] {
  return (_r, _s, _c, _g, mat) => {
    const m = mat as Material
    if (m.polygonOffset) {
      m.polygonOffsetFactor = -0.12 * i
      m.polygonOffsetUnits = -4 * i
    }
  }
}

/**
 * A paint overlay sits just in front of the part it paints: the part's own offset plus a fixed step toward the camera.
 * Part i is drawn with `partOffset(i)`, so an overlay with a fixed offset falls behind its part from the third part on.
 */
export function overlayOffset(i: number): Mesh['onBeforeRender'] {
  return (_r, _s, _c, _g, mat) => {
    const m = mat as Material
    if (m.polygonOffset) {
      m.polygonOffsetFactor = -2 - 0.12 * i
      m.polygonOffsetUnits = -6 - 4 * i
    }
  }
}

export function buildObject(obj: ViewportObject, material: (p: ViewportPart) => Material, edgeMaterial: Material, async?: AsyncPartBuild, store: SharedParts = new Map()): ObjectEntry {
  const group = new Group()
  group.name = obj.name
  group.userData.objectId = obj.id
  group.matrixAutoUpdate = false
  group.matrix.copy(new Matrix4().fromArray(obj.transform))
  const entry: ObjectEntry = { id: obj.id, name: obj.name, group, parts: [] }
  entry.parts = obj.parts.map((p, i) => {
    let s = findShared(store, p.positions, p.indices)
    const fresh = !s
    if (!s) {
      const big = async !== undefined && p.indices.length / 3 >= async.minTriangles
      s = {
        positions: p.positions,
        indices: p.indices,
        mesh: big ? standInGeometry(p.positions, p.indices) : creasedGeometry(p.positions, p.indices),
        edges: big ? edgeLines(new Float32Array(0)) : edgeGeometry(p),
        wide: null,
        users: new Set(),
        waiting: big ? new Map() : null,
        gone: false,
        store,
      }
      let byIndex = store.get(p.positions)
      if (!byIndex) store.set(p.positions, (byIndex = new Map()))
      byIndex.set(p.indices, s)
    }
    const mesh = new Mesh(s.mesh, material(p))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.objectId = obj.id
    mesh.userData.partIndex = i
    // Kept for the lay-on-face tool: triangle t of the creased geometry is triangle t of these.
    mesh.userData.source = { positions: p.positions, indices: p.indices }
    mesh.onBeforeRender = partOffset(i)
    const edges = new LineSegments(s.edges, edgeMaterial)
    edges.raycast = () => {}
    mesh.add(edges)
    group.add(mesh)
    const part: PartEntry = { mesh, edges, shared: s, color: p.color, finish: p.finish ?? 'basic', index: i, ...(p.slot !== undefined ? { slot: p.slot } : {}) }
    s.users.add(part)
    // Still on its stand-in: this part takes the final geometry with the others, and says so when it comes.
    if (s.waiting && async) s.waiting.set(part, () => async.done(entry, part))
    if (fresh && s.waiting) void refineShared(s, p, async!)
    return part
  })
  return entry
}

/**
 * Resolves once the page has had the chance to draw a frame: copying a big part's arrays to the workers takes a while,
 * and the stand-in's first frame goes first. Capped, so a hidden page (no frames) still gets there.
 */
function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const go = () => setTimeout(resolve, 0)
    if (typeof requestAnimationFrame !== 'function') return void go()
    const cap = setTimeout(resolve, 100)
    requestAnimationFrame(() => {
      clearTimeout(cap)
      go()
    })
  })
}

/** Gives the parts drawing a stand-in the creased geometry and feature edges from the pool (or made here). */
async function refineShared(s: SharedPart, p: ViewportPart, async: AsyncPartBuild): Promise<void> {
  let mesh: BufferGeometry | null = null
  let edges: Float32Array | null = null
  await afterNextFrame()
  // every copy gone before its turn came: nothing to make (release told each one)
  if (s.gone) return
  try {
    const [c, e] = await Promise.all([async.pool.crease(p.positions, p.indices, CREASE_DEG), async.pool.edges(p.positions, p.indices, EDGE_DEG)])
    mesh = creasedMesh(c)
    edges = e
  } catch {
    // No worker, or it failed: made here, as without a pool.
  }
  if (s.gone) {
    mesh?.dispose()
    return
  }
  mesh ??= creasedGeometry(p.positions, p.indices)
  edges ??= featureEdges(p.positions, p.indices, EDGE_DEG)
  s.mesh.dispose()
  s.mesh = mesh
  s.edges.dispose()
  s.edges = edgeLines(edges)
  // the CAD look's wide edges, made from the stand-in's (no) edges while it showed
  if (s.wide) {
    s.wide.dispose()
    s.wide = new LineSegmentsGeometry()
    s.wide.setPositions(edges)
  }
  for (const part of s.users) {
    part.mesh.geometry = s.mesh
    part.edges.geometry = s.edges
    if (part.wide && s.wide) part.wide.geometry = s.wide
  }
  const waiting = s.waiting
  s.waiting = null
  for (const tell of waiting?.values() ?? []) tell()
}

/** The part's wide edges, built from its feature edges once and shared with its copies. */
export function wideEdges(p: PartEntry, material: LineMaterial): LineSegments2 {
  if (p.wide) return p.wide
  const s = p.shared
  let g = s?.wide
  if (!g) {
    g = new LineSegmentsGeometry()
    g.setPositions(p.edges.geometry.getAttribute('position').array as Float32Array)
    if (s) s.wide = g
  }
  const w = new LineSegments2(g, material)
  w.raycast = () => {}
  p.mesh.add(w)
  p.wide = w
  return w
}

export function disposeObject(o: ObjectEntry): void {
  o.disposed = true
  for (const p of o.parts) release(p)
  o.group.removeFromParent()
}
