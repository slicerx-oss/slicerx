// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client draws ellipses the way an agent would: checks a sketch with one and reads back its area and perimeter,
// extrudes one as a shape, mirrors one in a sketch, and is told in words why its rim takes no fillet or chamfer.
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { built, connect, data, GEOM_BUILD, text } from './helpers'

type V3 = [number, number, number]
interface MeshOut {
  mesh: { stlPath: string }
  volumeMm3: number
  watertight: boolean
}

const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release/sx-geom')
// Ramanujan's perimeter of an ellipse with half axes a and b
const perimeter = (a: number, b: number) => {
  const h = ((a - b) / (a + b)) ** 2
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}

describe.skipIf(!built(geomBin, GEOM_BUILD))('ellipses through the CAD tools', () => {
  it('checks a sketch with an ellipse hole and reads back its area and perimeter', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const loops = [{ points: [[-20, -10], [20, -10], [20, 10], [-20, 10]] }, { type: 'ellipse', center: [2, 1], widthMm: 16, heightMm: 8, angleDeg: 20 }]
    const r = await h.call('slicerx_geom_sketch_check', { loops })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ output: { ok: boolean; areaMm2: number; loops: { index: number; role: string; areaMm2: number; lengthMm: number }[] } }>(r).output
    expect(out.ok).toBe(true)
    const hole = out.loops.find((l) => l.index === 1)!
    expect(hole.role).toBe('hole')
    // the ring sits inside the true curve by no more than the arc tolerance
    expect(hole.areaMm2).toBeLessThan(Math.PI * 32)
    expect(hole.areaMm2).toBeGreaterThan(Math.PI * 32 * 0.998)
    expect(hole.lengthMm).toBeCloseTo(perimeter(8, 4), 1)
    expect(out.areaMm2).toBeCloseTo(800 - hole.areaMm2, 6)

    const bad = await h.call('slicerx_geom_sketch_check', { loops: [{ type: 'ellipse', center: [0, 0], widthMm: 4 }] })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/heightMm/)
  })

  it('extrudes an ellipse shape and mirrors one in a sketch', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const r = await h.call('slicerx_geom_extrude', { shape: { type: 'ellipse', widthMm: 30, heightMm: 16 }, placement: { center: [20, 15], rotationDeg: 90 }, distance_mm: 10 })
    expect(r.isError, text(r)).toBeFalsy()
    const body = data<{ output: MeshOut & { bounds: { min: V3; max: V3 } } }>(r).output
    expect(body.watertight).toBe(true)
    expect(body.volumeMm3).toBeGreaterThan(Math.PI * 120 * 10 * 0.998)
    expect(body.volumeMm3).toBeLessThan(Math.PI * 120 * 10)
    // turned a quarter: the width runs along y
    expect(body.bounds.max[1]).toBeCloseTo(30, 3)
    expect(body.bounds.max[0]).toBeCloseTo(28, 3)

    const m = await h.call('slicerx_geom_sketch_edit', { op: 'mirror', loops: [{ type: 'ellipse', center: [10, 0], widthMm: 8, heightMm: 4, angleDeg: 30 }], pick: [0], axis: { point: [0, 0], direction: [0, 1] } })
    expect(m.isError, text(m)).toBeFalsy()
    const copy = data<{ output: { loops: { type: string; center: number[]; angleDeg: number }[] } }>(m).output.loops[1]!
    expect(copy.type).toBe('ellipse')
    expect(copy.center[0]).toBeCloseTo(-10, 9)
    expect(copy.angleDeg).toBeCloseTo(150, 9)
  })

  it('says why an ellipse rim takes no fillet or chamfer', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const r = await h.call('slicerx_geom_extrude', { shape: { type: 'ellipse', widthMm: 30, heightMm: 16 }, placement: { center: [20, 15] }, distance_mm: 10 })
    const model = data<{ output: MeshOut }>(r).output.mesh.stlPath
    const e = await h.call('slicerx_geom_edge_pick', { model, face: { at: [34.9, 15.5, 10], normal: [0, 0, 1] } })
    expect(e.isError, text(e)).toBeFalsy()
    const pick = data<{ output: { edge: { a: V3; b: V3; face: V3 }; supported: boolean; reason?: string } }>(e).output
    expect(pick.supported).toBe(false)
    expect(pick.reason).toMatch(/goes around an ellipse/)
    for (const [tool, size] of [['slicerx_geom_fillet', { radius_mm: 1 }], ['slicerx_geom_chamfer', { distance_mm: 1 }]] as const) {
      const f = await h.call(tool, { model, edges: [pick.edge], ...size })
      expect(f.isError).toBe(true)
      expect(text(f)).toMatch(/edge 1: the edge goes around an ellipse/)
    }
  })
})
