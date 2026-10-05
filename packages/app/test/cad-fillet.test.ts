// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fillet and chamfer tool (docs/cad-fillet.md): edge picks as a set, the op landing as a history
// step that replays, an edge on a pulled face following the pull when it changes, and sketch corners
// reopening in sketch mode. Against the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPush, pickPushFace } from '../src/cad/push'
import { addEdge, applyEdges, edgeDistance, edgeParams, sameEdge } from '../src/cad/edges'
import { edgePreview, filletSketch, pickEdge } from '../src/cad/edge-api'
import { followsOf, stepName } from '../src/cad/history/model'
import { runReplay, setParams } from '../src/cad/history/ops'
import { clearReplayCache } from '../src/cad/history/replay'
import { fromLoops, rectangle, straightCorners, toLoops, type Entity } from '../src/cad/sketch-model'
import { toGeom } from '../src/geom/client'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-fillet-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const entry = () => get().plate.find((p) => p.id === 'a')!
const topZ = (m: Pick<MeshPart, 'positions'>) => Math.max(...Array.from(m.positions).filter((_, i) => i % 3 === 2))

beforeEach(() => {
  clearReplayCache()
  set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'], historyEdit: null })
})

describe('edge picks', () => {
  const e1 = { a: [0, 0, 0] as [number, number, number], b: [10, 0, 0] as [number, number, number], face: [0, 0, 1] as [number, number, number] }
  const e2 = { a: [10, 0, 0] as [number, number, number], b: [10, 5, 0] as [number, number, number], face: [0, 0, 1] as [number, number, number] }
  it('keeps a set: a click replaces, Shift adds, Shift on a picked edge takes it off', () => {
    expect(addEdge([e1], e2, false)).toEqual([e2])
    expect(addEdge([e1], e2, true)).toEqual([e1, e2])
    expect(addEdge([e1, e2], { ...e1, a: e1.b, b: e1.a }, true)).toEqual([e2])
    expect(sameEdge(e1, { ...e1, a: e1.b, b: e1.a })).toBe(true)
    expect(edgeDistance([5, 3, 0], e1)).toBeCloseTo(3)
    expect(edgeDistance([-4, 3, 0], e1)).toBeCloseTo(5)
    expect(edgeParams('chamfer', [e1], 1, 2)).toEqual({ op: 'edge.chamfer', edges: [e1], distanceMm: 1, distance2Mm: 2 })
  })
})

describe('fillet and chamfer on a block', () => {
  it('rounds a picked top edge as a history step that replays, and previews it first', async () => {
    const e = entry()
    const p = await pickEdge({ mesh: toGeom(e.parts[0]!), transform: T }, { triangle: 2, at: [110, 109.5, 10] })
    expect(p.supported).toBe(true)
    expect(p.loop).toHaveLength(4)
    expect(p.maxRadiusMm).toBeGreaterThan(2)
    const params = edgeParams('fillet', [p.edge], 2, null)
    const prev = await edgePreview({ mesh: { mesh: toGeom(e.parts[0]!), transform: T }, edges: [p.edge], profile: { kind: 'fillet', radiusMm: 2 } })
    expect(prev.cut.indices.length).toBeGreaterThan(0)
    const r = await applyEdges(host, 'a', 0, params)
    expect(r.message).toBe('Rounded 1 edge of Block.')
    const h = entry().history!
    expect(h.steps.map((s) => stepName(s))).toEqual(['Fillet 2 mm'])
    const back = await runReplay({ history: h })
    expect(back.status[0]!.state).toBe('done')
    expect(back.parts[0]!.indices.length).toBe(entry().parts[0]!.indices.length)
  })

  it('an edge on a pulled face follows the pull when it changes', async () => {
    await applyPush(host, await pickPushFace('a', 0, { triangle: 2, at: [100, 100, 10] }), 5)
    const e = entry()
    const p = await pickEdge({ mesh: toGeom(e.parts[0]!), transform: T }, { triangle: findTop(e.parts[0]!), at: [110, 109.5, 15] })
    await applyEdges(host, 'a', 0, edgeParams('chamfer', [p.edge], 1, null))
    const h = entry().history!
    expect(followsOf(h.steps[1]!).map((f) => f.step)).toEqual([h.steps[0]!.id])
    await setParams(host, 'a', 0, { op: 'face.push', at: [100, 100, 10], normal: [0, 0, 1], distanceMm: 8 })
    const after = entry()
    expect(after.history!.steps.every((s) => s.broken === undefined)).toBe(true)
    expect(topZ(after.parts[0]!)).toBeCloseTo(18)
  })

  it('rounds sketch corners into loops that reopen in sketch mode', async () => {
    const sketch: Entity[] = [rectangle([0, 0], [20, 10])]
    const c = sketch[0]!
    expect(c.kind === 'chain' && straightCorners(c)).toEqual([0, 1, 2, 3])
    expect(c.kind === 'chain' && straightCorners(c, 3)).toEqual([3, 0])
    const r = await filletSketch(toLoops(sketch), [{ loop: 0, vertex: 0 }, { loop: 0, vertex: 2 }], 3)
    const back = fromLoops(r.loops)!
    const chain = back[0]!
    expect(chain.kind === 'chain' && chain.closed).toBe(true)
    expect(chain.kind === 'chain' && chain.segs.filter((s) => s.kind === 'arc')).toHaveLength(2)
  })
})

/** A triangle of the top face of the pulled block. */
function findTop(m: MeshPart): number {
  for (let t = 0; t < m.indices.length / 3; t++) {
    const z = [0, 1, 2].map((k) => m.positions[3 * m.indices[3 * t + k]! + 2]!)
    if (z.every((v) => Math.abs(v - 15) < 1e-4)) return t
  }
  return -1
}
