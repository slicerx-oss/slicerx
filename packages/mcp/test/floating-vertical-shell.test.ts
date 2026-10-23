// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The floating vertical shell settings for clients: explained, set on a project and read back, and taken by the
// engine, which names the feature in the G-code. Nothing here sends anything to a printer.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxStl, connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

describe('the floating vertical shell settings', () => {
  it('are explained with their labels and defaults', async () => {
    const h = await connect()
    try {
      const d = await h.call('slicerx_explain_setting', { key: 'detect_floating_vertical_shell' })
      expect(d.isError, text(d)).toBeFalsy()
      expect(data(d)).toMatchObject({ key: 'detect_floating_vertical_shell', label: 'Detect floating vertical shells', section: 'process', default: true })
      const s = await h.call('slicerx_explain_setting', { key: 'vertical_shell_speed' })
      expect(s.isError, text(s)).toBeFalsy()
      expect(data(s)).toMatchObject({ key: 'vertical_shell_speed', label: 'Floating vertical shell speed', section: 'process', unit: 'mm/s', default: ['80%'] })
    } finally { await h.client.close() }
  })

  it('are set on a project and read back', async () => {
    const h = await connect()
    try {
      await h.call('slicerx_project_open', { filament: 'pla' })
      const set = await h.call('slicerx_project_set_overrides', { changes: { detect_floating_vertical_shell: false, vertical_shell_speed: ['60%'] } })
      expect(set.isError, text(set)).toBeFalsy()
      const read = async () => data<{ output: { overrides: Record<string, unknown> } }>(await h.call('slicerx_project_show')).output.overrides
      expect(await read()).toMatchObject({ detect_floating_vertical_shell: false, vertical_shell_speed: ['60%'] })
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('a slice on a Bambu Lab printer', { timeout: sxTimeout }, () => {
  it('prints the floating vertical shell of a narrow wall and slows it where it hangs over sparse infill', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      // A 6 x 30 x 14 mm wall: the narrow solid under its top rests on sparse infill in one small piece.
      const model = join(h.dir, 'rib.stl')
      writeFileSync(model, boxStl(6, 30, 14))
      const on = await h.call('slicerx_slice_file', { model, overrides: { printer_model: 'Bambu Lab P1S', top_shell_layers: 5, sparse_infill_density: '15%' } })
      expect(on.isError, text(on)).toBeFalsy()
      const out = data<{ gcode_path?: string; warnings: string[] }>(on)
      const g = readFileSync(out.gcode_path!, 'utf8')
      expect(g).toMatch(/; ?(FEATURE: |TYPE:)Floating vertical shell/)
      expect(g).toContain('; Slow Down Start')
      expect(out.warnings.join(' ')).not.toMatch(/detect_floating_vertical_shell|vertical_shell_speed/)
      const off = await h.call('slicerx_slice_file', { model, overrides: { printer_model: 'Bambu Lab P1S', top_shell_layers: 5, sparse_infill_density: '15%', detect_floating_vertical_shell: false } })
      expect(off.isError, text(off)).toBeFalsy()
      expect(readFileSync(data<{ gcode_path?: string }>(off).gcode_path!, 'utf8')).not.toContain('; Slow Down Start')
    } finally { await h.client.close() }
  })
})
