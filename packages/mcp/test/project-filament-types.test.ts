// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Another slicer's project opens with the filament type its file names for each slot (filament_type), as the app's
// project open does: a PETG or TPU slot slices on the printer's PETG or TPU filament under the project's own values,
// not on PLA. A slot the file names no type for stays PLA. packages/app/test/project-route-parity.test.ts checks the
// G-code against the app's to the byte.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DataStore, resolveDataPaths } from '../src/data'
import { ProfileCatalog } from '../src/profiles'
import { openProject } from '../src/project-open'
import { readProjectFile } from '../src/projectfile'
import { writeZip } from '../src/zip'

const store = new DataStore(resolveDataPaths())
const profiles = new ProfileCatalog(store)
const prusa = resolve(__dirname, '../../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')
const dir = mkdtempSync(join(tmpdir(), 'project-filament-types-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const cubeMesh = (s: number) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}

/** A Bambu Studio project for the A1 of one 12 mm cube per filament in `types`, cube k printing with filament k. */
function a1Project(name: string, types: string[]): string {
  const ids = types.map((_, k) => k)
  const objects = ids.map((k) => `<object id="${2 * k + 1}" type="model">${cubeMesh(12)}</object><object id="${2 * k + 2}" type="model"><components><component objectid="${2 * k + 1}"/></components></object>`).join('')
  const items = ids.map((k) => `<item objectid="${2 * k + 2}" transform="1 0 0 0 1 0 0 0 1 ${100 + 20 * k} 110 0"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources>${objects}</resources><build>${items}</build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${ids.map((k) => `<object id="${2 * k + 2}"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/><part id="${2 * k + 1}" subtype="normal_part"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/></part></object>`).join('')}<plate><metadata key="plater_id" value="1"/>${ids.map((k) => `<model_instance><metadata key="object_id" value="${2 * k + 2}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], filament_colour: ['#00AE42', '#C12E1F'].slice(0, types.length), filament_type: types, layer_height: '0.2', initial_layer_print_height: '0.2' }
  const path = join(dir, name)
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
  return path
}

async function opened(path: string, printer: string) {
  await profiles.prepare([printer])
  const o = await openProject(readProjectFile(path), profiles, [printer], undefined)
  expect(o).toBeDefined()
  return o!.config as Record<string, unknown>
}

describe("an opened project's filament types", () => {
  it('slices a PETG project on PETG', async () => {
    const cfg = await opened(a1Project('petg.3mf', ['PETG']), 'machine:bambu-a1')
    expect(cfg['filament_type']).toEqual(['PETG'])
  })

  it('slices the TPU slot of a PLA and TPU project on TPU', async () => {
    const cfg = await opened(a1Project('pla-tpu.3mf', ['PLA', 'TPU']), 'machine:bambu-a1')
    expect(cfg['filament_type']).toEqual(['PLA', 'TPU'])
  })

  it("slices a PrusaSlicer project's PETG on PETG", async () => {
    const cfg = await opened(prusa, 'machine:prusa-mk4')
    expect(cfg['filament_type']).toEqual(['PETG'])
  })

  it('keeps PLA for a slot the file names no type for', async () => {
    const cfg = await opened(a1Project('unnamed.3mf', ['PETG', '']), 'machine:bambu-a1')
    expect(cfg['filament_type']).toEqual(['PETG', 'PLA'])
  })
})
