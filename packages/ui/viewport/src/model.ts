// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns plate objects into scene meshes: creased normals so flat faces and
// pixel steps stay crisp, thin feature edges, and per-part polygon offset so
// coplanar faces between stacked color parts resolve the same way every frame.
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
 * called once per such part, when it has its final geometry (made here instead if the pool failed), or was disposed.
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

export function buildObject(obj: ViewportObject, material: (p: ViewportPart) => Material, edgeMaterial: Material, async?: AsyncPartBuild): ObjectEntry {
  const group = new Group()
  group.name = obj.name
  group.userData.objectId = obj.id
  group.matrixAutoUpdate = false
  group.matrix.copy(new Matrix4().fromArray(obj.transform))
  const later: [ViewportPart, number][] = []
  const parts: PartEntry[] = obj.parts.map((p, i) => {
    const big = async !== undefined && p.indices.length / 3 >= async.minTriangles
    if (big) later.push([p, i])
    const mesh = new Mesh(big ? standInGeometry(p.positions, p.indices) : creasedGeometry(p.positions, p.indices), material(p))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.objectId = obj.id
    mesh.userData.partIndex = i
    // Kept for the lay-on-face tool: triangle t of the creased geometry is triangle t of these.
    mesh.userData.source = { positions: p.positions, indices: p.indices }
    mesh.onBeforeRender = partOffset(i)
    const edges = new LineSegments(big ? edgeLines(new Float32Array(0)) : edgeGeometry(p), edgeMaterial)
    edges.raycast = () => {}
    mesh.add(edges)
    group.add(mesh)
    return { mesh, edges, color: p.color, finish: p.finish ?? 'basic', index: i, ...(p.slot !== undefined ? { slot: p.slot } : {}) }
  })
  const entry: ObjectEntry = { id: obj.id, name: obj.name, group, parts }
  for (const [p, i] of later) void refinePart(entry, parts[i]!, p, async!)
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

/** Gives a part built with its stand-in the creased geometry and feature edges from the pool (or made here). */
async function refinePart(entry: ObjectEntry, part: PartEntry, p: ViewportPart, async: AsyncPartBuild): Promise<void> {
  let mesh: BufferGeometry | null = null
  let edges: Float32Array | null = null
  await afterNextFrame()
  // gone before its turn came: nothing to make
  if (entry.disposed) return async.done(entry, part)
  try {
    const [c, e] = await Promise.all([async.pool.crease(p.positions, p.indices, CREASE_DEG), async.pool.edges(p.positions, p.indices, EDGE_DEG)])
    mesh = creasedMesh(c)
    edges = e
  } catch {
    // No worker, or it failed: made here, as without a pool.
  }
  if (entry.disposed) {
    mesh?.dispose()
    return async.done(entry, part)
  }
  mesh ??= creasedGeometry(p.positions, p.indices)
  edges ??= featureEdges(p.positions, p.indices, EDGE_DEG)
  part.mesh.geometry.dispose()
  part.mesh.geometry = mesh
  part.edges.geometry.dispose()
  part.edges.geometry = edgeLines(edges)
  // the CAD look's wide edges, made from the stand-in's (no) edges while it showed
  if (part.wide) {
    const g = new LineSegmentsGeometry()
    g.setPositions(edges)
    part.wide.geometry.dispose()
    part.wide.geometry = g
  }
  async.done(entry, part)
}

/** The part's wide edges, built from its feature edges once and kept on the part. */
export function wideEdges(p: PartEntry, material: LineMaterial): LineSegments2 {
  if (p.wide) return p.wide
  const g = new LineSegmentsGeometry()
  g.setPositions(p.edges.geometry.getAttribute('position').array as Float32Array)
  const w = new LineSegments2(g, material)
  w.raycast = () => {}
  p.mesh.add(w)
  p.wide = w
  return w
}

export function disposeObject(o: ObjectEntry): void {
  o.disposed = true
  for (const p of o.parts) {
    p.mesh.geometry.dispose()
    p.edges.geometry.dispose()
    p.wide?.geometry.dispose()
  }
  o.group.removeFromParent()
}
