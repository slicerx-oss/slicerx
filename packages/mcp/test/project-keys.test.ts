// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project's own project keys (flush volumes, filament to nozzle map, AMS units, prime tower spot) reach
// the engine with project_settings: they are not preset settings, and were left out of the request before.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { readProjectFile } from '../src/projectfile'
import { sxConfig } from '../src/sx'
import { writeZip } from '../src/zip'
import { connect, noSx, sxBin } from './helpers'

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

describe.skipIf(noSx())('with the real sx CLI', () => {
  it('writes them into the request and slices', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: h2dProject(h.dir), project_settings: true, project_gcode: 'profile' })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const jobs = join(h.dir, 'out', 'jobs')
    const request = JSON.parse(readFileSync(join(jobs, readdirSync(jobs)[0]!, 'request.json'), 'utf8')) as { config: Record<string, unknown> }
    for (const [k, v] of Object.entries(KEYS)) expect(request.config[k], k).toEqual(v)
  })
})

/** A Bambu project with `generator` walls (arachne unless given), and the list of keys the person changed (Bambu Studio's process entry first). */
function wallsProject(dir: string, name: string, changed: string | undefined, generator = 'arachne', printer = 'Bambu Lab A1'): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    writeZip([
      { name: '3D/3dmodel.model', data: MODEL },
      {
        name: 'Metadata/project_settings.config',
        data: JSON.stringify({
          printer_settings_id: `${printer} 0.4 nozzle`,
          printer_model: printer,
          wall_generator: generator,
          precise_outer_wall: '1',
          ...(changed !== undefined ? { different_settings_to_system: [changed, '', ''] } : {}),
        }),
      },
    ]),
  )
  return path
}

describe("SlicerX's engine choices in an opened project", () => {
  it('keep aegis walls when a project for another printer inherited classic walls', async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'inherited.3mf', 'sparse_infill_density', 'classic', 'Acme Printer 9000'))
    // SlicerX's own values (engine-choices.json), as sx slice <project.3mf> uses them.
    expect(read.config['wall_generator']).toBe('aegis')
    expect(read.summary.import_report.walls).toEqual({ generator: 'aegis', source: 'kept', text: "aegis walls, kept by SlicerX; the project used its preset's default classic" })
    // The project's own precise outer wall.
    expect(read.config['precise_outer_wall']).toBe(true)
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'inherited.3mf', config: read.config } })
    expect(r.config['wall_generator']).toBe('aegis')
  })

  it('keep the classic walls a stock Bambu Lab project inherited', async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'bambu-inherited.3mf', 'sparse_infill_density', 'classic'))
    expect(read.config['wall_generator']).toBe('classic')
    expect(read.summary.import_report.walls).toEqual({ generator: 'classic', source: 'project', text: 'classic walls, as the project has them' })
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'bambu-inherited.3mf', config: read.config } })
    expect(r.config['wall_generator']).toBe('classic')
  })

  it('take aegis walls a Bambu Lab project chose', async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'bambu-aegis.3mf', 'wall_generator;sparse_infill_density', 'aegis'))
    expect(read.config['wall_generator']).toBe('aegis')
    expect(read.summary.import_report.walls).toEqual({ generator: 'aegis', source: 'project', text: "aegis walls, the project's own choice" })
  })

  it('keep the arachne walls a project inherited', async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'inherited-arachne.3mf', 'sparse_infill_density'))
    expect(read.config['wall_generator']).toBe('arachne')
    expect(read.summary.import_report.walls).toEqual({ generator: 'arachne', source: 'project', text: 'arachne walls, as the project has them' })
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'inherited-arachne.3mf', config: read.config } })
    expect(r.config['wall_generator']).toBe('arachne')
  })

  it('take classic walls the person picked', async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'picked.3mf', 'wall_generator;sparse_infill_density', 'classic'))
    expect(read.config['wall_generator']).toBe('classic')
    expect(read.summary.import_report.walls?.text).toBe("classic walls, the project's own choice")
  })

  it("take the file's wall generator when the person changed it there", async () => {
    const h = await connect()
    const read = readProjectFile(wallsProject(h.dir, 'changed.3mf', 'wall_generator;sparse_infill_density'))
    expect(read.config['wall_generator']).toBe('arachne')
    // The project's own precise outer wall (1), listed as changed or not.
    expect(read.config['precise_outer_wall']).toBe(true)
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

/** A Bambu Studio project that sets one wall on top with `top_one_wall_type`, `only_one_wall_top` beside it. */
function oneWallProject(dir: string, name: string, kind: string, flag: string): string {
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
          top_one_wall_type: kind,
          only_one_wall_top: flag,
        }),
      },
    ]),
  )
  return path
}

/** A Bambu project that sets `precise` as its precise outer wall, or leaves the key out when undefined. */
function preciseProject(dir: string, name: string, precise: string | undefined): string {
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
          ...(precise !== undefined ? { precise_outer_wall: precise } : {}),
          different_settings_to_system: ['sparse_infill_density', '', ''],
        }),
      },
    ]),
  )
  return path
}

describe("a project's precise outer wall", () => {
  it("keeps the project's own value, listed as changed or not", async () => {
    const h = await connect()
    expect(readProjectFile(preciseProject(h.dir, 'off.3mf', '0')).config['precise_outer_wall']).toBe(false)
    expect(readProjectFile(preciseProject(h.dir, 'on.3mf', '1')).config['precise_outer_wall']).toBe(true)
  })

  it("is SlicerX's default when the project does not set it", async () => {
    const h = await connect()
    expect(readProjectFile(preciseProject(h.dir, 'unset.3mf', undefined)).config['precise_outer_wall']).toBe(true)
  })
})

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

describe("a project's top_one_wall_type", () => {
  it('reaches the engine as only_one_wall_top, over the only_one_wall_top the file also has', async () => {
    const h = await connect()
    const read = readProjectFile(oneWallProject(h.dir, 'all.3mf', 'all top', '0'))
    expect(read.config['only_one_wall_top']).toBe(true)
    const r = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined, { project: { name: 'all.3mf', config: read.config } })
    expect(sxConfig(r.explicit)['only_one_wall_top']).toBe(true)
    expect(readProjectFile(oneWallProject(h.dir, 'topmost.3mf', 'topmost', '0')).config['only_one_wall_top']).toBe(true)
    expect(readProjectFile(oneWallProject(h.dir, 'not.3mf', 'not apply', '1')).config['only_one_wall_top']).toBe(false)
  })
})

describe('a project read for slicing', () => {
  it("keeps SlicerX's engine choices at SlicerX's values and reads the painted color depths", async () => {
    const h = await connect()
    const path = join(h.dir, 'kept.3mf')
    writeFileSync(
      path,
      writeZip([
        { name: '3D/3dmodel.model', data: MODEL },
        {
          name: 'Metadata/project_settings.config',
          data: JSON.stringify({
            printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
            layer_height: '0.2',
            wall_generator: 'classic',
            precise_outer_wall: '0',
            top_color_penetration_layers: '5',
            bottom_color_penetration_layers: '3',
            // Inherited: the person changed only the layer height.
            different_settings_to_system: ['layer_height', '', ''],
          }),
        },
      ]),
    )
    const read = readProjectFile(path)
    expect(read.config['wall_generator']).toBe('aegis')
    // The project's own precise outer wall, even though it inherited it, as sx slice <project.3mf> keeps it.
    expect(read.config['precise_outer_wall']).toBe(false)
    expect(read.config['top_color_penetration_layers']).toBe(5)
    expect(read.config['bottom_color_penetration_layers']).toBe(3)
    expect(read.summary.import_report.other_slicer).toEqual([])
  })
})
