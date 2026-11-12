// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client rounds whole loops and chains by one reference each, and a fillet that cannot do every edge does the rest
// and says which it left: a hairline piece of an outline no longer stops the round on the whole outline.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface EdgeRef {
  a: V3
  b: V3
  face: V3
}
interface SetRef {
  set: 'loop' | 'chain'
  at: V3
  normal: V3
}
interface Pick {
  edge: EdgeRef
  supported: boolean
  loopRef: SetRef
  chainRef: SetRef
  loopEdges: number
  chainEdges: number
  loopMaxRadiusMm: number
  loop?: { edge: EdgeRef; supported: boolean }[]
}
interface Skipped {
  index: number
  input: number
  code: string
  message: string
}
interface Summary {
  design: string
  volumeMm3: number
  parts: { triangles: number }[]
  skipped?: Skipped[]
}
interface Row {
  op: string
  state: string
  note?: string
  skipped?: { index: number; code: string }[]
}

const geom = useGeomEngine('design-edge-partial')

// A hook's outline whose round tip is two quarter rounds with a 0.02 mm line between them (a wall hook build drew it so).
const HOOK = {
  type: 'sketch',
  loops: [
    {
      start: [87.8, 100],
      segments: [
        { type: 'line', to: [172.2, 100] },
        { type: 'arc', to: [175, 102.8], through: [174.18, 100.82] },
        { type: 'line', to: [175, 103.2] },
        { type: 'arc', to: [172.2, 106], through: [174.18, 105.18] },
        { type: 'line', to: [127.228, 106] },
        { type: 'arc', to: [123.365, 111.035], through: [124.055, 107.565] },
        { type: 'line', to: [131.246, 140.447] },
        { type: 'arc', to: [136.902, 146.104], through: [133.316, 144.033] },
        { type: 'line', to: [145.605, 148.436] },
        { type: 'arc', to: [149.841, 155.772], through: [149.243, 151.227] },
        { type: 'line', to: [149.836, 155.791] },
        { type: 'arc', to: [142.5, 160.027], through: [147.045, 159.429] },
        { type: 'line', to: [133.797, 157.695] },
        { type: 'arc', to: [119.654, 143.553], through: [124.831, 152.519] },
        { type: 'line', to: [110.387, 108.965] },
        { type: 'arc', to: [106.523, 106], through: [108.958, 106.827] },
        { type: 'line', to: [87.8, 106] },
        { type: 'arc', to: [85, 103.2], through: [85.82, 105.18] },
        { type: 'line', to: [85, 102.8] },
        { type: 'arc', to: [87.8, 100], through: [85.82, 100.82] },
      ],
    },
  ],
}

async function start() {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const pick = async (design: string, at: V3, normal: V3, list = false): Promise<Pick> => {
    const r = await h.call('slicerx_geom_edge_pick', { design, face: { at, normal }, ...(list ? { list_edges: true } : {}) })
    expect(r.isError, text(r)).toBeFalsy()
    return data<{ output: Pick }>(r).output
  }
  const steps = async (design: string): Promise<Row[]> => data<{ output: { steps: Row[] } }>(await h.call('slicerx_design_steps', { design })).output.steps
  return { h, ok, pick, steps }
}

describe('a client rounds a whole loop by one reference', () => {
  it('takes loopRef as the loop it names, and finds it again after an earlier round moved its edges', async () => {
    const { h, ok, pick, steps } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Rounded box' })).design
    const box = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: 3 }, distance_mm: 6, name: 'Box' })
    const p = await pick(d, [0, -9.9, 6], [0, 0, 1], true)
    // the compact references come first, and name as many edges as the lists
    expect(Object.keys(p).slice(0, 2)).toEqual(['loopRef', 'chainRef'])
    expect(p.loopRef).toEqual({ set: 'loop', at: [0, -9.9, 6], normal: [0, 0, 1] })
    expect(p.loopEdges).toBe(p.loop!.filter((l) => l.supported).length)
    expect((await pick(d, [0, -9.9, 6], [0, 0, 1])).loop).toBeUndefined()

    // one reference rounds the same loop the per-edge list does
    const byList = await ok('slicerx_geom_fillet', { design: d, edges: p.loop!.map((l) => l.edge), radius_mm: 1 })
    expect(byList.skipped).toEqual([])
    await ok('slicerx_design_undo', { design: d })
    const byRef = await ok('slicerx_geom_fillet', { design: d, edges: [p.loopRef], radius_mm: 1 })
    expect(byRef.parts[0]!.triangles).toBe(byList.parts[0]!.triangles)
    expect(byRef.volumeMm3).toBeCloseTo(byList.volumeMm3, 6)
    await ok('slicerx_design_undo', { design: d })

    // round the picked side first: the loop's own edge list is stale, the reference is not
    await ok('slicerx_geom_fillet', { design: d, edges: [p.edge], radius_mm: 1 })
    const stale = p.loop!.map((l) => l.edge)
    const refused = await h.call('slicerx_geom_chamfer', { design: d, edges: stale, distance_mm: 0.3, all_or_nothing: true })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/no sharp edge between two flat faces there\. A loopRef or chainRef .* picked again .*design is unchanged/s)
    // left to go on, the stale edge is left as it was with its reason and the rest are beveled
    const partly = await ok('slicerx_geom_chamfer', { design: d, edges: stale, distance_mm: 0.3 })
    expect(partly.skipped!.map((s) => [s.index, s.code])).toEqual([[0, 'not_found']])
    expect(partly.skipped![0]!.message).toMatch(/no sharp edge.*loopRef or chainRef/)
    await ok('slicerx_design_undo', { design: d })
    const again = await ok('slicerx_geom_chamfer', { design: d, edges: [p.loopRef], distance_mm: 0.3 })
    expect(again.volumeMm3).toBeLessThan(box.volumeMm3)
    const rows = await steps(d)
    expect(rows.map((r) => [r.op, r.state])).toEqual([
      ['shape.extrude', 'done'],
      ['edge.fillet', 'done'],
      ['edge.chamfer', 'done'],
    ])
    await h.client.close()
  })
})

describe('a fillet that cannot do every edge does the rest', () => {
  it('rounds a hook outline whose tip has a 0.02 mm piece, leaving that piece alone, and keeps it so on replay', async () => {
    const { h, ok, pick, steps } = await start()
    const d = (await ok('slicerx_design_new', { name: 'Wall hook' })).design
    const body = await ok('slicerx_geom_extrude', { design: d, shape: HOOK, distance_mm: 18, name: 'Wall hook' })
    // the whole outline is one tangent chain, picked on the bed side
    const p = await pick(d, [149.259, 155.626, 0], [0, 0, -1])
    expect(p.chainEdges).toBeGreaterThan(150)

    // all or nothing: the hairline piece caps the whole outline, as before
    const capped = await h.call('slicerx_geom_fillet', { design: d, edges: [p.chainRef], radius_mm: 2, all_or_nothing: true })
    expect(capped.isError).toBe(true)
    expect(text(capped)).toMatch(/does not fit/)

    const round = await ok('slicerx_geom_fillet', { design: d, edges: [p.chainRef], radius_mm: 2 })
    expect(round.volumeMm3).toBeLessThan(body.volumeMm3)
    const left = round.skipped!
    // the hairline piece and the round its strip runs into are left; the other 184 edges of the outline are rounded
    expect(left.map((s) => [s.input, s.code])).toEqual([
      [0, 'overlap'],
      [0, 'does_not_fit'],
    ])
    expect(left[1]!.message).toMatch(/at most 0\.528 mm/)
    const rows = await steps(d)
    expect(rows[1]).toMatchObject({ op: 'edge.fillet', state: 'done', skipped: left.map((s) => ({ index: s.index, code: s.code })) })

    // the same steps replayed after a change that leaves the outline as it was leave out the same edges, with no note
    await ok('slicerx_design_edit_step', { design: d, step: 1, value: 16 })
    const after = await steps(d)
    expect(after[1]).toMatchObject({ state: 'done', skipped: left.map((s) => ({ index: s.index, code: s.code })) })
    expect(after[1]!.note ?? '').not.toMatch(/now leaves/)
    await h.client.close()
  })
})
