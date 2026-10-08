// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The v1 CAD calls in geom/cad.ts (push and pull, sketches, SVG on a face, dimensions) against the
// geometry engine. With a built engine (packages/geom/wasm/pkg/sx_geom_wasm.wasm, or SX_GEOM_WASM)
// the calls run in the real wasm; without one they replay replies recorded from it in
// fixtures/cad-v1-replies.json, by test (test/geom-engine.ts). SX_GEOM_RECORD=1 with a built engine records it again.
import { beforeEach, describe, expect, it } from 'vitest'
import type { GeomMesh } from '../src/geom/client'
import { useGeomEngine } from './geom-engine'
import {
  chamferSketch,
  checkSketch,
  dimensionAnchor,
  edgeOp,
  edgePreview,
  filletSketch,
  pickEdge,
  evaluateDimensions,
  extrudeShape,
  offsetSketch,
  pickFace,
  pushFace,
  pushPreview,
  revolveSketch,
  sketchSnaps,
  type Dimension,
  type FacePick,
  type MeshItem,
  type SketchLoop,
} from '../src/geom/cad'

useGeomEngine('cad-v1-replies')

/** A 20 mm cube at the local origin; triangles 2 and 3 are the top. */
function cube(): GeomMesh {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1].map((v) => v * 20)
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions, indices }
}

const moved = (x: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]
const body: MeshItem = { mesh: cube(), transform: moved(50) }
const topPick = { triangle: 2, at: [60, 10, 20] as [number, number, number] }

describe('v1 CAD calls', () => {
  let face: FacePick
  // Every test starts from the picked top face, whatever ran before it.
  beforeEach(async () => {
    face = await pickFace(body, topPick)
  })

  it('pulls a face out with a preview first, and refuses a zero move', async () => {
    const preview = await pushPreview(face, 5)
    expect(preview.operation).toBe('join')
    expect(preview.tool.indices.length).toBeGreaterThan(0)
    const r = await pushFace({ mesh: body, pick: topPick, distanceMm: 5 })
    expect(r.watertight).toBe(true)
    expect(r.volumeMm3).toBeCloseTo(20 * 20 * 25, 6)
    // The body stays in its own frame.
    expect(r.bounds!.min[0]).toBeCloseTo(0, 9)
    expect(r.moved.distanceMm).toBe(5)
    await expect(pushFace({ mesh: body, pick: topPick, distanceMm: 0 })).rejects.toThrow(/must not be zero/)
  })

  it('checks a sketch and names the segment that is wrong', async () => {
    const bow: SketchLoop[] = [{ points: [[0, 0], [10, 10], [10, 0], [0, 10]] }]
    const bad = await checkSketch(bow)
    expect(bad.ok).toBe(false)
    expect(bad.issues[0]).toMatchObject({ loop: 0, kind: 'selfCrossing' })
    expect(bad.issues[0]!.message).toBe('Loop 1: segment 3 crosses segment 1.')
    const open = await checkSketch([{ start: [0, 0], segments: [{ type: 'line', lengthMm: 10, angleDeg: 0 }, { type: 'line', lengthMm: 10, turnDeg: 90 }] }])
    expect(open.issues[0]).toMatchObject({ kind: 'open', segment: 1 })
  })

  it('cuts a sketch with a hole into a face, and revolves and offsets it', async () => {
    const loops: SketchLoop[] = [
      { start: [-6, -3], segments: [{ type: 'line', to: [6, -3] }, { type: 'arc', radiusMm: 3, sweepDeg: 180 }, { type: 'line', to: [-6, 3] }, { type: 'arc', radiusMm: 3, sweepDeg: 180 }] },
      { type: 'circle', center: [0, 0], diameterMm: 2 },
    ]
    const c = await checkSketch(loops)
    expect(c.ok).toBe(true)
    expect(c.loops.map((l) => l.role)).toEqual(['outer', 'hole'])
    const cut = await extrudeShape({ frame: face.frame, shape: { type: 'sketch', loops }, spec: { distanceMm: 2, operation: 'cut' }, target: body })
    expect(cut.frame).toBe('target')
    expect(cut.watertight).toBe(true)
    expect(cut.report.volumeChangeMm3).toBeCloseTo(-c.areaMm2 * 2, 1)
    const ring = await revolveSketch({ loops: [{ points: [[5, 0], [8, 0], [8, 2], [5, 2]] }], axis: { point: [0, 0], direction: [0, 1] }, angleDeg: 180 })
    expect(ring.watertight).toBe(true)
    expect(ring.volumeMm3).toBeCloseTo((Math.PI * (64 - 25) * 2) / 2, 0)
    const off = await offsetSketch({ loops: [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] }, 1, 'miter')
    expect(off.areaMm2).toBeCloseTo(144, 2)
  })

  it('places an SVG outline on the face at a typed width', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="5"/></svg>'
    const r = await extrudeShape({ frame: face.frame, shape: { type: 'svg', svg, widthMm: 8 }, spec: { distanceMm: 1, operation: 'join' }, target: body })
    expect(r.watertight).toBe(true)
    expect(r.report.volumeChangeMm3).toBeCloseTo(8 * 4 * 1, 3)
  })

  it('gives snap points on the picked face', async () => {
    const s = await sketchSnaps(face.frame, face.outline)
    expect(s.points.filter((p) => p.kind === 'vertex')).toHaveLength(4)
    expect(s.points.filter((p) => p.kind === 'midpoint')).toHaveLength(4)
  })

  it('keeps a height dimension through a push', async () => {
    const top = await dimensionAnchor('c', body, topPick)
    const bottom = await dimensionAnchor('c', body, { triangle: 0, at: [60, 10, 0] })
    const dim: Dimension = { id: 'h', kind: 'distance', a: top.anchor, b: bottom.anchor, value: 20 }
    const pushed = await pushFace({ mesh: body, pick: topPick, distanceMm: -4 })
    const [d] = await evaluateDimensions([dim], { c: { mesh: pushed.mesh, transform: moved(50) } }, [{ ...pushed.moved, object: 'c' }])
    expect(d!.status).toBe('ok')
    expect(d!.value).toBeCloseTo(16, 6)
    expect(d!.changed).toBe(true)
    const [lost] = await evaluateDimensions([dim], { c: { mesh: pushed.mesh, transform: moved(50) } })
    expect(lost!.status).toBe('lost')
    expect(lost!.message).toBe('The feature this dimension started from is gone.')
  })
})

describe('fillet and chamfer calls', () => {
  // Near the front edge of the top face.
  const edgePick = { triangle: 2, at: [60, 0.5, 20] as [number, number, number] }

  it('picks an edge with its faces, limits and loop', async () => {
    const p = await pickEdge(body, edgePick)
    expect(p.supported).toBe(true)
    expect(p.convex).toBe(true)
    expect(p.dihedralDeg).toBeCloseTo(90, 9)
    expect(p.lengthMm).toBeCloseTo(20, 9)
    expect(p.faces).toHaveLength(2)
    expect(p.maxDistanceMm).toEqual([20, 20])
    expect(p.maxRadiusMm).toBe(20)
    expect(p.loop).toHaveLength(4)
    expect(p.chain).toEqual([p.edge])
  })

  it('previews, then fillets and chamfers, and refuses a round that does not fit', async () => {
    const { edge } = await pickEdge(body, edgePick)
    const preview = await edgePreview({ mesh: body, edges: [edge], profile: { kind: 'fillet', radiusMm: 3 } })
    expect(preview.cut.indices.length).toBeGreaterThan(0)
    expect(preview.join.indices).toHaveLength(0)
    const r = await edgeOp({ mesh: body, edges: [edge], profile: { kind: 'fillet', radiusMm: 3 } })
    expect(r.watertight).toBe(true)
    expect(r.edges[0]!.convex).toBe(true)
    // Chords sit inside the arc, so a hair more goes than the exact round.
    const exact = 8000 - 20 * 9 * (1 - Math.PI / 4)
    expect(r.volumeMm3).toBeLessThan(exact)
    expect(r.volumeMm3).toBeGreaterThan(exact - 1)
    expect(r.bounds!.min[0]).toBeCloseTo(0, 9)
    const c = await edgeOp({ mesh: body, edges: [edge], profile: { kind: 'chamfer', distanceMm: 2, distance2Mm: 4 } })
    expect(c.volumeMm3).toBeCloseTo(8000 - 80, 6)
    await expect(edgeOp({ mesh: body, edges: [edge], profile: { kind: 'fillet', radiusMm: 25 } })).rejects.toThrow('radiusMm: 25 mm does not fit on this face; at most 20.000 mm')
  })

  it('rounds and bevels sketch corners', async () => {
    const square: SketchLoop[] = [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]] }]
    const f = await filletSketch(square, [{ loop: 0, vertex: 1 }], 2)
    expect(f.added).toEqual([{ loop: 0, segment: 1 }])
    const checked = await checkSketch(f.loops)
    expect(checked.ok).toBe(true)
    expect(checked.areaMm2).toBeCloseTo(100 - 4 * (1 - Math.PI / 4), 1)
    const b = await chamferSketch(square, [{ loop: 0, vertex: 0 }, { loop: 0, vertex: 2 }], 1)
    expect((await checkSketch(b.loops)).areaMm2).toBeCloseTo(99, 9)
    await expect(filletSketch(square, [{ loop: 0, vertex: 1 }], 11)).rejects.toThrow('radiusMm: 11 mm does not fit at corner 2 of loop 1; at most 10.000 mm')
  })
})
