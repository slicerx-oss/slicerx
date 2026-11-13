// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A height band painted on an exact design, as a client paints one: the preview is the step's own replay, where the
// kernel splits the side the band's edge crosses, and names the faces it paints with their areas; applying it reads
// the same paint back, face by face, and so does slicerx_paint_regions. An engine that cannot split faces refuses the
// band on an exact design, as before.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache } from '@slicerx/cad-history'
import { bandEngine as engine, type Row } from './band-engine'
import { connect, data, text } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

async function shipDesign(e: ReturnType<typeof engine>) {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: e.call })
  const created = await h.call('slicerx_design_new', { name: 'Hull', exact: true })
  expect(created.isError, text(created)).toBeFalsy()
  const design = data<{ output: { design: string } }>(created).output.design
  const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 20 })
  expect(made.isError, text(made)).toBeFalsy()
  return { h, design }
}

describe('a height band on an exact design, over MCP', () => {
  it('previews the faces it paints, applies the same paint and reads it back face by face', async () => {
    const e = engine()
    const { h, design } = await shipDesign(e)
    const preview = await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: { kind: 'height', below: 4 } })
    expect(preview.isError, text(preview)).toBeFalsy()
    const pv = data<{ output: { preview: string; areaMm2: number; parts: (Row & { changedTriangles: number })[] } }>(preview).output
    // the bottom (30 x 10) and the side's piece below 4 mm (30 x 4)
    expect(pv.parts).toHaveLength(1)
    expect(pv.parts[0]!.changedTriangles).toBe(4)
    expect(pv.parts[0]!.faces!.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300], [2, 120]])
    expect(pv.areaMm2).toBe(420)
    expect(e.ops.filter((o) => o === 'brep.imprint')).toHaveLength(1)

    const applied = await h.call('slicerx_paint_apply', { preview: pv.preview })
    expect(applied.isError, text(applied)).toBeFalsy()
    const out = data<{ ok: boolean; output: { paint: Row[] } }>(applied)
    // what replay painted is what the preview showed
    expect(out.ok).toBe(true)
    const faces = out.output.paint[0]!.faces!
    expect(faces.map((f) => [f.state, f.areaMm2])).toEqual([[2, 300], [2, 120]])
    // named by their keys: the bottom's from the extrude, the side's piece from the paint step's split
    expect(new Set(faces.map((f) => f.key)).size).toBe(2)

    const read = data<{ output: { parts: Row[] } }>(await h.call('slicerx_paint_regions', { design, layer: 'color' })).output
    expect(read.parts[0]!.faces).toEqual(faces)
  })

  it('splits at both heights of a band between two, and paints only the strake between them', async () => {
    const { h, design } = await shipDesign(engine())
    const preview = await h.call('slicerx_paint_preview', { design, layer: 'color', state: 1, target: { kind: 'height', from: 8, to: 12 } })
    expect(preview.isError, text(preview)).toBeFalsy()
    const pv = data<{ output: { parts: Row[] } }>(preview).output
    expect(pv.parts[0]!.faces!.map((f) => [f.state, f.areaMm2])).toEqual([[1, 120]])
  })

  it('is refused on an exact design by an engine that cannot split faces, and the design is unchanged', async () => {
    const { h, design } = await shipDesign(engine({ imprint: false }))
    const preview = await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: { kind: 'height', below: 4 } })
    expect(preview.isError).toBe(true)
    expect(text(preview)).toContain('Exact replay does not support paint for this part')
    const listed = data<{ output: { designs: { steps: number }[] } }>(await h.call('slicerx_design_list')).output
    expect(listed.designs[0]!.steps).toBe(1)
  })
})
