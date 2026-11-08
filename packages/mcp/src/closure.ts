// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether a mesh is closed, read the way the slicer welds a part when it loads it (packages/core/src/mesh.rs, keyed on
// f32::to_bits): corners at the same single-precision point are one vertex, whatever their indices, and -0 and 0 stay
// two. Read by index, two surfaces that only touch (a sweep's end on a post, say) look closed, while the slicer sees
// edges with four triangles there. geom.info and design.check both read closure here, so they agree with each other
// and with the slicer.

/** Edge counts after the weld, as the engine's edge report names them. */
export interface Closure {
  /** Every edge has exactly two triangles that run it in opposite directions, and there is at least one triangle. */
  watertight: boolean
  /** Edges with one triangle. */
  boundaryEdges: number
  /** Edges with more than two triangles. */
  nonManifoldEdges: number
  /** Edges whose two triangles run the same way, so one of them faces the wrong side. */
  flippedEdges: number
}

/**
 * The welded vertex of each corner position: one id per distinct (x, y, z) single-precision bit pattern, through an
 * open addressing table, so a big mesh welds without a string per vertex.
 */
function weldIds(positions: ArrayLike<number>): Int32Array {
  const n = Math.floor(positions.length / 3)
  const f = new Float32Array(n * 3)
  for (let k = 0; k < n * 3; k++) f[k] = positions[k] ?? 0
  const bits = new Uint32Array(f.buffer)
  let size = 1
  while (size < n * 2) size <<= 1
  const mask = size - 1
  // each slot holds the first vertex seen at its point, or -1
  const table = new Int32Array(size).fill(-1)
  const ids = new Int32Array(n)
  let next = 0
  // the id of the first vertex at each point
  const idOf = new Int32Array(n)
  for (let v = 0; v < n; v++) {
    const x = bits[v * 3]!
    const y = bits[v * 3 + 1]!
    const z = bits[v * 3 + 2]!
    let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d)) >>> 0
    h = (h ^ (h >>> 15)) & mask
    for (;;) {
      const first = table[h]!
      if (first < 0) {
        table[h] = v
        idOf[v] = next
        ids[v] = next++
        break
      }
      if (bits[first * 3] === x && bits[first * 3 + 1] === y && bits[first * 3 + 2] === z) {
        ids[v] = idOf[first]!
        break
      }
      h = (h + 1) & mask
    }
  }
  return ids
}

/** Readings already made, per part mesh: a part's arrays are replaced, never changed in place, when a step changes it. */
const readings = new WeakMap<object, { indices: ArrayLike<number>; closure: Closure }>()

/**
 * The closure of one part, read on its own positions before the design's transform is applied, as the slicer welds a
 * part (packages/core/src/session.rs): moving the part on the bed changes nothing, and -0 stays apart from 0. A
 * mirroring transform reverses every triangle, which leaves every count the same. Kept per part mesh, so asking again
 * about an unchanged part does not weld it again.
 */
export function partClosure(part: { positions: ArrayLike<number>; indices: ArrayLike<number> }): Closure {
  const known = readings.get(part.positions as object)
  if (known && known.indices === part.indices) return known.closure
  const closure = closureByPosition(part.positions, part.indices)
  readings.set(part.positions as object, { indices: part.indices, closure })
  return closure
}

/**
 * The closure of a mesh (xyz per vertex, three vertex indices per triangle) once corners at the same single-precision
 * point are welded. A triangle with two corners at one point is dropped, as the slicer drops it.
 */
export function closureByPosition(positions: ArrayLike<number>, indices: ArrayLike<number>): Closure {
  const ids = weldIds(positions)
  const welded = ids.length
  const tris = Math.floor(indices.length / 3)
  // each directed edge as one number: (low id * count + high id) * 2, plus 1 when it runs high to low. Exact for up to
  // about 67 million welded vertices, far past any mesh that reaches a tool.
  const keys = new Float64Array(tris * 3)
  let edges = 0
  let kept = 0
  for (let t = 0; t < tris; t++) {
    const a = ids[indices[t * 3]!] ?? -1
    const b = ids[indices[t * 3 + 1]!] ?? -1
    const c = ids[indices[t * 3 + 2]!] ?? -1
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue
    kept++
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      keys[edges++] = p < q ? (p * welded + q) * 2 : (q * welded + p) * 2 + 1
  }
  const sorted = keys.subarray(0, edges).sort()
  const out: Closure = { watertight: false, boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 }
  for (let i = 0; i < sorted.length; ) {
    const edge = Math.floor(sorted[i]! / 2)
    let fwd = 0
    let back = 0
    for (; i < sorted.length && Math.floor(sorted[i]! / 2) === edge; i++) {
      if (sorted[i]! % 2 === 0) fwd++
      else back++
    }
    const used = fwd + back
    if (used === 1) out.boundaryEdges++
    else if (used > 2) out.nonManifoldEdges++
    else if (fwd !== 1) out.flippedEdges++
  }
  out.watertight = kept > 0 && out.boundaryEdges === 0 && out.nonManifoldEdges === 0 && out.flippedEdges === 0
  return out
}

/** What keeps a mesh from being closed, in a few words: "3 open edges, 1 edge where more than two faces meet". */
export function notClosedWords(c: Omit<Closure, 'watertight'>): string {
  const n = (k: number, one: string, many: string): string | null => (k > 0 ? `${k} ${k === 1 ? one : many}` : null)
  const parts = [
    n(c.boundaryEdges, 'open edge', 'open edges'),
    n(c.nonManifoldEdges, 'edge where more than two faces meet', 'edges where more than two faces meet'),
    n(c.flippedEdges, 'edge between faces turned opposite ways', 'edges between faces turned opposite ways'),
  ].filter((x): x is string => x !== null)
  return parts.length ? parts.join(', ') : 'no faces'
}
