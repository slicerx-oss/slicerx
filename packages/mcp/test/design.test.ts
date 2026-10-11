// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client models a clip for a 6 mm cable over MCP, the way an agent would: base, ring, snap opening, screw holes
// and a rounded end, each one a step in the design's history. The design is checked by its size and volume, saved
// as a 3MF, opened again with the same steps, and edited.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readZip } from '../src/zip'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  steps: number
  sizeMm: V3
  minMm: V3
  volumeMm3: number
  parts: { name: string; slot: number; volumeMm3: number }[]
  stlPath?: string
  lastStep?: { name: string; state: string }
}
interface Row {
  index: number
  name: string
  op: string
  state: string
  message?: string
}

const geom = useGeomEngine('design-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

// The clip's profile on the XZ plane: u along X, v along Z, extruded to both sides of Y = 0.
const XZ = { origin: [0, 0, 0], normal: [0, -1, 0] }
const RING_Z = 6.7
const BORE_MM = 6.2
const WALL_MM = 1.6
const OPENING_MM = 5

async function buildClip() {
  const h = await connect({ geomEngine: engine })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const d = (await ok('slicerx_design_new', { name: 'Cable clip' })).design
  const base = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 24, heightMm: 10 }, distance_mm: 3, name: 'Clip' })
  const ring = await ok('slicerx_geom_extrude', {
    design: d,
    frame: XZ,
    shape: { type: 'sketch', loops: [{ type: 'circle', center: [0, RING_Z], diameterMm: BORE_MM + 2 * WALL_MM }, { type: 'circle', center: [0, RING_Z], diameterMm: BORE_MM }] },
    distance_mm: 5,
    extent: 'symmetric',
    operation: 'join',
  })
  const opening = await ok('slicerx_geom_extrude', { design: d, frame: XZ, shape: { type: 'rectangle', widthMm: OPENING_MM, heightMm: 6 }, placement: { center: [0, RING_Z + 3] }, distance_mm: 8, extent: 'symmetric', operation: 'cut' })
  const holes = await ok('slicerx_geom_subtract', {
    design: d,
    solids: [-8.5, 8.5].map((x) => ({ type: 'cylinder', origin: [x, 0, -1], axis: [0, 0, 1], diameterMm: 3.2, heightMm: 8 })),
    label: 'Screw holes M3',
  })
  const e = await h.call('slicerx_geom_edge_pick', { design: d, face: { at: [11.9, 0, 3], normal: [0, 0, 1] } })
  expect(e.isError, text(e)).toBeFalsy()
  const edge = data<{ output: { edge: unknown; supported: boolean; lengthMm: number } }>(e).output
  const rounded = await ok('slicerx_geom_fillet', { design: d, edges: [edge.edge], radius_mm: 1 })
  return { h, d, ok, base, ring, opening, holes, edge, rounded }
}

describe('a client models a cable clip as a design', () => {
  it('builds it step by step, checks it, saves it, opens it again and edits a step', async () => {
    const { h, d, ok, base, ring, opening, holes, edge, rounded } = await buildClip()

    // The base: 24 x 10 x 3 mm on the bed.
    expect(base.sizeMm).toEqual([24, 10, 3])
    expect(base.volumeMm3).toBeCloseTo(720, 2)
    // The ring stands on it: its top is the ring center plus the outer radius.
    expect(ring.sizeMm[2]).toBeCloseTo(RING_Z + BORE_MM / 2 + WALL_MM, 1)
    expect(ring.sizeMm[1]).toBeCloseTo(10, 3)
    // The snap opening takes the top of the ring: what is left ends where the outer circle meets the opening's sides.
    expect(opening.sizeMm[2]).toBeCloseTo(RING_Z + Math.sqrt((BORE_MM / 2 + WALL_MM) ** 2 - (OPENING_MM / 2) ** 2), 1)
    expect(opening.volumeMm3).toBeLessThan(ring.volumeMm3)
    // Two 3.2 mm holes through the 3 mm base.
    expect(opening.volumeMm3 - holes.volumeMm3).toBeGreaterThan(2 * Math.PI * 1.6 ** 2 * 3 * 0.97)
    expect(opening.volumeMm3 - holes.volumeMm3).toBeLessThan(2 * Math.PI * 1.6 ** 2 * 3 * 1.01)
    // A 1 mm round on the 10 mm end edge takes (1 - pi / 4) mm2 along it.
    expect(edge.supported).toBe(true)
    expect(edge.lengthMm).toBeCloseTo(10, 3)
    expect(holes.volumeMm3 - rounded.volumeMm3).toBeCloseTo((1 - Math.PI / 4) * 10, 0)
    expect(rounded.parts).toHaveLength(1)
    expect(readFileSync(rounded.stlPath!).length).toBeGreaterThan(84)

    // Every step is in the history, in order, and went through.
    const listed = data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(listed.map((s) => s.op)).toEqual(['shape.extrude', 'shape.extrude', 'shape.extrude', 'subtract', 'edge.fillet'])
    expect(listed.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(listed[3]?.name).toBe('Screw holes M3')
    expect(listed[4]?.name).toBe('Fillet 1 mm')

    // A step that does not fit is refused and leaves the design as it was.
    const tooBig = await h.call('slicerx_geom_fillet', { design: d, edges: [edge.edge], radius_mm: 40 })
    expect(tooBig.isError).toBe(true)
    expect(text(tooBig)).toMatch(/design is unchanged/)
    expect(data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps).toHaveLength(5)

    // Saved as a 3MF with its history beside the parts.
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d })).output
    const zip = readZip(readFileSync(saved.path))
    expect(zip.names()).toEqual(expect.arrayContaining(['3D/3dmodel.model', 'Metadata/model_settings.config', 'Metadata/slicerx_history.json']))
    const file = JSON.parse(zip.text('Metadata/slicerx_history.json') ?? '{}') as { version: number; objects: { steps: unknown[] }[] }
    expect(file.version).toBe(2)
    expect(file.objects[0]?.steps).toHaveLength(5)

    // Opened again, it replays to the same part.
    const opened = data<{ output: { designs: Summary[] } }>(await h.call('slicerx_design_open', { path: saved.path })).output.designs
    expect(opened).toHaveLength(1)
    const again = opened[0]!
    expect(again.steps).toBe(5)
    expect(again.volumeMm3).toBeCloseTo(rounded.volumeMm3, 2)
    again.sizeMm.forEach((c, k) => expect(c).toBeCloseTo(rounded.sizeMm[k]!, 3))

    // A longer ring, 12 mm instead of 10: every later step replays on it.
    const edited = await h.call('slicerx_design_edit_step', { design: again.design, step: 2, value: 6 })
    expect(edited.isError, text(edited)).toBeFalsy()
    const out = data<{ output: Omit<Summary, 'steps'> & { steps: Row[] } }>(edited).output
    expect(out.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(out.sizeMm[1]).toBeCloseTo(12, 3)
    expect(out.volumeMm3).toBeGreaterThan(rounded.volumeMm3)

    // Undo drops the round.
    const undone = await ok('slicerx_design_undo', { design: again.design })
    expect(undone.steps).toBe(4)
    expect(undone.lastStep?.name).toBe('Screw holes M3')
  })

  it('needs a model or a design, and says which', async () => {
    const h = await connect({ geomEngine: engine })
    const both = await h.call('slicerx_geom_push_pull', { face: { at: [0, 0, 0] }, distance_mm: 1 })
    expect(both.isError).toBe(true)
    expect(text(both)).toMatch(/give "model" \(an STL\) or "design"/)
    const missing = await h.call('slicerx_design_steps', { design: 'd404' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/slicerx_design_list/)
  })
})
