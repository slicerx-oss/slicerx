// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client changes the height of a design's first body after rounding its edges, the way an agent would: the fillet
// steps follow the top up and down and go through again, on a plain box, a rounded box's top loop and a hole's rim.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Summary {
  design: string
  sizeMm: V3
  volumeMm3: number
}
interface Row {
  state: string
  message?: string
}

const geom = useGeomEngine('design-edit-follows')

async function start(corner: number) {
  const h = await connect({ geomEngine: (op, request) => geom.engine(op, request) })
  const ok = async (name: string, args: Record<string, unknown>): Promise<Summary> => {
    const r = await h.call(name, args)
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
    return data<{ output: Summary }>(r).output
  }
  const d = (await ok('slicerx_design_new', { name: 'Box' })).design
  const box = await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20, cornerRadiusMm: corner }, distance_mm: 6, name: 'Box' })
  const pick = async (at: V3) => {
    const r = await h.call('slicerx_geom_edge_pick', { design: d, face: { at, normal: [0, 0, 1] }, list_edges: true })
    expect(r.isError, text(r)).toBeFalsy()
    return data<{ output: { edge: unknown; supported: boolean; loop: { edge: unknown; supported: boolean }[] } }>(r).output
  }
  // the first body's height, and every step after it that went through or broke
  const height = async (mm: number) => {
    const r = await h.call('slicerx_design_edit_step', { design: d, step: 1, value: mm })
    const out = data<{ ok: boolean; output: Summary & { steps: Row[] } }>(r)
    expect(out.ok, text(r)).toBe(true)
    return out.output
  }
  return { ok, d, box, pick, height }
}

describe('a client changes the height of a body it rounded', () => {
  for (const [what, corner] of [
    ['a plain box', 0],
    ['a rounded box', 3],
  ] as const) {
    it(`${what}: one edge and the whole top loop follow the top up and down`, async () => {
      const { ok, d, box, pick, height } = await start(corner)
      const p = await pick([0, -9.9, 6])
      expect(p.loop.every((l) => l.supported)).toBe(true)
      for (const edges of [[p.edge], p.loop.map((l) => l.edge)]) {
        const rounded = await ok('slicerx_geom_fillet', { design: d, edges, radius_mm: 1 })
        for (const mm of [8, 4, 6]) {
          const out = await height(mm)
          expect(out.steps.map((s) => s.state)).toEqual(['done', 'done'])
          expect(out.sizeMm[2]).toBeCloseTo(mm, 3)
          // the round is the same at every height, so only the body's own volume changes
          expect(out.volumeMm3 - rounded.volumeMm3).toBeCloseTo((box.volumeMm3 / 6) * (mm - 6), 0)
        }
        await ok('slicerx_design_undo', { design: d })
      }
    })
  }

  it("a hole's rim: the hole and its round follow the top up and down", async () => {
    const { ok, d, box, pick, height } = await start(0)
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: { origin: [0, 0, 6], normal: [0, 0, 1] }, distance_mm: 3, operation: 'cut' })
    const rim = await pick([3.2, 0, 6])
    expect(rim.supported).toBe(true)
    const rounded = await ok('slicerx_geom_fillet', { design: d, edges: [rim.edge], radius_mm: 0.5 })
    for (const mm of [8, 4, 6]) {
      const out = await height(mm)
      expect(out.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
      expect(out.sizeMm[2]).toBeCloseTo(mm, 3)
      // the hole stays 3 mm deep from the top, so again only the body's own volume changes
      expect(out.volumeMm3 - rounded.volumeMm3).toBeCloseTo((box.volumeMm3 / 6) * (mm - 6), 0)
    }
  })
})
