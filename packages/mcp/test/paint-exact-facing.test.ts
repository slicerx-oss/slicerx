// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Faces up (a direction target) painted on an exact design: each face goes whole or not at all, by its own normal, so
// a curved face with only a few triangles facing up stays bare and the design stays exact. The preview is the step's
// own replay and names the faces it paints; applying it reads the same paint back. A stand-in exact engine.
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { leaf, type Row } from './band-engine'
import { connect, data, text } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

type V = [number, number, number]
const deg = Math.PI / 180
/** A triangle at `a` whose normal leans `tilt` degrees from up, toward -Y, with legs of 10 mm. */
const leaning = (a: V, tilt: number): V[] => [a, [a[0] + 10, a[1], a[2]], [a[0], a[1] + 10 * Math.cos(tilt * deg), a[2] + 10 * Math.sin(tilt * deg)]]
const normal = (p: number[], i: number[], t: number): V => {
  const at = (k: number) => [p[3 * i[3 * t + k]!]!, p[3 * i[3 * t + k]! + 1]!, p[3 * i[3 * t + k]! + 2]!]
  const [a, b, c] = [at(0), at(1), at(2)]
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
  const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
  const n: V = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
  const l = Math.hypot(...n)
  return [n[0] / l, n[1] / l, n[2] / l]
}

/**
 * The hull as three faces: a flat deck (two triangles, 30 x 10 at 10 mm), a curved side whose one triangle leans
 * 20 degrees from up and the other 80, and a flat bottom. paint.select picks the triangles within the target's angle.
 */
function engine() {
  const ops: string[] = []
  const call = async (op: string, request: unknown): Promise<unknown> => {
    ops.push(op)
    const req = request as Record<string, unknown>
    const salt = (req['keySalt'] as number) ?? 0
    switch (op) {
      case 'brep.count':
        return { bodies: 0 }
      case 'exact.ops':
        return { ops: [] }
      case 'brep.extrude':
        return { bodySmb: 'hull' }
      case 'brep.tessellate': {
        const tris: V[][] = [
          [[0, 0, 10], [30, 0, 10], [30, 10, 10]], [[0, 0, 10], [30, 10, 10], [0, 10, 10]],
          leaning([0, 20, 0], 20), leaning([20, 20, 0], 80),
          [[0, 0, 0], [30, 10, 0], [30, 0, 0]], [[0, 0, 0], [0, 10, 0], [30, 10, 0]],
        ]
        return { positions: tris.flat(2), indices: Array.from({ length: 18 }, (_, i) => i), faceIds: [0, 0, 1, 1, 2, 2], faces: [0, 1, 2].map((id) => ({ id, type: id === 1 ? 'bspline' : 'plane', key: salt + id + 1 })) }
      }
      case 'paint.select': {
        const mesh = req['mesh'] as { positions: number[]; indices: number[] }
        const target = req['target'] as { kind: string; angleDeg?: number }
        const n = mesh.indices.length / 3
        const picked = Array.from({ length: n }, (_, t) => t).filter((t) => target.kind === 'part' || normal(mesh.positions, mesh.indices, t)[2] >= Math.cos((target.angleDeg ?? 30) * deg))
        return { changed: Object.fromEntries(picked.map((t) => [String(t), leaf(req['state'] as number)])), changedTriangles: picked.length, selectedAreaMm2: 0, regionCount: 1, regions: [] }
      }
      case 'paint.regions': {
        const painted = Object.values(req['paint'] as Record<string, string>)
        return { states: [...new Set(painted)].map((s) => ({ state: Number.parseInt(s, 16) >> 2, areaMm2: 0, triangles: painted.filter((x) => x === s).length, regionCount: 1, regions: [] })) }
      }
      case 'render':
        return { widthPx: 64, heightPx: 64, objects: (req['objects'] as unknown[]).length }
    }
    throw new Error(`unexpected operation ${op}`)
  }
  return { call, ops }
}

it('paints faces up on an exact design face by face, leaving a curved face that only partly faces up bare', async () => {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: engine().call })
  const created = await h.call('slicerx_design_new', { name: 'Hull', exact: true })
  const design = data<{ output: { design: string } }>(created).output.design
  const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 10 })
  expect(made.isError, text(made)).toBeFalsy()
  const preview = await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: { kind: 'direction', direction: 'top', angle_deg: 25 } })
  expect(preview.isError, text(preview)).toBeFalsy()
  const pv = data<{ output: { preview: string; areaMm2: number; parts: (Row & { changedTriangles: number })[] } }>(preview).output
  // the deck, 30 x 10, whole; not the side's one triangle within 25 degrees of up
  expect(pv.parts.map((p) => [p.changedTriangles, p.faces?.map((f) => [f.state, f.areaMm2])])).toEqual([[2, [[2, 300]]]])
  expect(pv.areaMm2).toBe(300)
  const applied = await h.call('slicerx_paint_apply', { preview: pv.preview })
  expect(applied.isError, text(applied)).toBeFalsy()
  const out = data<{ ok: boolean; output: { paint: Row[]; design: { exact: boolean } } }>(applied)
  expect(out.ok).toBe(true)
  expect(out.output.paint[0]!.faces!.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300]])
})
