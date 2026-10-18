// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer whose start G-code reads chamber_cooling_mode (the Snapmaker U1 with its Top Cover): a client slices and
// reads back the mode the G-code got and where it came from, the filaments the plate prints or the project's own
// value. Nothing here sends anything to a printer.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

const START = '{if chamber_cooling_mode==0}\n; chamber: keep warm\n{elsif chamber_cooling_mode==2}\n; chamber: strong cooling\n{else}\n; chamber: weak cooling\n{endif}\nM190 S60\nM109 S220\n'

type Chamber = { mode: number; source: string; filaments?: string[]; text: string }
type Summary = { chamber_cooling?: Chamber; warnings: string[]; gcode_path?: string }

function project(dir: string, settings: Record<string, unknown>): string {
  const path = join(dir, 'u1.3mf')
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: MODEL },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ layer_height: '0.3', initial_layer_print_height: '0.3', filament_type: ['PLA'], ...settings }) },
  ]))
  return path
}

describe("a project's chamber cooling mode", () => {
  it('is carried as a project key, as the file has it', async () => {
    const h = await connect()
    expect(readProjectFile(project(h.dir, { chamber_cooling_mode: '0' })).config['chamber_cooling_mode']).toBe('0')
  })
})

describe.skipIf(noSx())('chamber cooling read back', { timeout: sxTimeout }, () => {
  const slice = async (args: Record<string, unknown>): Promise<Summary> => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), ...args, overrides: { machine_start_gcode: START, ...(args['overrides'] as object | undefined) } })
      expect(r.isError, text(r)).toBeFalsy()
      expect(text(r)).toContain('Chamber: chamber cooling mode')
      return data<Summary>(r)
    } finally { await h.client.close() }
  }

  it('comes from the filaments the plate prints', async () => {
    const out = await slice({ overrides: { filament_type: ['PLA'] } })
    expect(out.chamber_cooling).toMatchObject({ mode: 2, source: 'derived', filaments: ['PLA'] })
    expect(readFileSync(out.gcode_path!, 'utf8')).toContain('; chamber: strong cooling')
  })

  it('falls back to weak cooling with a warning when they disagree on the airflow', async () => {
    const out = await slice({ filaments: [{ slot: 2, color: '#00ff00' }], overrides: { filament_type: ['ABS', 'PLA'], sparse_infill_filament_id: 2 } })
    expect(out.chamber_cooling).toMatchObject({ mode: 1, source: 'derived', filaments: ['ABS', 'PLA'] })
    expect(out.warnings).toContain('ABS and PLA need different chamber airflow; using weak cooling')
  })

  it("keeps the project's own value", async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: project(h.dir, { chamber_cooling_mode: '0' }), project_settings: true, overrides: { machine_start_gcode: START } })
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<Summary>(r)
      expect(out.chamber_cooling).toMatchObject({ mode: 0, source: 'project' })
      expect(readFileSync(out.gcode_path!, 'utf8')).toContain('; chamber: keep warm')
    } finally { await h.client.close() }
  })
})
