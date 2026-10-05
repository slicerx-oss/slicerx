// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flatFaces, frameFor, triangleAt } from '../src/cad'
import { readStlPositions } from '../src/mesh'
import { boxStl, connect, data } from './helpers'

type V3 = [number, number, number]
interface MeshOut {
  mesh: { stlPath: string }
  volumeMm3: number
  watertight: boolean
  shells: number
}
interface EdgeRef {
  a: V3
  b: V3
  face: V3
}

function tris(stl: Buffer): { p: [V3, V3, V3]; n: V3; area: number }[] {
  const pos = readStlPositions(stl)
  const out = []
  for (let t = 0; t < pos.length; t += 9) {
    const p = [0, 3, 6].map((k) => [pos[t + k], pos[t + k + 1], pos[t + k + 2]] as V3) as [V3, V3, V3]
    const u = p[1].map((c, i) => c - p[0][i]!) as V3
    const v = p[2].map((c, i) => c - p[0][i]!) as V3
    const c: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const l = Math.hypot(...c)
    out.push({ p, n: c.map((x) => x / l) as V3, area: l / 2 })
  }
  return out
}

describe('face lookup without the engine', () => {
  const box = tris(boxStl(30, 20, 10))

  it('groups a box into six flat faces, largest first, with the axis each faces', () => {
    const faces = flatFaces(box)
    expect(faces).toHaveLength(6)
    expect(faces[0]?.areaMm2).toBe(600)
    const top = faces.find((f) => f.facing === '+z (top)')
    expect(top?.center).toEqual([15, 10, 10])
    expect(top?.at[2]).toBe(10)
  })

  it('finds the triangle under a point, and needs a normal on an edge', () => {
    const t = triangleAt(box, [10, 10, 10])
    expect(box[t]?.n[2]).toBeCloseTo(1)
    expect(() => triangleAt(box, [15, 0, 10])).toThrow(/edge between faces/)
    const side = triangleAt(box, [15, 0, 10], [0, -1, 0])
    expect(box[side]?.n[1]).toBeCloseTo(-1)
    expect(() => triangleAt(box, [15, 10, 40])).toThrow(/no face within/)
    expect(() => triangleAt(box, [10, 10, 10], [1, 0, 0])).toThrow(/faces that way/)
  })

  it('makes the same plane frame as the engine', () => {
    expect(frameFor([0, 0, 5], [0, 0, 2])).toEqual({ origin: [0, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
    const wall = frameFor([0, 0, 0], [0, -1, 0])
    expect(wall.u).toEqual([1, 0, 0])
    expect(wall.v[2]).toBeCloseTo(1)
  })
})

// Runs where sx-geom has been built (cargo build -p sx-geom --release), or SLICERX_SX_GEOM_BIN names one.
const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release/sx-geom')
describe.skipIf(!existsSync(geomBin))('CAD tools with the real sx-geom', () => {
  const rect = { type: 'rectangle', widthMm: 30, heightMm: 20 }
  const place = { center: [15, 10] }

  it('lists the CAD tools', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const names = (await h.client.listTools()).tools.map((t) => t.name)
    for (const n of ['faces', 'face_pick', 'edge_pick', 'sketch_check', 'extrude', 'revolve', 'push_pull', 'boolean', 'fillet', 'chamfer']) expect(names).toContain(`slicerx_geom_${n}`)
  })

  it('extrudes a rectangle, then cuts a hole into its top face', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const r = await h.call('slicerx_geom_extrude', { shape: rect, placement: place, distance_mm: 10 })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const body = data<{ output: MeshOut }>(r).output
    expect(body.volumeMm3).toBeCloseTo(6000, 3)
    expect(body.watertight).toBe(true)

    const faces = data<{ output: { faces: { at: V3; normal: V3; facing?: string; areaMm2: number }[] } }>(await h.call('slicerx_geom_faces', { model: body.mesh.stlPath })).output.faces
    const top = faces.find((f) => f.facing === '+z (top)')
    expect(top?.areaMm2).toBeCloseTo(600, 3)

    const pick = await h.call('slicerx_geom_face_pick', { model: body.mesh.stlPath, face: { at: top?.at, normal: top?.normal } })
    expect(pick.isError, JSON.stringify(pick.content)).toBeFalsy()
    const frame = data<{ output: { frame: { origin: V3 }; areaMm2: number } }>(pick).output.frame
    frame.origin.forEach((c, k) => expect(c).toBeCloseTo([15, 10, 10][k] ?? 0))

    const hole = await h.call('slicerx_geom_extrude', { shape: { type: 'circle', diameterMm: 6 }, frame, distance_mm: 5, operation: 'cut', target: body.mesh.stlPath })
    expect(hole.isError, JSON.stringify(hole.content)).toBeFalsy()
    const cut = data<{ output: MeshOut }>(hole).output
    expect(6000 - cut.volumeMm3).toBeGreaterThan(Math.PI * 9 * 5 * 0.97)
    expect(6000 - cut.volumeMm3).toBeLessThan(Math.PI * 9 * 5 * 1.01)
    expect(cut.watertight).toBe(true)
  })

  it('sketches on any plane from an origin and a normal', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const r = await h.call('slicerx_geom_extrude', { shape: { type: 'sketch', loops: [{ points: [[0, 0], [10, 0], [10, 5], [0, 5]] }] }, frame: { origin: [0, 0, 20], normal: [0, 0, 1] }, distance_mm: 2 })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const out = data<{ output: MeshOut & { bounds: { min: V3 } } }>(r).output
    expect(out.volumeMm3).toBeCloseTo(100, 3)
    expect(out.bounds.min[2]).toBeCloseTo(20)
  })

  it('pulls a face, then fillets and chamfers its edges', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    writeFileSync(join(h.dir, 'box.stl'), boxStl(30, 20, 10))
    const model = join(h.dir, 'box.stl')
    const pulled = await h.call('slicerx_geom_push_pull', { model, face: { at: [15, 10, 10] }, distance_mm: 5 })
    expect(pulled.isError, JSON.stringify(pulled.content)).toBeFalsy()
    expect(data<{ output: MeshOut }>(pulled).output.volumeMm3).toBeCloseTo(9000, 3)

    const e = await h.call('slicerx_geom_edge_pick', { model, face: { at: [15, 0, 10], normal: [0, 0, 1] } })
    expect(e.isError, JSON.stringify(e.content)).toBeFalsy()
    const edge = data<{ output: { edge: EdgeRef; supported: boolean; lengthMm: number; loop: { edge: EdgeRef; supported: boolean }[] } }>(e).output
    expect(edge.supported).toBe(true)
    expect(edge.lengthMm).toBeCloseTo(30)
    expect(edge.loop).toHaveLength(4)

    const ch = await h.call('slicerx_geom_chamfer', { model, edges: [edge.edge], distance_mm: 1 })
    expect(ch.isError, JSON.stringify(ch.content)).toBeFalsy()
    expect(6000 - data<{ output: MeshOut }>(ch).output.volumeMm3).toBeCloseTo(15, 2)

    const f = await h.call('slicerx_geom_fillet', { model, edges: edge.loop.map((l) => l.edge), radius_mm: 2 })
    expect(f.isError, JSON.stringify(f.content)).toBeFalsy()
    const rounded = data<{ output: MeshOut }>(f).output
    // each edge loses (4 - pi) mm2 of cross section along its length
    expect(6000 - rounded.volumeMm3).toBeGreaterThan((4 - Math.PI) * 100 * 0.8)
    expect(rounded.watertight).toBe(true)

    const tooBig = await h.call('slicerx_geom_fillet', { model, edges: [edge.edge], radius_mm: 50 })
    expect(tooBig.isError).toBe(true)
  })

  it('runs union, subtract and intersect', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    writeFileSync(join(h.dir, 'a.stl'), boxStl(20, 20, 20))
    const pin = await h.call('slicerx_geom_extrude', { shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: { center: [20, 10] }, distance_mm: 20 })
    const b = data<{ output: MeshOut }>(pin).output.mesh.stlPath
    const a = join(h.dir, 'a.stl')
    const vol = async (op: string): Promise<number> => {
      const r = await h.call('slicerx_geom_boolean', { op, model: a, with: [b] })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      return data<{ output: MeshOut }>(r).output.volumeMm3
    }
    expect(await vol('union')).toBeCloseTo(9000, 2)
    expect(await vol('subtract')).toBeCloseTo(7000, 2)
    expect(await vol('intersect')).toBeCloseTo(1000, 2)
  })

  it('revolves a profile and checks a sketch', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const ring = [{ points: [[5, 0], [10, 0], [10, 10], [5, 10]] }]
    const r = await h.call('slicerx_geom_revolve', { loops: ring, axis: { point: [0, 0], direction: [0, 1] } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const v = data<{ output: MeshOut }>(r).output.volumeMm3
    expect(v).toBeGreaterThan(Math.PI * 75 * 10 * 0.97)
    expect(v).toBeLessThan(Math.PI * 75 * 10 * 1.001)

    const ok = data<{ ok: boolean; output: { areaMm2: number } }>(await h.call('slicerx_geom_sketch_check', { loops: ring }))
    expect(ok.output.areaMm2).toBeCloseTo(50)
    const open = await h.call('slicerx_geom_sketch_check', { loops: [{ start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'line', to: [10, 10] }] }] })
    const issues = data<{ output: { ok: boolean; issues: { kind: string }[] } }>(open).output
    expect(issues.ok).toBe(false)
    expect(issues.issues[0]?.kind).toBe('open')
  })

  it('rejects bad requests with a reason', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const noTarget = await h.call('slicerx_geom_extrude', { shape: rect, distance_mm: 5, operation: 'cut' })
    expect(noTarget.isError).toBe(true)
    expect(JSON.stringify(noTarget.content)).toMatch(/needs a target model/)
    const zero = await h.call('slicerx_geom_push_pull', { model: 'sample:cube-20', face: { at: [10, 10, 20] }, distance_mm: 0 })
    expect(zero.isError).toBe(true)
    const air = await h.call('slicerx_geom_face_pick', { model: 'sample:cube-20', face: { at: [100, 100, 100] } })
    expect(air.isError).toBe(true)
    expect(JSON.stringify(air.content)).toMatch(/slicerx_geom_faces/)
    const badShape = await h.call('slicerx_geom_extrude', { shape: { type: 'star' }, distance_mm: 5 })
    expect(badShape.isError).toBe(true)
  })

  it('follows the permission policy: lookups read, modeling is in the slice class', async () => {
    const h = await connect({ sxGeomBin: geomBin, policy: { classes: { slice: 'off', queue: 'off', start: 'off', profile: 'off' } } })
    const r = await h.call('slicerx_geom_extrude', { shape: rect, distance_mm: 5 })
    expect(r.isError).toBe(true)
    const read = await h.call('slicerx_geom_faces', { model: 'sample:cube-20' })
    expect(read.isError, JSON.stringify(read.content)).toBeFalsy()
  })
})
