// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client paints a design over MCP the way an agent would: a preview of a target, the person's yes, the paint
// applied as a history step, read back, undone and painted again. Runs where sx-geom has been built.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readZip } from '../src/zip'
import { built, connect, data, GEOM_BUILD, noSx, sxBin, sxTimeout } from './helpers'

const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release/sx-geom')

interface Preview {
  preview: string
  step: string
  areaMm2: number
  parts: { part: number; changedTriangles: number; regionCount: number }[]
  picture: { view: string; widthPx: number; paintedAreaMm2: Record<string, number> }
}
interface ReadBack {
  totalsMm2: Record<string, number>
  parts: { part: number; states: { state: number; areaMm2: number; regionCount: number }[] }[]
}

describe.skipIf(!built(geomBin, GEOM_BUILD))('painting a design', () => {
  it('previews, applies, reads back, undoes and paints again', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const names = (await h.client.listTools()).tools.map((t) => t.name)
    for (const n of ['slicerx_paint_preview', 'slicerx_paint_apply', 'slicerx_paint_regions']) expect(names).toContain(n)
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Cube', from: 'sample:cube-20' })).output.design

    // The bottom in filament 2: nothing changes yet.
    const p = await h.call('slicerx_paint_preview', { design: d, state: 2, target: { kind: 'direction', direction: 'bottom' } })
    expect(p.isError, JSON.stringify(p.content)).toBeFalsy()
    const pv = data<{ output: Preview }>(p).output
    expect(pv.step).toBe('Paint the bottom filament 2')
    expect(pv.areaMm2).toBeCloseTo(400, 1)
    expect(pv.picture.view).toBe('fit')
    expect(pv.picture.paintedAreaMm2['2']).toBeCloseTo(400, 1)
    expect(p.content.every((c) => c.type === 'text')).toBe(true)
    const before = data<{ output: ReadBack }>(await h.call('slicerx_paint_regions', { design: d })).output
    expect(before.parts).toEqual([])

    // With the picture, for the person to look at.
    const shown = await h.call('slicerx_paint_preview', { design: d, state: 2, target: { kind: 'direction', direction: 'bottom' }, image: true, size: 128 })
    expect(shown.content.some((c) => c.type === 'image')).toBe(true)

    // Applied: one step, and the paint read back is the preview's.
    const a = await h.call('slicerx_paint_apply', { preview: pv.preview })
    expect(a.isError, JSON.stringify(a.content)).toBeFalsy()
    const applied = data<{ ok: boolean; output: { step: { index: number; name: string }; paint: ReadBack['parts'] } }>(a)
    expect(applied.ok).toBe(true)
    expect(applied.output.step).toMatchObject({ index: 1, name: 'Paint the bottom filament 2' })
    const back = data<{ output: ReadBack }>(await h.call('slicerx_paint_regions', { design: d })).output
    expect(back.totalsMm2['2']).toBeCloseTo(400, 1)
    expect(back.parts[0]?.states[0]?.regionCount).toBe(1)
    // The other preview was made before the step: refused.
    const stale = data<{ output: Preview }>(shown).output.preview
    expect((await h.call('slicerx_paint_apply', { preview: stale })).isError).toBe(true)

    // Undone, then the top painted by a point on it, in filament 3.
    expect((await h.call('slicerx_design_undo', { design: d })).isError).toBeFalsy()
    expect(data<{ output: ReadBack }>(await h.call('slicerx_paint_regions', { design: d })).output.parts).toEqual([])
    const top = data<{ output: Preview }>(await h.call('slicerx_paint_preview', { design: d, state: 3, target: { kind: 'seed', point: [10, 10, 20] } })).output
    expect(top.areaMm2).toBeCloseTo(400, 1)
    expect((await h.call('slicerx_paint_apply', { preview: top.preview })).isError).toBeFalsy()
    const steps = data<{ output: { steps: { name: string; state: string }[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps).toMatchObject([{ name: 'Paint from a point filament 3', state: 'done' }])
  })

  it('paints filament 32, reads it back, and saves it for readers of either paint scheme', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Cube', from: 'sample:cube-20' })).output.design
    const p = await h.call('slicerx_paint_preview', { design: d, state: 32, target: { kind: 'direction', direction: 'top' } })
    expect(p.isError, JSON.stringify(p.content)).toBeFalsy()
    const pv = data<{ output: Preview }>(p).output
    expect(pv.picture.paintedAreaMm2['32']).toBeCloseTo(400, 1)
    expect((await h.call('slicerx_paint_apply', { preview: pv.preview })).isError).toBeFalsy()
    const back = data<{ output: ReadBack }>(await h.call('slicerx_paint_regions', { design: d })).output
    expect(back.totalsMm2).toEqual({ 32: 400 })
    expect(back.parts[0]?.states.map((s) => s.state)).toEqual([32])

    // Saved: paint_color in its own scheme, and the facets JSON in the other, version 2.
    const path = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d, file_name: 'filament-32' })).output.path
    const zip = readZip(readFileSync(path))
    const model = zip.text('3D/3dmodel.model') ?? ''
    const texts = [...model.matchAll(/paint_color="([0-9A-F]+)"/g)].map((m) => m[1])
    expect(texts.length).toBeGreaterThan(0)
    expect(new Set(texts)).toEqual(new Set(['EFC']))
    const facets = JSON.parse(zip.text('Metadata/Slic3r_facets_annotation.json') ?? '[]') as { mmSegmentationFacets: { dividing: string }[]; mmSegmentationFacetsVersion: number }[]
    expect(facets).toHaveLength(1)
    expect(facets[0]!.mmSegmentationFacetsVersion).toBe(2)
    expect(new Set(facets[0]!.mmSegmentationFacets.map((f) => f.dividing))).toEqual(new Set(['0FEC']))

    // Opened again, the paint is on filament 32.
    const again = data<{ output: { designs: { design: string }[] } }>(await h.call('slicerx_design_open', { path })).output.designs[0]!.design
    expect(data<{ output: ReadBack }>(await h.call('slicerx_paint_regions', { design: again })).output.totalsMm2).toEqual({ 32: 400 })
  })

  it('refuses a target that paints nothing, and bad targets in words', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Cube', from: 'sample:cube-20' })).output.design
    const nothing = await h.call('slicerx_paint_preview', { design: d, state: 2, target: { kind: 'height', below: -5 } })
    expect(nothing.isError).toBe(true)
    expect(JSON.stringify(nothing.content)).toMatch(/paints nothing/)
    const both = await h.call('slicerx_paint_preview', { design: d, state: 2, target: { kind: 'height', below: 5, above: 2 } })
    expect(both.isError).toBe(true)
    expect(JSON.stringify(both.content)).toMatch(/below, above, or from and to/)
  })

  it.skipIf(noSx())('saves the paint in the 3MF, and a slice of it uses the painted filament', { timeout: sxTimeout }, async () => {
    const h = await connect({ sxGeomBin: geomBin, engine: 'sx', sxBin })
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Cube', from: 'sample:cube-20' })).output.design
    const slice = async (path: string) => {
      const r = await h.call('slicerx_slice_file', { model: path, profiles: ['filament:pla'], filaments: [{ slot: 2, profile: 'filament:pla', color: '#00AE42' }], overrides: { layer_height: 0.2, smart_layer: 'off' } })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
      return data<{ filaments: { slot: number; filament_g: number }[] }>(r).filaments.find((f) => f.slot === 2)?.filament_g ?? 0
    }
    const plain = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d, file_name: 'plain' })).output.path
    expect(await slice(plain)).toBe(0)
    // The bottom and one side in filament 2.
    const pv = data<{ output: Preview }>(await h.call('slicerx_paint_preview', { design: d, state: 2, target: { kind: 'height', below: 4 } })).output
    expect((await h.call('slicerx_paint_apply', { preview: pv.preview })).isError).toBeFalsy()
    const saved = data<{ output: { path: string } }>(await h.call('slicerx_design_save', { design: d, file_name: 'painted' })).output.path
    expect(await slice(saved)).toBeGreaterThan(0)
  })
})
