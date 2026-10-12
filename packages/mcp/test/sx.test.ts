// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as pilot from '@slicerx/pilot'
import { BRIDGES_LISTED, bridgeSummary, parseSxOutput, sxConfig, sxFailure } from '../src/sx'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

describe('sx output', () => {
  it('reads the one-line summary', () => {
    const p = parseSxOutput('100 layers, 12.5 ms, 4567 bytes of G-code, 1234 s estimated, filament [1500.4, 20.1] mm, 1 tool changes\n')
    expect(p).toEqual({ layers: 100, timeS: 1234, filamentMm: 1520.5 })
  })

  it('reads a JSON result', () => {
    const p = parseSxOutput('{"schema_version":1,"layer_count":42,"stats":{"time_s":600,"filament_mm":[800,200]}}')
    expect(p).toEqual({ layers: 42, timeS: 600, filamentMm: 1000 })
  })

  it('turns an off-bed refusal into a preflight error that names the object and the arrange tool', () => {
    const why = 'sx slice: blocked by the safety preflight: toolpaths lie outside the printable area from layer 1 (X78.8 Y211.1, skirt nearest "cube"), 5 points in layers 1 to 30; move "cube" onto the bed or arrange the plate'
    const e = sxFailure(1, why)
    expect(e.code).toBe('preflight_blocked')
    expect(e.message).toContain('move "cube" onto the bed or arrange the plate')
    expect(e.message).toContain('slicerx_arrange')
    expect(e.details).toEqual({ reason: 'outside_bed', fix: 'slicerx_arrange', layers: [1, 30] })
    expect(sxFailure(1, why.replace('in layers 1 to 30', 'in layer 1')).details).toEqual({ reason: 'outside_bed', fix: 'slicerx_arrange', layers: [1, 1] })
    // Other refusals keep their code and words, with no arrange hint.
    const other = sxFailure(1, 'sx slice: blocked by the safety preflight: 3 layers reach above the printable height')
    expect(other.code).toBe('preflight_blocked')
    expect(other.message).not.toContain('slicerx_arrange')
    expect(sxFailure(3, 'cube.stl: no plate 2').code).toBe('no_such_plate')
    expect(sxFailure(3, 'bad mesh').code).toBe('invalid_model')
    expect(sxFailure(1, 'out of memory').code).toBe('slice_failed')
  })

  it('rejects output it cannot read', () => {
    expect(() => parseSxOutput('segfault')).toThrow(/Could not read/)
  })

  it('turns percent and auto line widths into millimeters or drops them', () => {
    expect(sxConfig({ nozzle_diameter: [0.6], line_width: '100%', outer_wall_line_width: '0', inner_wall_line_width: '0.45', layer_height: 0.2 })).toEqual({
      nozzle_diameter: [0.6],
      line_width: 0.6,
      inner_wall_line_width: 0.45,
      layer_height: 0.2,
    })
  })
})

// Runs only where the core has been built (helpers.ts, sxBin).
describe.skipIf(noSx())('slicing with the real sx CLI', { timeout: sxTimeout }, () => {
  it('slices a cube to G-code', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), profiles: ['filament:pla'], overrides: { layer_height: 0.2, smart_layer: 'off' } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const s = data<{ engine: string; layer_count: number; gcode_path: string; filament_g: number }>(r)
    expect(s.engine).toBe('sx')
    expect(s.layer_count).toBe(100)
    expect(s.filament_g).toBeGreaterThan(0)
    expect(readFileSync(s.gcode_path, 'utf8')).toMatch(/^G1 /m)
  })

  it('slices with paint given in the call, and refuses paint that does not read', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const base = { model: join(h.dir, 'cube.stl'), profiles: ['filament:pla'], filaments: [{ slot: 2, profile: 'filament:pla', color: '#00AE42' }], overrides: { layer_height: 0.2, smart_layer: 'off' } }
    const plain = data<{ filaments: { slot: number; filament_mm: number }[] }>(await h.call('slicerx_slice_file', base))
    const r = await h.call('slicerx_slice_file', { ...base, paint: { '0': { color: { '0': '8', '1': '8' } } } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const painted = data<{ filaments: { slot: number; filament_mm: number }[] }>(r)
    const slot2 = (s: { filaments: { slot: number; filament_mm: number }[] }) => s.filaments.find((f) => f.slot === 2)?.filament_mm ?? 0
    expect(slot2(plain)).toBe(0)
    expect(slot2(painted)).toBeGreaterThan(0)
    const bad = await h.call('slicerx_slice_file', { ...base, paint: { '0': { color: { '0': 'zz' } } } })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toMatch(/does not read/)
  })
})

const hasRegistry = typeof (pilot as unknown as Record<string, unknown>)['builtinTools'] === 'function'
describe.skipIf(noSx() || !hasRegistry)('a project through mimir with the real core', { timeout: sxTimeout }, () => {
  it('slices two cubes with the real core and leaves the start to a person', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.call('slicerx_project_open', { name: 'Cubes', printer: 'bambu_p1s', filament: 'pla' })
    await h.call('slicerx_project_add_model', { model: join(h.dir, 'cube.stl'), copies: 2 })
    const sliced = await h.call('slicerx_slice', {})
    expect(sliced.isError, JSON.stringify(sliced.content)).toBeFalsy()
    const q = data<{ status: string; request_id: string }>(await h.call('slicerx_printer_queue', { printerId: 'bay-2', plate: 1 }))
    expect(q.status).toBe('needs_person')
    const r = await h.call('slicerx_approve', { request_id: q.request_id, approve: true })
    expect(r.isError).toBe(true)
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-2' })
    expect(JSON.stringify(st.structuredContent)).toMatch(/idle/)
  })
})

describe('bridges in the slice summary', () => {
  it('lists each bridge with its angle and anchors, and counts the rest past the first 100', () => {
    expect(bridgeSummary(undefined)).toEqual({})
    expect(bridgeSummary([{ layer: 12, angleDeg: 90, anchors: 2, areaMm2: 41.5 }])).toEqual({ bridges: [{ layer: 12, angle_deg: 90, anchors: 2, area_mm2: 41.5 }] })
    const many = Array.from({ length: BRIDGES_LISTED + 5 }, (_, i) => ({ layer: i, angleDeg: 0, anchors: 1, areaMm2: 1 }))
    const s = bridgeSummary(many)
    expect(s.bridges).toHaveLength(BRIDGES_LISTED)
    expect(s.bridge_count).toBe(BRIDGES_LISTED + 5)
  })
})

// A 30 mm slab on two pillars 20 mm apart: the slab's underside between them is a bridge over air, held by the
// pillars' tops on both sides, so its strands run from pillar to pillar (along X).
function bridgeStl(): string {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[][][] => {
    const p = (x: number, y: number, z: number) => [x, y, z]
    const [a, b, c, d] = [p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)]
    const [e, f, g, h] = [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)]
    return [[a, c, b], [a, d, c], [e, f, g], [e, g, h], [a, b, f], [a, f, e], [b, c, g], [b, g, f], [c, d, h], [c, h, g], [d, a, e], [d, e, h]]
  }
  const tris = [...box(0, 0, 0, 5, 10, 10), ...box(25, 0, 0, 30, 10, 10), ...box(0, 0, 10, 30, 10, 13)]
  return `solid b\n${tris.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((v) => `vertex ${v.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid b\n`
}

describe.skipIf(noSx())('bridges with the real sx CLI', { timeout: sxTimeout }, () => {
  it('reports the bridge over the gap with the way its strands run', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const model = join(h.dir, 'bridge.stl')
    writeFileSync(model, bridgeStl())
    const r = await h.call('slicerx_slice_file', { model, profiles: ['filament:pla'], overrides: { layer_height: 0.2, smart_layer: 'off' } })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const s = data<{ bridges?: { layer: number; angle_deg: number; anchors: number; area_mm2: number }[] }>(r)
    const over = (s.bridges ?? []).filter((b) => b.area_mm2 > 50)
    expect(over.length, JSON.stringify(s.bridges)).toBeGreaterThan(0)
    for (const b of over) {
      expect(Math.min(b.angle_deg, 180 - b.angle_deg), JSON.stringify(b)).toBeLessThan(5)
      expect(b.anchors).toBeGreaterThan(0)
    }
  })
})
