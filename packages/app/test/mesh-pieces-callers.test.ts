// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The three places that split a mesh into connected pieces through the one helper (meshPieces in @slicerx/contracts):
// the app's split into parts, the MCP server's separate bodies of a file, and the feet a lean turns an added part's
// pieces about. On the same meshes they find the same pieces; the lean alone then counts pieces whose boxes meet as one.
import { describe, expect, it } from 'vitest'
import { meshPieces, type MeshPart } from '@slicerx/contracts'
import { partFeet } from '@slicerx/cad-history'
import { bake, boxMesh, components, cylinderMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { splitBodies } from '../../mcp/src/mesh'

type Vec3 = [number, number, number]
const UP: Vec3 = [0, 0, 1]

const at = (p: MeshPart, [x, y, z]: Vec3): MeshPart => bake(p, compose({ position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] }))

/** Parts as one part, each with its own vertices. */
function one(...parts: MeshPart[]): MeshPart {
  const positions: number[] = []
  const indices: number[] = []
  for (const p of parts) {
    const off = positions.length / 3
    positions.push(...p.positions)
    indices.push(...[...p.indices].map((i) => i + off))
  }
  return { name: 'Part', slot: 1, positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** The part as a triangle soup, nine numbers per triangle, as an STL file holds it. */
function soup(p: MeshPart): Float32Array {
  const out = new Float32Array(p.indices.length * 3)
  p.indices.forEach((v, k) => out.set(p.positions.subarray(v * 3, v * 3 + 3), k * 3))
  return out
}

/** Each piece as the sorted list of its triangles' corners, so pieces compare whatever their vertex numbering. */
const triangles = (s: Float32Array): string[] => {
  const out: string[] = []
  for (let o = 0; o + 8 < s.length; o += 9) out.push(Array.from(s.subarray(o, o + 9)).join(','))
  return out.sort()
}
const byApp = (p: MeshPart) => components(p).map((x) => triangles(soup(x)))
const byServer = (p: MeshPart) => splitBodies(soup(p)).map(triangles)
const byHelper = (p: MeshPart) => meshPieces(p.positions, p.indices).triangles.map((tris) => triangles(soup({ ...p, indices: new Uint32Array(tris.flatMap((t) => [3 * t, 3 * t + 1, 3 * t + 2]).map((k) => p.indices[k]!)) })))

/** The same pieces, biggest first, as the app and the server both order them. */
const sorted = (pieces: string[][]) => [...pieces].sort((a, b) => b.length - a.length)

const cases: { name: string; part: MeshPart; pieces: number; feet: Vec3[] }[] = [
  { name: 'one piece', part: boxMesh(10, 10, 10), pieces: 1, feet: [[0, 0, 0]] },
  // a second box on the first one's side: its corners sit on the first one's, so the weld makes them one
  { name: 'two pieces touching corner to corner', part: one(boxMesh(10, 10, 10), at(boxMesh(10, 10, 10), [10, 0, 0])), pieces: 1, feet: [[5, 0, 0]] },
  // a smaller box resting on a bigger one shares no corner: two pieces, which a lean turns as one since their boxes meet
  { name: 'two pieces resting one on the other', part: one(boxMesh(20, 20, 4), at(boxMesh(6, 6, 10), [0, 0, 4])), pieces: 2, feet: [[0, 0, 0]] },
  { name: 'separate pieces', part: one(boxMesh(10, 10, 10), at(boxMesh(4, 4, 4), [30, 0, 0])), pieces: 2, feet: [[0, 0, 0], [30, 0, 0]] },
  // four uprights 20 mm apart, 5 mm across and 12 mm tall, standing at 7 mm, built as one part (as in the lean test)
  { name: 'four uprights', part: one(...[15, 35, 55, 75].map((x) => at(cylinderMesh(5, 12), [x, 0, 7]))), pieces: 4, feet: [15, 35, 55, 75].map((x): Vec3 => [x, 0, 7]) },
]

describe('splitting a mesh into its connected pieces, in each place that does', () => {
  for (const c of cases)
    it(`finds the same pieces in each: ${c.name}`, () => {
      const helper = byHelper(c.part)
      expect(helper).toHaveLength(c.pieces)
      // the app and the server put the biggest piece first; each has every triangle once
      expect(byApp(c.part)).toEqual(sorted(helper))
      expect(byServer(c.part)).toEqual(sorted(helper))
      expect(helper.flat()).toHaveLength(c.part.indices.length / 3)
      const feet = partFeet(c.part, UP)
      expect(feet).toHaveLength(c.feet.length)
      feet.forEach((f, i) => f.forEach((v, k) => expect(v).toBeCloseTo(c.feet[i]![k]!, 3)))
    })
})
