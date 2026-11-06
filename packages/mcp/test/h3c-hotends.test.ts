// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab H3C holds nine hotends on one extruder. A client reads which tool prints each filament, with the TPU
// tool flagged: from the project before a slice, and from the slice itself. It sets the tools of the app's plate by
// hand as the person does in the Filament block, and a chamber target over the H3C's 65 C prints at 65 C with a
// warning that says so.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appPlateInputs } from '../src/app-plate-inputs'
import { resolveSliceConfig } from '../src/config'
import { boxStl, connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

type Row = { slot: number; tool: number; hotend: number; tpu_tool: boolean; tpu285: boolean }
type Hotends = { auto: boolean; filaments: Row[] }

describe('H3C hotends over MCP', () => {
  it('carries the maker process values per hotend type in a machine:bambu-h3c slice', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:bambu-h3c', 'process:standard'])
    const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-h3c', 'process:standard'], {})
    const c = config as Record<string, unknown>
    expect(c['print_extruder_variant']).toEqual(['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU285'])
    expect(c['outer_wall_speed']).toEqual([200, 500, 200])
  })

  it('reads back each project filament on its tool before a slice, and a map set by hand', async () => {
    const h = await connect()
    const opened = await h.call('slicerx_project_open', { name: 'Tools', profiles: ['machine:bambu-h3c'] })
    expect(opened.isError, text(opened)).toBeFalsy()
    await h.call('slicerx_project_add_filament', { type: 'TPU', color: '#222222' })
    await h.call('slicerx_project_add_filament', { type: 'PLA', color: '#0a2989' })
    const set = await h.call('slicerx_project_set_overrides', { changes: { filament_diameter: [1.75, 2.85, 1.75] } })
    expect(set.isError, text(set)).toBeFalsy()
    const shown = data<{ output: { hotends?: Hotends } }>(await h.call('slicerx_project_show')).output.hotends
    expect(shown).toEqual({
      auto: true,
      filaments: [
        { slot: 1, tool: 1, hotend: 0, tpu_tool: false, tpu285: false },
        { slot: 2, tool: 8, hotend: 7, tpu_tool: true, tpu285: true },
        { slot: 3, tool: 2, hotend: 1, tpu_tool: false, tpu285: false },
      ],
    })
    // A tool by hand, as the person picks it in the Filament block; the others stay where they print.
    const picked = await h.call('slicerx_project_set_tool', { slot: 1, tool: 5 })
    expect(picked.isError, text(picked)).toBeFalsy()
    const own = data<{ output: { hotends?: Hotends } }>(await h.call('slicerx_project_show')).output.hotends
    expect(own?.auto).toBe(false)
    expect(own?.filaments.map((r) => r.tool)).toEqual([5, 8, 2])
    // The TPU tool takes 2.85 mm TPU only, and the TPU stays on it.
    expect(text(await h.call('slicerx_project_set_tool', { slot: 3, tool: 8 }))).toMatch(/Tool 8 is the TPU tool/)
    expect(text(await h.call('slicerx_project_set_tool', { slot: 2, tool: 3 }))).toMatch(/2\.85 mm TPU, which prints only on the TPU tool/)
    expect(text(await h.call('slicerx_project_set_tool', { slot: 1, tool: 10 }))).toMatch(/tools 1 to 9/)
    await h.call('slicerx_project_set_tool', { slot: 1, tool: 'auto' })
    expect(data<{ output: { hotends?: Hotends } }>(await h.call('slicerx_project_show')).output.hotends?.auto).toBe(true)
  })

  it('leaves other printers without a hotend read-back', async () => {
    const h = await connect()
    await h.call('slicerx_project_open', { printer: 'bambu_p1s', filament: 'pla' })
    expect(data<{ output: { hotends?: Hotends } }>(await h.call('slicerx_project_show')).output.hotends).toBeUndefined()
  })

  it('takes the app plate tools by tool number', () => {
    expect(appPlateInputs.settings.parse({ plate: 1, settings: { hotendMap: [1, 8, 2] } }).settings.hotendMap).toEqual([1, 8, 2])
    expect(() => appPlateInputs.settings.parse({ plate: 1, settings: { hotendMap: [0] } })).toThrow()
    expect(() => appPlateInputs.settings.parse({ plate: 1, settings: { hotendMap: [1.5] } })).toThrow()
  })

  it.skipIf(noSx())('reads the slice tools back from the engine, and holds the chamber to 65 C', { timeout: sxTimeout * 2 }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.ctx.profiles.prepare(['machine:bambu-h3c'])
    const model = join(h.dir, 'cube20.stl')
    writeFileSync(model, boxStl(20, 20, 20))
    // One 2.85 mm TPU filament: the engine puts it on the TPU tool.
    const tpu = await h.call('slicerx_slice_file', { model, profiles: ['machine:bambu-h3c'], overrides: { filament_type: ['TPU'], filament_diameter: [2.85] } })
    expect(tpu.isError, text(tpu)).toBeFalsy()
    expect(data<{ hotends?: Hotends }>(tpu).hotends).toEqual({ auto: true, filaments: [{ slot: 1, tool: 8, hotend: 7, tpu_tool: true, tpu285: true }] })
    // A chamber target over the limit: printed at the limit, with the engine's warning.
    const hot = await h.call('slicerx_slice_file', { model, profiles: ['machine:bambu-h3c'], overrides: { chamber_temperature: [70] } })
    expect(hot.isError, text(hot)).toBeFalsy()
    const details = data<{ warning_details?: { code: string; message: string }[] }>(hot).warning_details ?? []
    expect(details.some((w) => w.code === 'safety_limit' && /chamber/.test(w.message) && /65 C/.test(w.message)), JSON.stringify(details)).toBe(true)
  })
})
