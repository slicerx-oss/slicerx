// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client models a clip for a 6 mm cable over MCP, the way an agent would: base, ring, snap opening, screw holes
// and a rounded end, each one a step in the design's history. The design is checked by its size and volume, saved
// as a 3MF, opened again with the same steps, and edited.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readZip, writeZip } from '../src/zip'
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
  const rounded = await ok('slicerx_geom_fillet', { design: d, edges: [edge.edge], radius_mm: 1, tolerance_mm: 0.1 })
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
    // A 1 mm round on the 10 mm end edge takes about (1 - pi / 4) mm2 along it, a bit more at 0.1 mm chord
    // tolerance; a 1 mm bevel would take 5 mm3.
    expect(edge.supported).toBe(true)
    expect(edge.lengthMm).toBeCloseTo(10, 3)
    expect(holes.volumeMm3 - rounded.volumeMm3).toBeGreaterThan((1 - Math.PI / 4) * 10)
    expect(holes.volumeMm3 - rounded.volumeMm3).toBeLessThan(4)
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

    // A longer ring, 12 mm instead of 10: the round on the end no longer fits, and the step says by how much.
    const longer = await h.call('slicerx_design_edit_step', { design: again.design, step: 2, value: 6 })
    const broke = data<{ ok: boolean; output: Omit<Summary, 'steps'> & { steps: Row[] } }>(longer)
    expect(broke.ok).toBe(false)
    expect(broke.output.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'broken'])
    expect(broke.output.steps[4]?.message).toMatch(/at most/)
    expect(broke.output.sizeMm[1]).toBeCloseTo(12, 3)

    // Back to 10 mm, everything goes through again; then a smaller round.
    const back = data<{ output: Omit<Summary, 'steps'> & { steps: Row[] } }>(await h.call('slicerx_design_edit_step', { design: again.design, step: 2, value: 5 })).output
    expect(back.steps.every((s) => s.state === 'done')).toBe(true)
    expect(back.volumeMm3).toBeCloseTo(rounded.volumeMm3, 2)
    const smaller = await h.call('slicerx_design_edit_step', { design: again.design, step: 5, value: 0.5 })
    expect(smaller.isError, text(smaller)).toBeFalsy()
    const out = data<{ output: Omit<Summary, 'steps'> & { steps: Row[] } }>(smaller).output
    expect(out.steps[4]).toMatchObject({ name: 'Fillet 0.5 mm', state: 'done' })
    expect(out.volumeMm3).toBeGreaterThan(rounded.volumeMm3)

    // Undo drops the round, redo puts it back.
    const undone = await ok('slicerx_design_undo', { design: again.design })
    expect(undone.steps).toBe(4)
    expect(undone.lastStep?.name).toBe('Screw holes M3')
    const redone = await ok('slicerx_design_redo', { design: again.design })
    expect(redone.steps).toBe(5)
    expect(redone.volumeMm3).toBeCloseTo(out.volumeMm3, 2)
    await ok('slicerx_design_undo', { design: again.design })
    await ok('slicerx_design_undo', { design: again.design })
    const fresh = await h.call('slicerx_geom_extrude', { design: again.design, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: 2, heightMm: 2 }, placement: { center: [-11, 0] }, distance_mm: 0.6, operation: 'join' })
    expect(fresh.isError, text(fresh)).toBeFalsy()
    const none = await h.call('slicerx_design_redo', { design: again.design })
    expect(none.isError).toBe(true)
    expect(text(none)).toMatch(/Nothing to redo/)
  }, 60_000)

  it('opens a plain 3MF: printed parts with their slots and paint, modifiers left out', async () => {
    const h = await connect({ geomEngine: engine })
    const v = (x: number, y: number, z: number): string => `<vertex x="${x}" y="${y}" z="${z}"/>`
    const cube = (s: number, painted: boolean): string => {
      const c = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(i & 1 ? s : 0, i & 2 ? s : 0, i & 4 ? s : 0)).join('')
      const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
      return `<mesh><vertices>${c}</vertices><triangles>${t.map(([a, b, d], k) => `<triangle v1="${a}" v2="${b}" v3="${d}"${painted && k === 2 ? ' paint_color="8"' : ''}/>`).join('')}</triangles></mesh>`
    }
    const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="1" type="model">${cube(20, true)}</object><object id="2" type="model">${cube(5, false)}</object><object id="3" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 -10 -10 0"/><component objectid="2"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`
    const settings = `<?xml version="1.0"?><config><object id="3"><metadata key="name" value="Charizard ball"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="Shell"/><metadata key="extruder" value="2"/></part><part id="2" subtype="modifier_part"><metadata key="name" value="Infill box"/></part></object></config>`
    const file = join(h.dir, 'plain.3mf')
    writeFileSync(file, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: settings }]))
    const r = await h.call('slicerx_design_open', { path: file })
    expect(r.isError, text(r)).toBeFalsy()
    const d = data<{ output: { designs: (Summary & { fromHistory: boolean; leftOut?: string[] })[] } }>(r).output.designs
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ name: 'Charizard ball', steps: 0, fromHistory: false, leftOut: ['Infill box (modifier part)'] })
    expect(d[0]?.parts.map((p) => [p.name, p.slot])).toEqual([['Shell', 2]])
    expect((d[0]?.parts[0] as { paintedTriangles?: unknown }).paintedTriangles).toEqual({ color: 1 })
    expect(d[0]?.sizeMm).toEqual([20, 20, 20])
    expect(d[0]?.minMm).toEqual([90, 90, 0])
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
