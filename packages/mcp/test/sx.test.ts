// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as pilot from '@slicerx/pilot'
import { parseSxOutput, sxConfig } from '../src/sx'
import { connect, data } from './helpers'

describe('sx output', () => {
  it('reads the one-line summary', () => {
    const p = parseSxOutput('100 layers, 12.5 ms, 4567 bytes of G-code, 1234 s estimated, filament [1500.4, 20.1] mm, 1 tool changes\n')
    expect(p).toEqual({ layers: 100, timeS: 1234, filamentMm: 1520.5 })
  })

  it('reads a JSON result', () => {
    const p = parseSxOutput('{"schema_version":1,"layer_count":42,"stats":{"time_s":600,"filament_mm":[800,200]}}')
    expect(p).toEqual({ layers: 42, timeS: 600, filamentMm: 1000 })
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

// Runs only where the core has been built (cargo build -p sx-cli --release).
const sxBin = resolve(__dirname, '../../../target/release/sx')
describe.skipIf(!existsSync(sxBin))('slicing with the real sx CLI', () => {
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
describe.skipIf(!existsSync(sxBin) || !hasRegistry)('a project through mimir with the real core', () => {
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
