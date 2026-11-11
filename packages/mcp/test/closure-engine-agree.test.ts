// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine's mesh info and closure.ts read one stored mesh the same way: corners at the same f32 point are one
// vertex, a triangle that collapses to a line there is left out (and counted apart by the engine), and what is left is
// closed when every edge has two triangles running it opposite ways.
import { describe, expect, it } from 'vitest'
import { closureByPosition } from '../src/closure'
import { useGeomEngine } from './geom-engine'

type Mesh = { positions: number[]; indices: number[] }

/** A closed 10 mm box from (100, 100, 100), far enough out that a millionth of a micron is lost at f32. */
function box(at = 0): Mesh {
  const positions: number[] = []
  for (let i = 0; i < 8; i++) positions.push(100 + at + (i & 1 ? 10 : 0), 100 + (i & 2 ? 10 : 0), 100 + (i & 4 ? 10 : 0))
  const tris = [[0, 1, 5], [0, 2, 3], [0, 5, 4], [0, 3, 1], [2, 6, 7], [4, 5, 7], [2, 7, 3], [4, 7, 6], [0, 4, 6], [0, 6, 2], [1, 3, 7], [1, 7, 5]]
  return { positions, indices: tris.flat() }
}

/** The mesh as a reply stores it: every corner rounded to f32. */
const stored = (m: Mesh): Mesh => ({ positions: m.positions.map(Math.fround), indices: m.indices })

/**
 * The box with its first triangle split at a new corner a millionth of a micron from that triangle's first corner:
 * closed by index, and at f32 the new corner is the first one, so two of the three new triangles collapse to a line
 * and the third is the old triangle again.
 */
function collapsed(): Mesh {
  const m = box()
  const [a, b, c] = m.indices.slice(0, 3) as [number, number, number]
  const p = m.positions.length / 3
  m.positions.push(m.positions[a * 3]! + 1e-9, m.positions[a * 3 + 1]! + 1e-9, m.positions[a * 3 + 2]!)
  m.indices.splice(0, 3, a, b, p, b, c, p, c, a, p)
  return m
}

/** The box with one triangle gone. */
const open = (): Mesh => {
  const m = box()
  m.indices.splice(0, 3)
  return m
}

/** Two boxes touching along one edge, each closed by its own indices: welded by position that edge has four triangles. */
function pinch(): Mesh {
  const a = box()
  const b = box(10)
  for (let i = 0; i < b.positions.length; i += 3) b.positions[i + 1]! += 10
  return { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + 8)] }
}

const geom = useGeomEngine('closure-engine-agree-replies')

describe('engine info and closure.ts on one stored mesh', () => {
  const cases: [string, () => Mesh, boolean, number][] = [
    ['a clean box', box, true, 0],
    ['a box with triangles collapsed at f32, closed otherwise', collapsed, true, 2],
    ['a box with a triangle missing', open, false, 0],
    ['two boxes pinched along an edge', pinch, false, 0],
  ]
  for (const [name, make, closed, gone] of cases)
    it(name, async () => {
      const mesh = stored(make())
      const info = (await geom.engine('info', { mesh })) as { watertight: boolean; edges: { boundaryEdges: number; nonManifoldEdges: number; flippedEdges: number; collapsedTriangles?: number } }
      const c = closureByPosition(mesh.positions, mesh.indices)
      expect(info.watertight).toBe(c.watertight)
      expect(info.watertight).toBe(closed)
      expect({ boundaryEdges: info.edges.boundaryEdges, nonManifoldEdges: info.edges.nonManifoldEdges, flippedEdges: info.edges.flippedEdges }).toEqual({ boundaryEdges: c.boundaryEdges, nonManifoldEdges: c.nonManifoldEdges, flippedEdges: c.flippedEdges })
      expect(info.edges.collapsedTriangles ?? 0).toBe(gone)
    })
})
