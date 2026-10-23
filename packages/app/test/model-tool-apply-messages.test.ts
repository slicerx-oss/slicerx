// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What Hole, Thread and Fillet say when an apply or an edit can't go through: a size past the engine's limit reads
// too large with the most, a hole too small to print and a thread longer than its hole are refused before the engine
// runs, and a step whose face or edge is gone says to pick it again. Against the geometry engine (live wasm when
// built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { applyExtrude, BED_FRAME } from '../src/cad/cad-ops'
import { edgePreview, pickEdge } from '../src/cad/edge-api'
import { applyEdges, edgeParams } from '../src/cad/edges'
import { customHoleProblem, holeSpecFor } from '../src/cad/hole-sizes'
import { applyHole } from '../src/cad/holes'
import { deleteStep, setSuppressed } from '../src/cad/history/ops'
import { toolError } from '../src/cad/op-preview'
import { threadLengthProblem } from '../src/cad/thread-spec'
import { referenceWords, sentence } from '../src/cad/tool-panel'
import { holeFind, threadFind } from '../src/geom/cad'
import { toGeom } from '../src/geom/client'
import { clearanceFor } from '../src/plate/clearance'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('model-tool-apply-messages-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
type V3 = [number, number, number]

/** What the call threw. */
async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  clearReplayCache()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null })
})

/** A 30 x 20 x 10 plate with a d6.8 hole cut through its middle by a sketch, and a pick on the hole's wall. */
async function holed() {
  await applyExtrude(host, { name: 'Plate', frame: BED_FRAME, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, spec: { distanceMm: 10, operation: 'new' } })
  const body = get().plate.at(-1)!
  await applyExtrude(host, { name: 'Hole', target: { objectId: body.id, partIndex: 0 }, frame: { ...BED_FRAME, origin: [0, 0, 10] }, shape: { type: 'circle', diameterMm: 6.8 }, placement: { center: [15, 10] }, spec: { distanceMm: 10, operation: 'cut' } })
  const e = get().plate.find((p) => p.id === body.id)!
  const p = e.parts[0]!
  let tri = -1
  for (let t = 0; t < p.indices.length / 3 && tri < 0; t++) {
    const v = [0, 1, 2].map((k) => [0, 1, 2].map((j) => p.positions[p.indices[t * 3 + k]! * 3 + j]!))
    if (v.every((q) => Math.abs(Math.hypot(q[0]!, q[1]!) - 3.4) < 0.05) && Math.max(...v.map((q) => q[2]!)) - Math.min(...v.map((q) => q[2]!)) > 1) tri = t
  }
  const c = [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + p.positions[p.indices[tri * 3 + k]! * 3 + j]!, 0) / 3)
  const at: V3 = [c[0]! + e.transform[12]!, c[1]! + e.transform[13]!, c[2]!]
  return { e, item: { mesh: toGeom(p), transform: e.transform }, pick: { triangle: tri, at } }
}

const block = () => set({ plate: [{ id: 'a', name: 'Block', handle: handle('a'), parts: [boxMesh(30, 20, 10)], colors: ['#bd93f9'], transform: T }], selection: 'a', selectedIds: ['a'], historyEdit: null })
const entry = () => get().plate.find((p) => p.id === 'a')!

describe('a size past the engine limit', () => {
  it('Hole says the diameter is too large and gives the most, and makes no step', async () => {
    const { e, item, pick } = await holed()
    const hole = await holeFind(item, pick)
    const fit = clearanceFor(get())
    const sized = holeSpecFor({ purpose: 'custom', thread: 'M3', head: 'none', customMm: 100000 }, fit, hole)
    const steps = e.history!.steps.length
    const err = await thrown(applyHole(host, e.id, 0, { op: 'hole.apply', hole, spec: sized.spec, label: sized.label }))
    expect(toolError(err, { diameterMm: 100000 })).toBe('The diameter is too large. The most is 10000 mm.')
    expect(get().plate.find((p) => p.id === e.id)!.history!.steps).toHaveLength(steps)
  })

  it('Fillet and chamfer say the size is too large and give the most', async () => {
    block()
    const pk = await pickEdge({ mesh: toGeom(entry().parts[0]!), transform: T }, { triangle: 2, at: [110, 109.5, 10] })
    const typed = (v: number) => ({ radiusMm: v, distanceMm: v, distance2Mm: null })
    const round = await thrown(applyEdges(host, 'a', 0, edgeParams('fillet', [pk.edge], 100000, null)))
    expect(toolError(round, typed(100000))).toBe('The radius is too large. The most is 1000 mm.')
    const bevel = await thrown(applyEdges(host, 'a', 0, edgeParams('chamfer', [pk.edge], 100000, null)))
    expect(toolError(bevel, typed(100000))).toBe('The distance is too large. The most is 1000 mm.')
    // the preview says the same
    const preview = await thrown(edgePreview({ mesh: { mesh: toGeom(entry().parts[0]!), transform: T }, edges: [pk.edge], profile: { kind: 'fillet', radiusMm: 100000 } }))
    expect(toolError(preview, typed(100000))).toBe('The radius is too large. The most is 1000 mm.')
    expect(entry().history).toBeUndefined()
  })

  it('keeps the words for a size that fits the limit but not the face', () => {
    const err = new Error('radiusMm: 30 mm does not fit on this face; at most 20.000 mm')
    expect(toolError(err, { radiusMm: 30 })).toBe('Radius 30 mm does not fit on this face; at most 20 mm.')
    expect(toolError(new Error('lengthMm: the thread needs at least one pitch of length (0.7 mm for M4)'), { lengthMm: 0.1 })).toBe('The thread needs at least one pitch of length (0.7 mm for M4).')
  })
})

describe('a custom hole too small to print', () => {
  it('is refused with the smallest the nozzle prints', () => {
    expect(customHoleProblem(0.001, 0.4)).toBe('The diameter is too small to print with a 0.4 mm nozzle. The smallest is 0.4 mm.')
    expect(customHoleProblem(0.3, 0.6)).toBe('The diameter is too small to print with a 0.6 mm nozzle. The smallest is 0.6 mm.')
    expect(customHoleProblem(0.4, 0.4)).toBeNull()
    expect(customHoleProblem(3, 0.4)).toBeNull()
  })
})

describe('a thread longer than its hole', () => {
  it('is refused with the most, which the engine would quietly cut it to', async () => {
    const { item, pick } = await holed()
    const target = await threadFind(item, pick)
    expect(target.internal).toBe(true)
    expect(target.lengthMm).toBeCloseTo(10, 3)
    expect(threadLengthProblem(100000, target)).toBe(`The length is more than the hole is deep. The most is ${Number(target.lengthMm.toFixed(2))} mm.`)
    expect(threadLengthProblem(0, target)).toBe('The length must be more than 0 mm.')
    expect(threadLengthProblem(Number.NaN, target)).toBe('Type a number for the length, or leave it empty for the whole length.')
    expect(threadLengthProblem(5, target)).toBeNull()
    expect(threadLengthProblem(undefined, target)).toBeNull()
    expect(threadLengthProblem(30, { lengthMm: 20, internal: false })).toBe('The length is more than the rod is long. The most is 20 mm.')
  })
})

describe('a step whose face or edge is gone', () => {
  it('says to pick it again, in the step list and in the tool, after the step it was built on goes', async () => {
    block()
    // a chamfer, then a fillet on the edge between the chamfer's face and the side
    const pk = await pickEdge({ mesh: toGeom(entry().parts[0]!), transform: T }, { triangle: 2, at: [110, 109.5, 10] })
    await applyEdges(host, 'a', 0, edgeParams('chamfer', [pk.edge], 2, null))
    const part = entry().parts[0]!
    let tri = -1
    for (let t = 0; t < part.indices.length / 3 && tri < 0; t++) {
      const v = [0, 1, 2].map((k) => [0, 1, 2].map((j) => part.positions[part.indices[t * 3 + k]! * 3 + j]!))
      // the chamfer's face: y + z = 18 in the part's frame
      if (v.every((q) => Math.abs(q[1]! + q[2]! - 18) < 1e-3)) tri = t
    }
    const side = await pickEdge({ mesh: toGeom(part), transform: T }, { triangle: tri, at: [100, 109.9, 8.1] })
    await applyEdges(host, 'a', 0, edgeParams('fillet', [side.edge], 1, null))
    const steps = entry().history!.steps
    expect(steps.map((s) => s.params.op)).toEqual(['edge.chamfer', 'edge.fillet'])
    // the chamfer off and on again: the replay that brings it back keeps the fillet's faces by their keys
    await setSuppressed(host, 'a', 0, true)
    await setSuppressed(host, 'a', 0, false)
    const kept = entry().history!.steps[1]!.params as { edges: { keys?: unknown }[] }
    expect(kept.edges[0]!.keys).toBeDefined()
    await deleteStep(host, 'a', 0)
    const broken = entry().history!.steps[0]!.broken!
    // the engine's own words name a key and say "repair the reference"
    expect(broken).toMatch(/^faceReference:.*repair/)
    const words = 'A face or edge this step was made on is no longer on the part after an earlier change. Pick the face or edges again.'
    expect(sentence(broken)).toBe(words)
    // editing the step: the tool's preview of the stale edges
    const fillet = entry().history!.steps[0]!.params as Extract<(typeof steps)[number]['params'], { op: 'edge.fillet' }>
    const err = await thrown(edgePreview({ mesh: { mesh: toGeom(entry().parts[0]!), transform: T }, edges: fillet.edges, profile: { kind: 'fillet', radiusMm: 1 } }))
    expect(toolError(err, { radiusMm: 1 })).toBe(words)
  })

  it('names the edge when the engine does', () => {
    expect(referenceWords('faceReference: edge 1 has a missing face reference; repair the reference before editing')).toBe('Picked edge 1 is no longer on the part after an earlier change. Pick the edges again.')
    expect(toolError(new Error('faceReference: edge 2 was split; repair the reference before editing'))).toBe('Picked edge 2 was split by an earlier change. Pick the edges again.')
    expect(sentence('brep: faceReference: the face reference was split; repair the reference before editing')).toBe('A face this step was made on was split by an earlier change. Pick the face or edges again.')
    expect(referenceWords('edges: edge 1: no sharp edge between two flat faces there')).toBeNull()
  })

  it('keeps "The design is unchanged." when an exact replay stops on it', () => {
    // as applyHistory throws it for an exact body (history/ops.ts), with the engine's words inside
    const stopped = (why: string) => new Error(`Exact replay stopped: ${why}. The design is unchanged.`)
    expect(toolError(stopped('brep: faceReference: edge 1 has a missing face reference; repair the reference before editing'), { radiusMm: 1 })).toBe(
      'Picked edge 1 is no longer on the part after an earlier change. Pick the edges again. The design is unchanged.',
    )
    expect(toolError(stopped('faceReference: the face reference is missing; repair the reference before editing'))).toBe(
      'A face or edge this step was made on is no longer on the part after an earlier change. Pick the face or edges again. The design is unchanged.',
    )
    // the step list's reason for a mesh replay has no such sentence, and adds none
    expect(sentence('faceReference: the face reference was split; repair the reference before editing')).toBe('A face this step was made on was split by an earlier change. Pick the face or edges again.')
  })
})
