// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fully clear overhang speed (overhang_totally_speed) for clients: explained, set on a project and read back,
// kept from a project file, and handed to the engine, which writes it into a Bambu Lab printer's G-code settings
// block. Nothing here sends anything to a printer.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

function project(dir: string, settings: Record<string, unknown>): string {
  const path = join(dir, 'clear-overhang.3mf')
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: MODEL },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.2', filament_type: ['PLA'], enable_overhang_speed: '1', ...settings }) },
  ]))
  return path
}

describe('the fully clear overhang speed', () => {
  it('is explained with its label, unit and default', async () => {
    const h = await connect()
    try {
      const d = await h.call('slicerx_explain_setting', { key: 'overhang_totally_speed' })
      expect(d.isError, text(d)).toBeFalsy()
      expect(data(d)).toMatchObject({ key: 'overhang_totally_speed', label: 'Fully clear overhang speed', section: 'process', unit: 'mm/s', default: [0] })
    } finally { await h.client.close() }
  })

  it('is set on a project and read back', async () => {
    const h = await connect()
    try {
      await h.call('slicerx_project_open', { filament: 'pla' })
      const set = await h.call('slicerx_project_set_overrides', { changes: { overhang_totally_speed: [12] } })
      expect(set.isError, text(set)).toBeFalsy()
      const read = data<{ output: { overrides: Record<string, unknown> } }>(await h.call('slicerx_project_show')).output.overrides
      expect(read).toMatchObject({ overhang_totally_speed: [12] })
    } finally { await h.client.close() }
  })

  it("is kept from a project file's settings", async () => {
    const h = await connect()
    try {
      expect(readProjectFile(project(h.dir, { overhang_totally_speed: ['12'] })).config['overhang_totally_speed']).toEqual([12])
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('a slice of a project that sets it', { timeout: sxTimeout }, () => {
  it('hands the value to the engine', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      // A Bambu Lab printer, whose G-code ends with the settings block the engine sliced with.
      const r = await h.call('slicerx_slice_file', { model: project(h.dir, { overhang_totally_speed: ['12'], printer_model: 'Bambu Lab P1S' }), project_settings: true })
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<{ gcode_path?: string; warnings: string[] }>(r)
      expect(readFileSync(out.gcode_path!, 'utf8')).toMatch(/^; overhang_totally_speed = 12$/m)
      expect(out.warnings.join(' ')).not.toMatch(/overhang_totally_speed/)
    } finally { await h.client.close() }
  })
})
