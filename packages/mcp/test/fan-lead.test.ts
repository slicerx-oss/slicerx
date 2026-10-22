// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fan lead time (`pre_start_fan_time`) for clients: explained with its unit and range, set on a project and
// read back, refused outside 0 to 5 s, and taken by the engine. Nothing here sends anything to a printer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

describe('the fan lead time setting', () => {
  it('is explained with its unit, range and default', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_explain_setting', { key: 'pre_start_fan_time' })
      expect(r.isError, text(r)).toBeFalsy()
      expect(data(r)).toMatchObject({ key: 'pre_start_fan_time', label: 'Fan lead time', section: 'filament', group: 'cooling', unit: 's', min: 0, max: 5, default: [0] })
    } finally { await h.client.close() }
  })

  it('is set on a project and read back, and refused outside 0 to 5 s', async () => {
    const h = await connect()
    try {
      await h.call('slicerx_project_open', { filament: 'pla' })
      const set = await h.call('slicerx_project_set_overrides', { changes: { pre_start_fan_time: [2] } })
      expect(set.isError, text(set)).toBeFalsy()
      const read = async () => data<{ output: { overrides: Record<string, unknown> } }>(await h.call('slicerx_project_show')).output.overrides
      expect(await read()).toMatchObject({ pre_start_fan_time: [2] })
      for (const bad of [5.5, -1]) {
        const r = await h.call('slicerx_project_set_overrides', { changes: { pre_start_fan_time: [bad] } })
        expect(r.isError, String(bad)).toBe(true)
        expect(text(r)).not.toContain('not a known setting')
      }
      expect(await read()).toMatchObject({ pre_start_fan_time: [2] })
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('a slice with a fan lead time', { timeout: sxTimeout }, () => {
  it('slices with the value and is refused by the engine outside 0 to 5 s', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides: { pre_start_fan_time: [2] } })
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<{ gcode_path?: string; warnings: string[] }>(r)
      expect(readFileSync(out.gcode_path!, 'utf8')).toContain('M106')
      expect(out.warnings.join(' ')).not.toContain('pre_start_fan_time')
      const bad = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides: { pre_start_fan_time: [7] } })
      expect(bad.isError).toBe(true)
    } finally { await h.client.close() }
  })
})
