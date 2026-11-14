// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sketch frame given with its v: a v square to u and the normal is kept, so a sketch point [a, b] lands at
// origin + a u + b v. A v that runs against normal x u (a side face with u along X and v up) is a mirrored frame: the
// engine reads v as normal x u, so the sketch is mirrored onto that frame and lands where the frame given put it, on
// the mesh and the exact path. Each axis is scaled to 1 long; axes not square are refused, naming which and by how
// much; text, SVG artwork and a trace on a mirrored frame are refused, since they would read backwards.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { geomEngine } from '../src/geom'
import { built, connect, data, GEOM_BUILD, noKernel, text } from './helpers'

afterEach(() => { vi.unstubAllEnvs(); clearReplayCache() })

type V3 = [number, number, number]
type Frame = { origin: V3; normal: V3; u: V3; v: V3 }
const box = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
const at = (f: Frame, p: readonly number[]): V3 => [0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * p[0]! + f.v[k]! * p[1]!) as V3
const near = (a: readonly number[], b: readonly number[]) => a.forEach((x, k) => expect(x).toBeCloseTo(b[k]!, 9))

// the side of a hull: normal out along +Y, u along the hull (+X), v up (+Z), so u x v is -normal
const SIDE: Frame = { origin: [0, 12, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }
const PORTS = [92, 98, 104, 110, 116, 122, 128].map((x) => ({ type: 'circle' as const, center: [x, 11] as [number, number], diameterMm: 3.2 }))

/** A stand-in engine that keeps each shape.extrude it is asked for. */
function recording() {
  const asked: { frame: Frame; shape: { loops?: { center: [number, number] }[] }; placement?: { center?: number[]; rotationDeg?: number } }[] = []
  const engine = async (op: string, params?: unknown): Promise<unknown> => {
    if (op === 'shape.extrude') asked.push(params as (typeof asked)[number])
    return { mesh: box, report: { touches: true } }
  }
  return { asked, engine }
}

it('puts a sketch on a mirrored frame where the frame put it: the step keeps v as normal x u and the loops mirrored', async () => {
  const { asked, engine } = recording()
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull' })).output.design
  expect((await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5 })).isError).toBeFalsy()
  const cut = await h.call('slicerx_geom_extrude', { design, shape: { type: 'sketch', loops: PORTS }, frame: SIDE, distance_mm: 1.5, extent: 'oneSide', operation: 'cut', part: 0, feature: 'Portholes' })
  expect(cut.isError, text(cut)).toBeFalsy()
  expect(text(cut)).toContain("The frame's v [0, 0, 1] runs opposite normal × u, so the sketch was mirrored onto the step's frame and each point stays where this frame put it.")
  const step = asked.at(-1)!
  near(step.frame.v, [0, 0, -1])
  // every porthole at height 11 on the side, as the frame given puts [x, 11]
  expect(step.shape.loops!.map((l) => at(step.frame, l.center))).toEqual(PORTS.map((p) => [p.center[0], 12, 11]))
})

it('keeps a v given square to u and the normal the way round it is, with no note', async () => {
  const { asked, engine } = recording()
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull' })).output.design
  const frame = { ...SIDE, v: [0, 0, -1] }
  const out = await h.call('slicerx_geom_extrude', { design, shape: { type: 'sketch', loops: PORTS.slice(0, 1) }, frame, distance_mm: 1.5 })
  expect(out.isError, text(out)).toBeFalsy()
  expect(text(out)).not.toContain('runs opposite')
  expect(asked.at(-1)!.shape.loops![0]!.center).toEqual([92, 11])
  near(asked.at(-1)!.frame.v, [0, 0, -1])
})

it('mirrors a shape on a mirrored frame by its placement, and a polygon a half turn more', async () => {
  const { asked, engine } = recording()
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull' })).output.design
  expect((await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 4, heightMm: 2 }, placement: { center: [20, 8], rotationDeg: 30 }, frame: SIDE, distance_mm: 1 })).isError).toBeFalsy()
  expect(asked.at(-1)!.placement).toEqual({ center: [20, -8], rotationDeg: -30 })
  expect((await h.call('slicerx_geom_extrude', { design, shape: { type: 'polygon', sides: 3, diameterMm: 4 }, frame: SIDE, distance_mm: 1 })).isError).toBeFalsy()
  expect(asked.at(-1)!.placement).toEqual({ rotationDeg: 180 })
})

it('scales a v of any length to 1 and refuses one off square, through the tool', async () => {
  // and through the tool: the rehearsal's cut with v 2 long lands where v 1 long does
  const { asked, engine } = recording()
  const h = await connect({ geomEngine: engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull' })).output.design
  expect((await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5 })).isError).toBeFalsy()
  const out = await h.call('slicerx_geom_extrude', { design, shape: { type: 'sketch', loops: PORTS }, frame: { ...SIDE, v: [0, 0, 2] }, distance_mm: 1.5, extent: 'oneSide', operation: 'cut', part: 0 })
  expect(out.isError, text(out)).toBeFalsy()
  expect(text(out)).toContain("The frame's v [0, 0, 2] runs opposite normal × u")
  const step = asked.at(-1)!
  expect(step.shape.loops!.map((l) => at(step.frame, l.center))).toEqual(PORTS.map((p) => [p.center[0], 12, 11]))
  // a frame off square is refused through the tool too, and nothing is added
  const bad = await h.call('slicerx_geom_extrude', { design, shape: { type: 'sketch', loops: PORTS }, frame: { ...SIDE, v: [0, 0.1, 1] }, distance_mm: 1.5, operation: 'cut', part: 0 })
  expect(bad.isError).toBe(true)
  expect(text(bad)).toContain('frame: with v given, u, v and normal must be at right angles to each other, within 0.0001; here v and normal meet at 84.289 degrees. Fix them, or leave v out and v is normal × u.')
})

it('refuses text, artwork and a trace on a mirrored frame, which would read backwards', async () => {
  const h = await connect({ geomEngine: recording().engine })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull' })).output.design
  const said = (what: string) => `frame: v [0, 0, 1] runs against normal × u ([0, 0, -1] here), so this plane is seen from behind and ${what} would read backwards. Keep v and give u as v × normal ([-1, 0, 0]), or leave v out.`
  const words = await h.call('slicerx_geom_extrude', { design, shape: { type: 'text', text: 'TITANIC', sizeMm: 4 }, frame: SIDE, distance_mm: 0.6 })
  expect(words.isError).toBe(true)
  expect(text(words)).toContain(said('the text'))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const art = await h.call('slicerx_geom_extrude', { design, shape: { type: 'svg', svg, widthMm: 10 }, frame: SIDE, distance_mm: 0.6 })
  expect(text(art)).toContain(said('the artwork'))
  const sketched = await h.call('slicerx_design_sketch_svg', { svg, frame: SIDE })
  expect(text(sketched)).toContain(said('the artwork'))
  const traced = await h.call('slicerx_design_trace_image', { image: { base64: 'iVBORw0KGgo=' }, frame: SIDE })
  expect(text(traced)).toContain(said('the trace'))
  // an angle that follows a value cannot turn round with the mirrored sketch
  const lines = [{ start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'line', to: [10, 5] }, { type: 'line', to: [0, 0] }] }]
  const angled = await h.call('slicerx_design_sketch', { loops: lines, frame: SIDE, constraints: [{ type: 'horizontal', a: { e: 0, seg: 0 } }, { type: 'length', line: { e: 0, seg: 0 }, value: 10 }, { type: 'angle', a: { e: 0, seg: 0 }, b: { e: 0, seg: 1 }, value: 90, expr: 'corner' }] })
  expect(text(angled)).toContain("constraints.2.expr: the frame's v runs against normal × u, so the sketch is mirrored onto v = normal × u and its angles turn the other way, which an angle that follows a value cannot do. Give the angle as a number, or v as normal × u.")
})

it('mirrors a loft profile and a rail path on a mirrored frame', async () => {
  const lofted: { profiles: { loops: { center: number[] }[]; landmarks?: number[][] }[] }[] = []
  const railed: { frame: Frame; shape: { loops: { center: [number, number] }[] } }[] = []
  const h = await connect({ geomEngine: async (op, params) => {
    if (op === 'sketch.loft') lofted.push(params as (typeof lofted)[number])
    if (op === 'shape.extrude') railed.push(params as (typeof railed)[number])
    return { mesh: box, report: { touches: true } }
  } })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull' })).output.design
  const lofts = await h.call('slicerx_geom_loft', { design, profiles: [{ frame: SIDE, loops: [{ type: 'circle', center: [5, 3], diameterMm: 2 }] }, { frame: { ...SIDE, origin: [0, 20, 0] }, loops: [{ type: 'circle', center: [5, 3], diameterMm: 2 }] }] })
  expect(lofts.isError, text(lofts)).toBeFalsy()
  expect(text(lofts)).toContain("The frame's v [0, 0, 1] runs opposite normal × u")
  expect(lofted.at(-1)!.profiles.map((p) => p.loops[0]!.center)).toEqual([[5, -3], [5, -3]])
  const rail = await h.call('slicerx_geom_rail', { design, path: { frame: SIDE, points: [[0, 5], [10, 5]] }, height_mm: 6 })
  expect(rail.isError, text(rail)).toBeFalsy()
  expect(text(rail)).toContain("The frame's v [0, 0, 1] runs opposite normal × u")
  // every post at height 5 on the side, as the frame given puts the path
  const posts = railed.find((r) => r.shape.loops.length > 1)!
  for (const l of posts.shape.loops) expect(at(posts.frame, l.center)[2]).toBeCloseTo(5, 9)
})

it('mirrors a revolve axis with its loops on a mirrored frame', async () => {
  const asked: { loops: { center: number[] }[]; axis: { point: number[]; direction: number[] } }[] = []
  const h = await connect({ geomEngine: async (op, params) => { if (op === 'sketch.revolve') asked.push(params as (typeof asked)[number]); return { mesh: box } } })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Knob' })).output.design
  const out = await h.call('slicerx_geom_revolve', { design, loops: [{ type: 'circle', center: [5, 3], diameterMm: 2 }], frame: SIDE, axis: { point: [0, 1], direction: [1, 1] } })
  expect(out.isError, text(out)).toBeFalsy()
  expect(asked.at(-1)).toMatchObject({ loops: [{ center: [5, -3] }], axis: { point: [0, -1], direction: [1, -1] } })
})

// the real engine, the rehearsal's own porthole cut: a 40 x 24 x 30 block from x 90 to 130, its +Y side at y 12, cut
// by seven 3.2 mm circles 1.5 mm deep at height 11 on a frame with v up; before, the circles went to height -11, under
// the block, and the cut was refused as stopping short of the part
const bin = process.env['SLICERX_SX_GEOM_BIN']
const noGeom = !built(bin, GEOM_BUILD)
const why = noKernel(bin)
const dug = 7 * Math.PI * 1.6 * 1.6 * 1.5

async function sideCut(exact: boolean) {
  if (exact) vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect(exact ? { geomEngine: geomEngine(bin!, 20000) } : { sxGeomBin: bin! })
  const made = await h.call('slicerx_design_new', { name: 'Block', ...(exact ? { exact: true } : {}) })
  expect(made.isError, text(made)).toBeFalsy()
  const design = data<{ output: { design: string } }>(made).output.design
  const block = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 24 }, placement: { center: [110, 0] }, distance_mm: 30 })
  expect(block.isError, text(block)).toBeFalsy()
  const before = data<{ output: { volumeMm3: number; exact: boolean } }>(block).output
  expect(before.exact).toBe(exact)
  const cut = await h.call('slicerx_geom_extrude', { design, shape: { type: 'sketch', loops: PORTS }, frame: SIDE, distance_mm: 1.5, extent: 'oneSide', operation: 'cut', part: 0, feature: 'Portholes' })
  expect(cut.isError, text(cut)).toBeFalsy()
  const after = data<{ output: { volumeMm3: number; exact: boolean; sizeMm: number[] } }>(cut).output
  expect(after.exact).toBe(exact)
  expect(after.sizeMm).toEqual([40, 24, 30])
  return before.volumeMm3 - after.volumeMm3
}

describe.skipIf(noGeom)(`a cut on a side frame given with v up${noGeom ? ` (skipped: ${GEOM_BUILD})` : ''}`, () => {
  // a circle's triangles are a polygon inside it, on either path, so a little less than seven true circles is cut
  it('cuts the seven circles at height 11 on the mesh path', async () => {
    const gone = await sideCut(false)
    expect(gone).toBeLessThan(dug)
    expect(gone).toBeGreaterThan(dug * 0.99)
  }, 60_000)
  it.skipIf(why !== null)(`cuts the seven circles at height 11 on the exact path${why ? ` (skipped: ${why})` : ''}`, async () => {
    const gone = await sideCut(true)
    expect(gone).toBeLessThan(dug)
    expect(gone).toBeGreaterThan(dug * 0.99)
  }, 60_000)
})
