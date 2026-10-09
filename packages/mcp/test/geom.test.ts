// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
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
    for (const n of ['cut', 'split', 'orient', 'repair', 'hollow', 'emboss', 'calibration_model', 'resume_plan', 'layers_plan', 'build', 'subtract']) expect(names).toContain(`slicerx_geom_${n}`)
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

  it('follows the permission policy for mesh-writing tools', async () => {
    const h = await connect({ sxGeomBin: geomBin, policy: { classes: { slice: 'off', queue: 'off', start: 'off', profile: 'off' } } })
    const r = await h.call('slicerx_geom_hollow', { model: 'sample:cube-20' })
    expect(r.isError).toBe(true)
    const read = await h.call('slicerx_geom_orient', { model: 'sample:cube-20' })
    expect(read.isError).toBeFalsy()
  })
})
