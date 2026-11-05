// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A 3MF project keeps the values it holds when it opens on a printer, also those equal to the printer's Standard
// process: the plate starts from the goal nearest the project's layer height (Fine at 0.12 mm), whose own support gaps
// and overhang speed used to replace the project's 0.2 mm gaps and 50 mm/s. That held for keys the file lists as its
// own changes, keys it inherits from its presets, files with no list, projects for a printer with no profile, and
// another slicer's project.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importFlat } from '@slicerx/settings'
import { resolveSliceConfig } from '../src/config'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'
import { connect, noSx, sxBin, sxTimeout } from './helpers'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)

// A 20 mm slab on a 6 mm pillar, so supports have something to hold up.
const vertices = [[6, 6, 0], [14, 6, 0], [14, 14, 0], [6, 14, 0], [6, 6, 6], [14, 6, 6], [14, 14, 6], [6, 14, 6], [0, 0, 6], [20, 0, 6], [20, 20, 6], [0, 20, 6], [0, 0, 8], [20, 0, 8], [20, 20, 8], [0, 20, 8]]
const box = (o: number) => [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].map((t) => t.map((v) => v + o))
const model = (app: string) => `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">${app}</metadata><resources><object id="1" type="model"><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${[...box(0), ...box(8)].map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>`

/** A P1S project on 0.12 mm layers with 0.2 mm support gaps and a 50 mm/s overhang speed, each equal to Standard's. */
const P1S = {
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  printer_model: 'Bambu Lab P1S',
  nozzle_diameter: ['0.4'],
  print_settings_id: 'My supports',
  inherits_group: ['0.20mm Standard @BBL X1C', '', ''],
  layer_height: '0.12',
  enable_support: '1',
  support_type: 'normal(auto)',
  support_top_z_distance: '0.2',
  support_bottom_z_distance: '0.2',
  support_threshold_angle: '29',
  overhang_2_4_speed: '50',
}
const LISTED = 'enable_support;layer_height;overhang_2_4_speed;support_bottom_z_distance;support_threshold_angle;support_top_z_distance;support_type'
const PROJECTS: Record<string, Record<string, unknown>> = {
  // the gaps and the speed listed as the person's own changes
  listed: { ...P1S, different_settings_to_system: [LISTED, '', ''] },
  // only the layer height changed: the gaps and the speed come from its presets
  inherited: { ...P1S, different_settings_to_system: ['enable_support;layer_height;support_threshold_angle;support_type', '', ''] },
  // a file that does not list its changes
  unlisted: P1S,
  // a printer SlicerX has no profile for
  unknown: { ...P1S, printer_settings_id: 'Workshop Printer 0.4 nozzle', printer_model: 'Workshop Printer', different_settings_to_system: [LISTED, '', ''] },
}

const OWN = { support_top_z_distance: 0.2, support_bottom_z_distance: 0.2, support_threshold_angle: 29, enable_support: true, overhang_2_4_speed: importFlat({ overhang_2_4_speed: '50' }).config['overhang_2_4_speed'] }

function project(dir: string, name: string, settings: Record<string, unknown> = PROJECTS[name]!): string {
  const path = join(dir, `${name}.3mf`)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model('BambuStudio-02.03.00.70') }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
  return path
}

/** Another slicer's project on 0.12 mm layers with its own 0.2 mm support gap. */
function prusaProject(dir: string): string {
  const path = join(dir, 'prusa-gaps.3mf')
  const lines = ['layer_height = 0.12', 'first_layer_height = 0.2', 'support_material = 1', 'support_material_contact_distance = 0.2', 'support_material_bottom_contact_distance = 0.2']
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model('PrusaSlicer-2.9.6') }, { name: 'Metadata/Slic3r_PE.config', data: lines.map((l) => `; ${l}`).join('\n') }]))
  return path
}

async function opened(path: string, printer: string): Promise<Record<string, unknown>> {
  const read = readProjectFile(path)
  await profiles.prepare([`machine:${printer}`])
  const o = await openProject(read, profiles, [`machine:${printer}`], undefined)
  expect(o?.printer).toBe(printer)
  const r = resolveSliceConfig(store, profiles, [`machine:${printer}`], undefined, { project: { name: 'p.3mf', config: read.config, opened: o } })
  // the plate starts from the goal nearest the project's layer height, and slices with what the open gave
  expect(o!.config['layer_height']).toBe(0.12)
  for (const [k, v] of Object.entries(o!.config)) if (k in OWN) expect(r.explicit[k], k).toEqual(v)
  return o!.config
}

describe("a project's own values", () => {
  for (const name of ['listed', 'inherited', 'unlisted']) {
    for (const printer of ['bambu-a1', 'bambu-p1s']) {
      it(`keep on machine:${printer}, ${name}`, async () => {
        const h = await connect()
        const config = await opened(project(h.dir, name), printer)
        for (const [k, v] of Object.entries(OWN)) expect(config[k], k).toEqual(v)
      })
    }
  }

  it('keep on a printer SlicerX has no profile for', async () => {
    const h = await connect()
    const config = await opened(project(h.dir, 'unknown'), 'bambu-a1')
    for (const [k, v] of Object.entries(OWN)) expect(config[k], k).toEqual(v)
  })

  it("leave a value equal to the project printer's layer to the printer the plate moves to", async () => {
    const h = await connect()
    // Our P1S and A1 Fine layers, from a project that holds nothing else.
    const plain = { printer_settings_id: P1S.printer_settings_id, printer_model: P1S.printer_model, nozzle_diameter: ['0.4'], layer_height: '0.12', different_settings_to_system: ['layer_height', '', ''] }
    const onP1s = await opened(project(h.dir, 'plain', plain), 'bambu-p1s')
    const onA1 = await opened(project(h.dir, 'plain', plain), 'bambu-a1')
    const keys = ['default_acceleration', 'elefant_foot_compensation', 'travel_speed', 'hot_plate_temp', 'travel_acceleration', 'outer_wall_acceleration', 'fan_max_speed']
    const k = keys.find((x) => onP1s[x] !== undefined && JSON.stringify(onP1s[x]) !== JSON.stringify(onA1[x]))
    expect(k, 'a key whose P1S and A1 values differ').toBeDefined()
    const v = onP1s[k!]
    const raw = Array.isArray(v) ? v.map(String) : String(v)
    // The project holds the P1S value; on the A1 it slices with the A1's, as the app's move off the project printer gives.
    const config = await opened(project(h.dir, 'p1s-value', { ...plain, [k!]: raw }), 'bambu-a1')
    expect(config[k!], k).toEqual(onA1[k!])
  })

  it("keep in another slicer's project", async () => {
    const h = await connect()
    const config = await opened(prusaProject(h.dir), 'bambu-a1')
    expect(config['support_top_z_distance']).toBe(0.2)
    expect(config['support_bottom_z_distance']).toBe(0.2)
  })
})

describe.skipIf(noSx())('with the real sx CLI', () => {
  it('slices with them on another printer', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    const r = await h.call('slicerx_slice_file', { model: project(h.dir, 'listed'), profiles: ['machine:bambu-a1'], project_settings: true, project_gcode: 'profile' })
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    const jobs = join(h.dir, 'out', 'jobs')
    const job = join(jobs, readdirSync(jobs)[0]!)
    const request = JSON.parse(readFileSync(join(job, 'request.json'), 'utf8')) as { config: Record<string, unknown> }
    for (const [k, v] of Object.entries(OWN)) expect(request.config[k], k).toEqual(v)
    const gcode = readFileSync(join(job, 'slice.gcode'), 'utf8')
    expect(gcode).toMatch(/^; support_top_z_distance = 0\.2$/m)
    expect(gcode).toMatch(/^; support_bottom_z_distance = 0\.2$/m)
  }, sxTimeout)
})
