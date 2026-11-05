// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A hole made with Subtract a shape is a round hole to the hole and thread tools, as one cut from a sketch is, on the
// object the tool leaves and on the replay of its step. Against the geometry engine (live wasm when built, recorded
// replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { runReplay } from '../src/cad/history/ops'
import { holeFind, threadFind, type Vec3 } from '../src/geom/cad'
import { askFaces, geom, setGeomProvider, type GeomMesh } from '../src/geom/client'
import { subtractFromSelected } from '../src/plate/geom-ops'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-subtract-hole-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
// A 20 mm box where Add a box puts it on the default bed: x 24.1 to 44.1, y 6.1 to 26.1.
const AT: [number, number] = [34.1, 16.1]
const T = compose({ position: [AT[0], AT[1], 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const entry = () => get().plate.find((p) => p.id === 'a')!

/** A part as the app keeps it or as a replay gives it back. */
interface Mesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  faces?: { ids: ArrayLike<number>; table: NonNullable<GeomMesh['faces']>['table']; keys?: number[] }
}

const asGeom = (m: Mesh): GeomMesh => ({ positions: Array.from(m.positions), indices: Array.from(m.indices), ...(m.faces ? { faces: { ids: Array.from(m.faces.ids), table: m.faces.table, ...(m.faces.keys ? { keys: m.faces.keys } : {}) } } : {}) })

/** A triangle of the hole's wall (upright, `r` from the box's center line) and a point on it in bed coordinates. */
function wall(m: Mesh, r: number): { triangle: number; at: Vec3 } {
  const p = (i: number): Vec3 => [m.positions[3 * i]!, m.positions[3 * i + 1]!, m.positions[3 * i + 2]!]
  for (let t = 0; 3 * t < m.indices.length; t++) {
    const [a, b, c] = [p(m.indices[3 * t]!), p(m.indices[3 * t + 1]!), p(m.indices[3 * t + 2]!)]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    const len = Math.hypot(n[0]!, n[1]!, n[2]!)
    const mid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
    if (len > 1e-6 && Math.abs(n[2]! / len) < 1e-3 && Math.abs(Math.hypot(mid[0], mid[1]) - r) < 0.05) return { triangle: t, at: [mid[0] + AT[0], mid[1] + AT[1], mid[2]] }
  }
  throw new Error('no wall triangle')
}

beforeEach(() => {
  // the app's worker asks for faces on every call
  const engine = geom()
  setGeomProvider({ call: (op, request, signal) => engine.call(op, askFaces(request), signal) })
  clearReplayCache()
  set({ plate: [{ id: 'a', name: 'Box', handle: handle('a'), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'], historyEdit: null })
})

describe('a hole made with Subtract', () => {
  for (const [depthMm, through] of [[25, true], [12, false]] as const) {
    it(`6.8 mm, ${through ? 'through' : '12 mm deep'}: the hole and thread tools find it, on the object and on the replayed step`, async () => {
      await subtractFromSelected(host, { shape: 'cylinder', sizeMm: 6.8, depthMm, offset: [0, 0] })
      const e = entry()
      expect(e.history?.steps.map((s) => s.params.op)).toEqual(['subtract'])
      const replayed = (await runReplay({ history: e.history! })).parts[0]!
      for (const part of [e.parts[0]!, replayed] as Mesh[]) {
        expect(part.faces?.keys?.length, 'the faces come with keys').toBe(part.faces?.table.length)
        const item = { mesh: asGeom(part), transform: e.transform }
        const pick = wall(part, 3.4)
        const hole = await holeFind(item, pick)
        expect(hole.through).toBe(through)
        expect(hole.diameterMm).toBeCloseTo(6.8, 3)
        expect(hole.depthMm).toBeCloseTo(through ? 20 : 12, 3)
        expect((await threadFind(item, pick)).suggested).toBe('M8')
      }
    })
  }
})
