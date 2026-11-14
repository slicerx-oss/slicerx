// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A refused paint preview gets no id, so applying the id a client expected finds nothing. When the last paint preview
// was refused, the apply's refusal names that preview, says why it was refused and what to do next. A preview or an
// apply that goes through clears it, so a stale id after one reads as before.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache, stepName, type StepParams } from '@slicerx/cad-history'
import { bandEngine as engine } from './band-engine'
import { connect, data, text } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  clearReplayCache()
})

type Errored = { error: { code: string; message: string } }

async function exactDesign(e: Pick<ReturnType<typeof engine>, 'call'>) {
  vi.stubEnv('SX_BREP_DEV', '1')
  const h = await connect({ geomEngine: e.call })
  const design = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Hull', exact: true })).output.design
  const made = await h.call('slicerx_geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 20 })
  expect(made.isError, text(made)).toBeFalsy()
  return { h, design }
}

const band: Extract<StepParams, { op: 'paint' }> = { op: 'paint', layer: 'color', state: 2, target: { kind: 'height', below: 4 } }

describe('paint.apply after a refused paint.preview, over MCP', () => {
  it('names the refused preview, its reason without the replay wrapper, and what to try next', async () => {
    const { h, design } = await exactDesign(engine({ imprint: false }))
    const preview = await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: band.target })
    expect(preview.isError).toBe(true)
    expect(text(preview)).toContain('Exact replay does not support paint for this part')

    const applied = await h.call('slicerx_paint_apply', { preview: 'p1' })
    expect(applied.isError).toBe(true)
    const err = data<Errored>(applied).error
    expect(err.code).toBe('invalid_input')
    expect(err.message).toBe(`preview: p1 was never made. The last paint preview, ${stepName({ params: band })}, was refused: Exact replay does not support paint for this part. Preview again on a part that supports paint, or with a different target, then apply.`)

    // read back: nothing was added or painted
    const steps = data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design })).output.steps
    expect(steps).toHaveLength(1)
    const read = data<{ output: { totalsMm2: Record<string, number> } }>(await h.call('slicerx_paint_regions', { design, layer: 'color' })).output
    expect(read.totalsMm2).toEqual({})
  })

  it('says it as before once a later preview goes through, for a stale id', async () => {
    const { h, design } = await exactDesign(engine({ imprint: false }))
    expect((await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: band.target })).isError).toBe(true)
    const ok = await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: { kind: 'part' } })
    expect(ok.isError, text(ok)).toBeFalsy()
    expect(data<{ output: { preview: string } }>(ok).output.preview).toBe('p1')

    const stale = await h.call('slicerx_paint_apply', { preview: 'p7' })
    expect(stale.isError).toBe(true)
    expect(data<Errored>(stale).error.message).toBe('preview: no preview p7; make one with slicerx_paint_preview')
  })

  it('says it as before once an apply goes through after the refusal', async () => {
    const { h, design } = await exactDesign(engine({ imprint: false }))
    const pv = data<{ output: { preview: string } }>(await h.call('slicerx_paint_preview', { design, layer: 'color', state: 2, target: { kind: 'part' } })).output.preview
    expect((await h.call('slicerx_paint_preview', { design, layer: 'color', state: 1, target: band.target })).isError).toBe(true)
    const applied = await h.call('slicerx_paint_apply', { preview: pv })
    expect(applied.isError, text(applied)).toBeFalsy()
    // read back: the part's paint is the applied preview's
    const read = data<{ output: { totalsMm2: Record<string, number> } }>(await h.call('slicerx_paint_regions', { design, layer: 'color' })).output
    expect(Object.keys(read.totalsMm2)).toEqual(['2'])

    const again = await h.call('slicerx_paint_apply', { preview: pv })
    expect(data<Errored>(again).error.message).toBe(`preview: no preview ${pv}; make one with slicerx_paint_preview`)
  })

  it('names a preview that paints nothing new, with its own next step', async () => {
    // an engine whose selection paints no triangle
    const e = engine()
    const call = async (op: string, request: unknown) => (op === 'paint.select' ? { changed: {}, changedTriangles: 0, selectedAreaMm2: 0, regionCount: 0, regions: [] } : e.call(op, request))
    const { h, design } = await exactDesign({ call })
    const nothing: Extract<StepParams, { op: 'paint' }> = { op: 'paint', layer: 'seam', state: 1, target: { kind: 'part' } }
    const refused = await h.call('slicerx_paint_preview', { design, layer: 'seam', state: 1, target: nothing.target })
    expect(text(refused)).toContain('The target paints nothing new on this design')

    const applied = await h.call('slicerx_paint_apply', { preview: 'p1' })
    expect(data<Errored>(applied).error.message).toBe(`preview: p1 was never made. The last paint preview, ${stepName({ params: nothing })}, was refused: The target paints nothing new on this design; try another target, part or state. Preview again with another target, part or state, then apply.`)
  })
})
