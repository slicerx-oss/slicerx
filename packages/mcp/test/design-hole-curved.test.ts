// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A hole on a curved side: a ship's hull lofted smooth through eight sections, its side flat only from x 80 to 140 and
// curving in toward the bow and the stern. A point given a little off the side, as a row of portholes along a guessed
// beam is, goes onto the side along the hole's direction and the hole goes in square to the surface there, and the
// answer says where it moved; a point farther off is refused with the surface point nearest it. On an exact design the
// cut starts a little outside the curved side, so the body keeps only the hole's own faces, with no sliver where the
// cut's end would only touch the side.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { connect, data, noKernel, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V2 = [number, number]

/** A hull section across x at `x`: a flat deck `top` high, upright sides down to `side`, and a spline bilge through `bilge`. */
const section = (x: number, half: number, top: number, side: number, bilge: V2[]) => ({
  frame: { origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  loops: [{ start: [-half, top], segments: [
    { type: 'line', to: [half, top] },
    { type: 'line', to: [half, side] },
    { type: 'spline', points: bilge, to: [-half, side] },
    { type: 'line', to: [-half, top] },
  ] }],
})
const bilge = (w: number, a: number, b: number, c: number, d: number): V2[] => [[w, a], [b, c], [0, d], [-b, c], [-w, a]]
const HULL = [
  section(0, 3.5, 11.8, 9.46, bilge(2.98, 5.95, 1.58, 4.39, 4)),
  section(10, 7.5, 11.7, 8.64, bilge(6.38, 4.05, 3.38, 2.01, 1.5)),
  section(30, 10.5, 11.5, 8.05, bilge(8.93, 2.88, 4.73, 0.58, 0)),
  section(80, 11, 11.5, 8.05, bilge(9.35, 2.88, 4.95, 0.58, 0)),
  section(140, 11, 11.5, 8.05, bilge(9.35, 2.88, 4.95, 0.58, 0)),
  section(175, 9.5, 12, 8.55, bilge(8.08, 3.38, 4.28, 1.08, 0.5)),
  section(198, 5.5, 12.6, 9.72, bilge(4.68, 5.4, 2.48, 3.48, 3)),
  section(215, 1.2, 13, 11.2, bilge(1.02, 8.5, 0.54, 7.3, 7)),
]
/** A 1 mm porthole 0.6 mm deep on the starboard side, its point on the beam the flat midbody has. */
const porthole = (design: string, x: number) => ({ design, part: 0, face: { at: [x, -11, 10], normal: [0, -1, 0] }, diameter_mm: 1, depth_mm: 0.6, label: 'Porthole' })

type Client = Awaited<ReturnType<typeof connect>>
async function hull(h: Client, exact: boolean): Promise<string> {
  const made = await h.call('slicerx_design_new', exact ? { name: 'Hull', exact: true } : { name: 'Hull' })
  expect(made.isError, text(made)).toBeFalsy()
  const d = data<{ output: { design: string } }>(made).output.design
  const loft = await h.call('slicerx_geom_loft', { design: d, profiles: HULL, smooth: true, name: 'Hull' })
  expect(loft.isError, text(loft)).toBeFalsy()
  return d
}

const geom = useGeomEngine('design-hole-curved-replies')
// these numbers follow today's mesh loft, which folds this side; they move when the mesh loft fix lands

describe('a hole on a curved side of a design', () => {
  it('goes onto the side from a point a little off it, square to the surface there, and says where it moved', async () => {
    const h = await connect({ geomEngine: (op, r) => geom.engine(op, r) })
    const d = await hull(h, false)
    const r = await h.call('slicerx_geom_hole', porthole(d, 40))
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain('; (40, -11, 10) is 0.243 mm off the surface, so the hole starts where its direction meets the surface, at (40, -10.757, 10)')
    const out = data<{ output: { onto: { from: number[]; to: number[]; mm: number }; lastStep: { op: string } } }>(r).output
    expect(out.onto).toEqual({ from: [40, -11, 10], to: [40, -10.757, 10], mm: 0.243 })
    expect(out.lastStep.op).toBe('shape.extrude')
  }, 120_000)

  it('refuses a point farther off the side, naming the surface point nearest it and the gap, and leaves the design as it was', async () => {
    const h = await connect({ geomEngine: (op, r) => geom.engine(op, r) })
    const d = await hull(h, false)
    const r = await h.call('slicerx_geom_hole', porthole(d, 20))
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('at: no face within 0.02 mm of (20, -11, 10); the surface nearest it is at (20.063, -9.768, 9.617), 1.292 mm away; give a point on the face the hole starts at')
    const steps = data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps).toHaveLength(1)
  }, 120_000)
})

const bin = process.env['SLICERX_SX_GEOM_BIN']
// the exact cases run on an sx-geom with the exact kernel, and skip saying why without one
const why = noKernel(bin)
const skipped = why ? ` (skipped: ${why})` : ''
afterEach(() => { vi.unstubAllEnvs(); clearReplayCache() })

describe.skipIf(why !== null)(`a hole on a curved side of an exact design${skipped}`, () => {
  const exactHull = async () => {
    vi.stubEnv('SX_BREP_DEV', '1')
    const native = geomEngine(bin!, 120_000)
    const h = await connect({ geomEngine: (op, r) => native(op, r) })
    return { h, native, d: await hull(h, true) }
  }
  const faceCount = async (h: Client, d: string): Promise<number> =>
    data<{ output: { topology: { faceCount: number } } }>(await h.call('slicerx_geom_faces', { design: d, format: 'topology', limit: 500 })).output.topology.faceCount

  it('goes onto the side from the point the run gave, and the body keeps only the hole\'s own two faces', async () => {
    const { h, d } = await exactHull()
    expect(await faceCount(h, d)).toBe(6)
    const r = await h.call('slicerx_geom_hole', porthole(d, 40))
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain('; (40, -11, 10) is 0.228 mm off the surface, so the hole starts where its direction meets the surface, at (40, -10.772, 10)')
    // the hole's wall and its floor, and no sliver face where the cut's end would only touch the curved side
    expect(await faceCount(h, d)).toBe(8)
    const steps = data<{ output: { steps: { params?: { spec?: Record<string, unknown> } }[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps).toHaveLength(2)
  }, 240_000)

  it('refuses a point farther off the side, naming the surface point nearest it and the gap', async () => {
    const { h, d } = await exactHull()
    const r = await h.call('slicerx_geom_hole', porthole(d, 20))
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('at: no face within 0.02 mm of (20, -11, 10); the surface nearest it is at (20.209, -9.623, 10), 1.393 mm away; give a point on the face the hole starts at')
  }, 240_000)

  it('starts the cut outside the curved side: a cut whose end only touches the side leaves a sliver face, one 0.05 mm out does not', async () => {
    vi.stubEnv('SX_BREP_DEV', '1')
    const native = geomEngine(bin!, 120_000)
    const loft = (await native('sketch.loft', { profiles: HULL, smooth: true, exact: true, save: true })) as { bodySmb?: string }
    expect(typeof loft.bodySmb).toBe('string')
    // the hole at x 40 as the tool places it: on the side where the line along -y meets it, square to the surface there
    const n = [-0.0179, -0.9998, 0.0016]
    const l = Math.hypot(...n)
    const normal = n.map((c) => c / l)
    const u = [1 - normal[0]! * normal[0]!, -normal[0]! * normal[1]!, -normal[0]! * normal[2]!]
    const ul = Math.hypot(...u)
    const frame = { origin: [40, -10.7717, 10], normal, u: u.map((c) => c / ul) }
    const faces = async (toMm: number): Promise<number> => {
      const cut = (await native('brep.extrude', { frame, polygons: [{ outer: { center: [0, 0], diameterMm: 1 }, holes: [] }], fromMm: -0.6, toMm, target: { smb: loft.bodySmb }, operation: 'cut', save: true })) as { bodySmb?: string; touches?: boolean }
      expect(cut.touches).toBe(true)
      const shown = (await native('brep.tessellate', { body: { smb: cut.bodySmb } })) as { faces: unknown[] }
      return shown.faces.length
    }
    expect(await faces(0)).toBe(9)
    expect(await faces(0.05)).toBe(8)
  }, 240_000)
})
