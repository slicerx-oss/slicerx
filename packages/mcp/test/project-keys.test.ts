// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project's own project keys (flush volumes, filament to nozzle map, AMS units, prime tower spot) reach
// the engine with project_settings: they are not preset settings, and were left out of the request before.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { readProjectFile } from '../src/projectfile'
import { sxConfig } from '../src/sx'
import { writeZip } from '../src/zip'
import { connect } from './helpers'

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="20" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="20" z="10"/><vertex x="0" y="20" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

/** The project keys of a two-filament H2D project, as Bambu Studio writes them (numbers as strings). */
const KEYS = {
  flush_volumes_matrix: ['0', '362', '900', '0', '0', '377', '900', '0'],
  flush_multiplier: ['1', '1'],
  filament_map: ['1', '2'],
  filament_map_mode: 'Auto For Flush',
  extruder_ams_count: ['1#0|4#0', '1#0|4#1'],
  wipe_tower_x: ['135.017'],
  wipe_tower_y: ['265.42'],
}

function h2dProject(dir: string): string {
  const path = join(dir, 'h2d.3mf')
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({
          printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
          printer_model: 'Bambu Lab H2D',
          print_settings_id: '0.20mm Standard @BBL H2D',
          filament_settings_id: ['Generic PLA @BBL H2D', 'Generic PLA @BBL H2D'],
          filament_type: ['PLA', 'PLA'],
          layer_height: '0.2',
          ...KEYS,
        }),
      },
    ]),
  )
  return path
}

describe("a project's own project keys", () => {
  it('come with its print settings', async () => {
    const h = await connect()
    const read = readProjectFile(h2dProject(h.dir))
    for (const [k, v] of Object.entries(KEYS)) expect(read.config[k], k).toEqual(v)
    // and the preset settings beside them, as before
    expect(read.config['layer_height']).toBe(0.2)
  })

  it('reach the engine request with project_settings', async () => {
    const h = await connect()
    const read = readProjectFile(h2dProject(h.dir))
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'h2d.3mf', config: read.config } })
    const request = sxConfig(r.explicit)
    for (const [k, v] of Object.entries(KEYS)) expect(request[k], k).toEqual(v)
  })
})

const sxBin = resolve(__dirname, '../../../target/release/sx')
describe.skipIf(!existsSync(sxBin))('with the real sx CLI', () => {
  it('writes them into the request and slices', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: h2dProject(h.dir), project_settings: true, project_gcode: 'profile' })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const jobs = join(h.dir, 'out', 'jobs')
    const request = JSON.parse(readFileSync(join(jobs, readdirSync(jobs)[0]!, 'request.json'), 'utf8')) as { config: Record<string, unknown> }
    for (const [k, v] of Object.entries(KEYS)) expect(request.config[k], k).toEqual(v)
  })
})

/** A Bambu project with Arachne walls, and the list of keys the person changed (Bambu Studio's process entry first). */
function wallsProject(dir: string, name: string, changed: string | undefined): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({
          printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
          printer_model: 'Bambu Lab A1',
          wall_generator: 'arachne',
          precise_outer_wall: '1',
          ...(changed !== undefined ? { different_settings_to_system: [changed, '', ''] } : {}),
        }),
      },
    ]),
  )
  return path
}

describe("SlicerX's engine choices in an opened project", () => {
  it('keep aegis walls when the project inherited its wall generator', async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'inherited.3mf', 'sparse_infill_density'))
    expect(read.config['wall_generator']).toBeUndefined()
    expect(read.config['precise_outer_wall']).toBeUndefined()
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'inherited.3mf', config: read.config } })
    expect(r.config['wall_generator']).toBe('aegis')
  })

  it("take the file's wall generator when the person changed it there", async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'changed.3mf', 'wall_generator;sparse_infill_density'))
    expect(read.config['wall_generator']).toBe('arachne')
    expect(read.config['precise_outer_wall']).toBeUndefined()
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'changed.3mf', config: read.config } })
    expect(r.config['wall_generator']).toBe('arachne')
  })

  it("take every value from a file that does not say what was changed", async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'silent.3mf', undefined))
    expect(read.config['wall_generator']).toBe('arachne')
  })
})

/** A Bambu Studio 2.8 project: its infill retraction is a mode, with each filament's metal stickiness beside it. */
function retractionProject(dir: string, name: string, mode: string, stickiness: string[]): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({
          printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
          printer_model: 'Bambu Lab H2D',
          reduce_infill_retraction_mode: mode,
          filament_metal_stickiness: stickiness,
        }),
      },
    ]),
  )
  return path
}

describe("a project's reduce_infill_retraction_mode", () => {
  it('reaches the engine as reduce_infill_retraction: Auto with PLA skips retraction inside infill', async () => {
    const h = await connect()
    const read = readProjectFile(retractionProject(h.dir, 'auto.3mf', 'Auto', ['None', 'None', 'None', 'None']))
    expect(read.config['reduce_infill_retraction']).toBe(true)
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'auto.3mf', config: read.config } })
    expect(sxConfig(r.explicit)['reduce_infill_retraction']).toBe(true)
  })

  it('keeps the retraction for a high stickiness filament on Auto, and when the mode is Disabled', async () => {
    const h = await connect()
    expect(readProjectFile(retractionProject(h.dir, 'petg.3mf', 'Auto', ['None', 'High'])).config['reduce_infill_retraction']).toBe(false)
    expect(readProjectFile(retractionProject(h.dir, 'off.3mf', 'Disabled', ['None'])).config['reduce_infill_retraction']).toBe(false)
    expect(readProjectFile(retractionProject(h.dir, 'on.3mf', 'Enabled', ['High'])).config['reduce_infill_retraction']).toBe(true)
  })
})
