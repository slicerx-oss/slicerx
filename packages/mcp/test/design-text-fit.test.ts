// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client embosses text on a 20 mm face of a design and reads back whether it fits, as Text on a face says it in the
// app: the text's size and the face's along the text, and the largest letter height that fits.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

const geom = useGeomEngine('design-text-fit-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)

interface Fit {
  textMm: [number, number]
  faceMm: [number, number]
  wide: boolean
  tall: boolean
  fits: boolean
  sizeMm: number
  fitSizeMm: number
  message: string | null
}

describe('emboss on a design reads back the text fit', () => {
  it('says text wider than the face is too wide, and the suggested size fits', async () => {
    const h = await connect({ geomEngine: engine })
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ summary: string; output: { design: string; textFit?: Fit } }>(r)
    }
    const block = async () => {
      const d = (await call('slicerx_design_new', { name: 'Block' })).output.design
      await call('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [10, 10] }, distance_mm: 10 })
      return d
    }
    // A join that runs off the face is refused, and the refusal says by how much and the size that fits.
    const over = await h.call('slicerx_geom_emboss', { design: await block(), text: 'SlicerX', point: [10, 10, 10], normal: [0, 0, 1], size_mm: 8, depth_mm: 0.6 })
    expect(over.isError).toBe(true)
    const m = /The text is ([\d.]+) mm wide; the face is 20 mm\. A letter height of ([\d.]+) mm fits\./.exec(text(over))
    expect(m, text(over)).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(30)
    const suggested = Number(m![2])
    expect(suggested).toBeGreaterThan(3)
    expect(suggested).toBeLessThan(5)

    // At that size it joins, and the reply reads back the fit.
    const fitted = await call('slicerx_geom_emboss', { design: await block(), text: 'SlicerX', point: [10, 10, 10], normal: [0, 0, 1], size_mm: suggested, depth_mm: 0.6 })
    const fit = fitted.output.textFit!
    expect(fit.fits).toBe(true)
    expect(fit.wide || fit.tall).toBe(false)
    expect(fit.sizeMm).toBe(suggested)
    expect(fit.fitSizeMm).toBe(suggested)
    expect(fit.faceMm[0]).toBeCloseTo(20, 3)
    expect(fit.faceMm[1]).toBeCloseTo(20, 3)
    expect(fit.textMm[0]).toBeLessThanOrEqual(20)
    expect(fit.textMm[0]).toBeGreaterThan(19)
    expect(fit.message).toBeNull()
    // a tenth more runs over again: the suggestion is the largest size that fits
    const more = await h.call('slicerx_geom_emboss', { design: await block(), text: 'SlicerX', point: [10, 10, 10], normal: [0, 0, 1], size_mm: Math.round((suggested + 0.1) * 10) / 10, depth_mm: 0.6 })
    expect(text(more)).toContain(`A letter height of ${suggested} mm fits.`)
  }, 60_000)
})
