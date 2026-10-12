// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveModel } from '../src/models'
import { connect, data } from './helpers'

describe('sample:x-mark', () => {
  it('is the showcase X, not the benchmark model', async () => {
    const file = await resolveModel({ samplesDir: resolve(__dirname, '../../core/bench/models'), outDir: '/tmp' } as never, 'sample:x-mark')
    expect(file.endsWith('x-mark-showcase.stl')).toBe(true)
  })

  it('resolves to the reference X and slices', async () => {
    const h = await connect()
    const r = await h.call('slicerx_slice_file', { model: 'sample:x-mark' })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
  })
})

describe('printer setup', () => {
  it('searches the printer catalog, and adding needs a running sx-link', async () => {
    const h = await connect()
    const hits = data<{ output: { id: string; vendor: string }[] }>(await h.call('slicerx_printer_profile_search', { query: 'bambu p1s' }))
    expect(hits.output.some((x) => x.id === 'bambu-p1s' && x.vendor === 'Bambu Lab')).toBe(true)
    const add = await h.call('slicerx_printer_add', { profileId: 'bambu-p1s', nozzleMm: 0.4 })
    expect(add.isError).toBe(true)
  })
})

// Runs where sx-geom has been built (cargo build -p sx-geom --release), or SLICERX_SX_GEOM_BIN names one.
const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? resolve(__dirname, '../../../target/release/sx-geom')
describe.skipIf(!existsSync(geomBin))('mesh tools with the real sx-geom', () => {
  it('lists the tools', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const names = (await h.client.listTools()).tools.map((t) => t.name)
    for (const n of ['cut', 'split', 'orient', 'repair', 'hollow', 'emboss', 'calibration_model', 'resume_plan', 'layers_plan', 'build', 'subtract', 'render', 'paint_regions', 'paint_image']) expect(names).toContain(`slicerx_geom_${n}`)
  })

  it('paints a textured 3MF from its texture, as a client would, and reads the paint back by filament', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    // A 20 mm cube whose bottom shows a yellow and blue checker; every other face reads a blue texel.
    const model = join(h.dir, 'textured-cube.3mf')
    copyFileSync(resolve(__dirname, '../../geom/tests/corpus/textured-cube.3mf'), model)
    const r = await h.call('slicerx_geom_paint_image', { model, colors: ['#ffdc00', '#0046c8'] })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const out = data<{ output: { paintedAreaMm2: Record<string, number>; unmatchedAreaMm2: number; splitTriangles: number; paint: Record<string, string> } }>(r).output
    expect(out.paintedAreaMm2['1']).toBeCloseTo(200, -1)
    expect(out.paintedAreaMm2['2']).toBeCloseTo(2200, -1)
    expect(out.unmatchedAreaMm2).toBe(0)
    expect(out.splitTriangles).toBe(2)
    expect(Object.keys(out.paint)).toHaveLength(12)
    // With no filament near the texture's colors nothing is painted, and the colors seen come back.
    const none = data<{ output: { paintedAreaMm2: Record<string, number>; unmatchedColors: { color: string }[] } }>(
      await h.call('slicerx_geom_paint_image', { model, colors: ['#ff0000'], maxDeltaE: 0.01 }),
    ).output
    expect(none.paintedAreaMm2).toEqual({})
    expect(none.unmatchedColors[0]?.color).toBe('#0848c8')
  })

  it('cuts a cube in two and writes both parts', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const r = await h.call('slicerx_geom_cut', { model: 'sample:cube-20', plane: { axis: 'z', at: 10 } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const out = data<{ output: { below: { stlPath: string }; above: { stlPath: string } } }>(r).output
    expect(existsSync(out.below.stlPath)).toBe(true)
    expect(existsSync(out.above.stlPath)).toBe(true)
  })

  it('ranks orientations and plans a resume as reads', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const o = await h.call('slicerx_geom_orient', { model: 'sample:x-mark', max_candidates: 3 })
    expect(o.isError, JSON.stringify(o.content)).toBeFalsy()
    const r = await h.call('slicerx_geom_resume_plan', { model: 'sample:tower-20x60', measured_height_mm: 30 })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    expect(data<{ output: { resumeLayer: number } }>(r).output.resumeLayer).toBeGreaterThan(100)
  })

  it('plans layers, builds a box, and drills it', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const l = await h.call('slicerx_geom_layers_plan', { model: 'sample:tower-20x60', mode: 'quality' })
    expect(l.isError, JSON.stringify(l.content)).toBeFalsy()
    const b = await h.call('slicerx_geom_build', { solids: [{ type: 'box', min: [0, 0, 0], max: [30, 20, 10] }] })
    expect(b.isError, JSON.stringify(b.content)).toBeFalsy()
    const built = data<{ output: { watertight: boolean; mesh: { stlPath: string } } }>(b).output
    expect(built.watertight).toBe(true)
    const s = await h.call('slicerx_geom_subtract', { model: built.mesh.stlPath, solids: [{ type: 'cylinder', origin: [15, 10, 0], axis: [0, 0, 1], diameterMm: 5, heightMm: 10 }] })
    expect(s.isError, JSON.stringify(s.content)).toBeFalsy()
    expect(data<{ output: { removedVolumeMm3: number } }>(s).output.removedVolumeMm3).toBeGreaterThan(100)
  })

  it('generates a calibration model and reports bad input as an error', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const c = await h.call('slicerx_geom_calibration_model', { test: 'temp-tower' })
    const f = await h.call('slicerx_geom_calibration_model', { test: 'feature-piece' })
    expect(f.isError, JSON.stringify(f.content)).toBeFalsy()
    expect(c.isError, JSON.stringify(c.content)).toBeFalsy()
    const bad = await h.call('slicerx_geom_cut', { model: 'sample:nope', plane: { axis: 'z', at: 5 } })
    expect(bad.isError).toBe(true)
  })

  it('draws a model: a short summary by default, the PNG only when asked', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const plain = await h.call('slicerx_geom_render', { model: 'sample:x-mark' })
    expect(plain.isError, JSON.stringify(plain.content)).toBeFalsy()
    expect(plain.content.every((c) => c.type === 'text')).toBe(true)
    const s = data<{ output: { view: string; widthPx: number; heightPx: number; triangles: number } }>(plain).output
    expect(s.view).toBe('iso')
    expect(Math.max(s.widthPx, s.heightPx)).toBe(384)
    expect(s.triangles).toBeGreaterThan(1000)
    const shown = await h.call('slicerx_geom_render', { model: 'sample:x-mark', view: 'top', size: 128, image: true })
    expect(shown.isError, JSON.stringify(shown.content)).toBeFalsy()
    const img = shown.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined
    expect(img?.mimeType).toBe('image/png')
    const png = Buffer.from(img?.data ?? '', 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20))).toBe(128)
    // Paint is drawn and counted: one whole triangle of the cube painted slot 2.
    const painted = await h.call('slicerx_geom_render', { model: 'sample:cube-20', paint: { '0': '8' }, colors: ['#ff8000', '#ffff80'] })
    const area = data<{ output: { paintedAreaMm2: Record<string, number> } }>(painted).output.paintedAreaMm2
    expect(area['2']).toBeCloseTo(200, 1)
  })

  it('reads paint back as regions per state', async () => {
    const h = await connect({ sxGeomBin: geomBin })
    const r = await h.call('slicerx_geom_paint_regions', { model: 'sample:cube-20', paint: { '0': '8', '1': '8', '2': '0C' } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const out = data<{ output: { states: { state: number; areaMm2: number; regionCount: number }[]; badPaint: number } }>(r).output
    expect(out.badPaint).toBe(0)
    expect(out.states.map((s) => s.state)).toEqual([2, 3])
    expect(out.states[0]?.areaMm2).toBeCloseTo(400, 1)
    const bad = data<{ output: { badPaint: number } }>(await h.call('slicerx_geom_paint_regions', { model: 'sample:cube-20', paint: { '0': 'zz' } })).output
    expect(bad.badPaint).toBe(1)
  })

  it('follows the permission policy for mesh-writing tools', async () => {
    const h = await connect({ sxGeomBin: geomBin, policy: { classes: { slice: 'off', queue: 'off', start: 'off', profile: 'off' } } })
    const r = await h.call('slicerx_geom_hollow', { model: 'sample:cube-20' })
    expect(r.isError).toBe(true)
    const read = await h.call('slicerx_geom_orient', { model: 'sample:cube-20' })
    expect(read.isError).toBeFalsy()
  })
})
