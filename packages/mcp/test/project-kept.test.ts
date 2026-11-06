// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project slice on the project's own printer keeps what the file names for its plate type, its prime tower spot and
// its filament makers, as the app's project open does (packages/app/test/project-settings-kept.test.ts).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
const dir = mkdtempSync(join(tmpdir(), 'project-kept-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function cube(id: number): string {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" name="Box ${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** A one plate P1S project with two boxes, one per filament, written to `name` with `extra` in its project settings. */
function project(name: string, extra: Record<string, unknown>): string {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${cube(1)}${cube(2)}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 90 118 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 140 118 0"/></build></model>`
  const objects = [1, 2].map((i) => `<object id="${i}"><metadata key="name" value="Box ${i}"/><metadata key="extruder" value="${i}"/></object>`).join('')
  const plate = '<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Plate 1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate>'
  const settings = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printer_model: 'Bambu Lab P1S',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    layer_height: '0.2',
    filament_colour: ['#FFFFFF', '#FF0000'],
    filament_type: ['PLA', 'PLA'],
    enable_prime_tower: '1',
    ...extra,
  }
  const path = join(dir, name)
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: main },
    { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>` },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) },
  ]))
  return path
}

describe("a project slice keeps the file's plate type, tower spot and filament makers", () => {
  it('on the project\'s own printer', async () => {
    const read = readProjectFile(project('kept.3mf', { curr_bed_type: 'Textured PEI Plate', wipe_tower_x: ['165.375'], wipe_tower_y: ['211.626'], filament_vendor: ['Bambu Lab', 'Polymaker'] }))
    await profiles.prepare(['machine:bambu-p1s'])
    const opened = await openProject(read, profiles, ['machine:bambu-p1s'], 0.4)
    expect(opened?.printer).toBe('bambu-p1s')
    expect(opened!.config['curr_bed_type']).toBe('Textured PEI Plate')
    expect(opened!.config['prime_tower_auto_position']).toBe(false)
    expect(opened!.config['wipe_tower_x']).toBe(165.375)
    expect(opened!.config['wipe_tower_y']).toBe(211.626)
    expect(opened!.config['filament_vendor']).toEqual(['Bambu Lab', 'Polymaker'])
  })

  it("leaves Default Plate to the printer's default", async () => {
    const read = readProjectFile(project('default.3mf', { curr_bed_type: 'Default Plate' }))
    await profiles.prepare(['machine:bambu-p1s'])
    const opened = await openProject(read, profiles, ['machine:bambu-p1s'], 0.4)
    expect(opened!.config['curr_bed_type']).toBe('High Temp Plate')
    expect(opened!.config['filament_vendor']).toEqual(['(Undefined)', '(Undefined)'])
  })
})
