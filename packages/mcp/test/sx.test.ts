// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as pilot from '@slicerx/pilot'
import { parseSxOutput, sxConfig, sxFailure } from '../src/sx'
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
    // The other toolpath refusals carry their reason and the layers their count covers.
    const tall = sxFailure(1, 'sx slice: blocked by the safety preflight: layers reach above the printable height (with z-hop) from layer 98 (Z19.60 mm, "cube"), 3 layers in layers 76 to 100')
    expect(tall.code).toBe('preflight_blocked')
    expect(tall.message).not.toContain('slicerx_arrange')
    expect(tall.details).toEqual({ reason: 'over_height', layers: [76, 100] })
    const reach = sxFailure(1, 'sx slice: blocked by the safety preflight: toolpaths of filament 1 lie outside the reach of extruder 2 from layer 1 (X10.0 Y100.0, outer wall of "cube"), 40 points in layers 1 to 25; map the filament to the other extruder or move "cube"')
    expect(reach.details).toEqual({ reason: 'outside_extruder_reach', layers: [1, 25] })
    const zone = sxFailure(1, 'sx slice: blocked by the safety preflight: toolpaths enter an excluded bed area from layer 2 (X128.0 Y128.0, sparse infill of "cube"), 1 move in layer 2; move "cube" out of it or arrange the plate')
    expect(zone.details).toEqual({ reason: 'in_exclusion_zone', fix: 'slicerx_arrange', layers: [2, 2] })
    // A refusal of the settings (no toolpaths) carries no details.
    expect(sxFailure(1, 'sx slice: blocked by the safety preflight: the start G-code turns off the motors').details).toBeUndefined()
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
