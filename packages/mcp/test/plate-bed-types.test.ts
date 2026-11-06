// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's plates each slice on their own plate type through the MCP server, as the app opens them
// (packages/app/test/plate-bed-types.test.ts): a plate's `bed_type` in Metadata/model_settings.config wins over the
// project's `curr_bed_type` and the printer's default.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, text } from './helpers'

function cube(id: number): string {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" name="Box ${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** A P1S project with one box on each plate, `plates[i]` plate i + 1's own metadata, `extra` in its project settings. */
function project(path: string, plates: Record<string, string>[], extra: Record<string, unknown> = {}): string {
  const ids = plates.map((_, i) => i + 1)
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${ids.map(cube).join('')}</resources><build>${ids.map((id) => `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${118 + (id - 1) * 307.2} 118 0"/>`).join('')}</build></model>`
  const objects = ids.map((i) => `<object id="${i}"><metadata key="name" value="Box ${i}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plateXml = plates.map((own, i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="Plate ${i + 1}"/>${Object.entries(own).map(([k, v]) => `<metadata key="${k}" value="${v}"/>`).join('')}<model_instance><metadata key="object_id" value="${i + 1}"/><metadata key="instance_id" value="0"/></model_instance></plate>`).join('')
  const settings = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printer_model: 'Bambu Lab P1S',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    layer_height: '0.2',
    filament_colour: ['#FFFFFF'],
    filament_type: ['PLA'],
    ...extra,
  }
  writeFileSync(path, writeZip([
    { name: '3D/3dmodel.model', data: main },
    { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plateXml}</config>` },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) },
  ]))
  return path
}

/** The `curr_bed_type` of the request slicerx_slice_file sends for each of `plates`, with `profiles`. */
async function plateTypes(plates: Record<string, string>[], extra: Record<string, unknown>, profiles: string[]): Promise<unknown[]> {
  const h = await connect()
  const model = project(join(h.dir, 'plates.3mf'), plates, extra)
  // The stub engine reads STL only, so it refuses the 3MF once it has the request; the request is what counts here.
  const slice = vi.spyOn(h.ctx.slicer!, 'slice')
  const out: unknown[] = []
  for (const plate of plates.map((_, i) => i + 1)) {
    const before = slice.mock.calls.length
    const r = await h.call('slicerx_slice_file', { model, plate, profiles, project_settings: true })
    expect(slice.mock.calls.length, text(r)).toBe(before + 1)
    out.push((slice.mock.calls.at(-1)![0].config as Record<string, unknown>)['curr_bed_type'])
  }
  return out
}

describe("each plate of a project slices on its own plate type", () => {
  it('on the project\'s own printer, two plates on different plate types', async () => {
    expect(await plateTypes([{ bed_type: 'Cool Plate' }, { bed_type: 'Textured Cool Plate' }], { curr_bed_type: 'Textured PEI Plate' }, ['machine:bambu-p1s'])).toEqual(['Cool Plate', 'Textured Cool Plate'])
  })

  it('with no printer named, on the project\'s own settings', async () => {
    expect(await plateTypes([{ bed_type: 'Supertack Plate' }, {}], { curr_bed_type: 'Engineering Plate' }, [])).toEqual(['Supertack Plate', 'Engineering Plate'])
  })

  it("leaves a plate with Default Plate or none to the project's, and reads the spelling SlicerX saves", async () => {
    expect(await plateTypes([{ curr_bed_type: 'SuperTack Plate' }, { bed_type: 'Default Plate' }, {}], { curr_bed_type: 'Engineering Plate' }, ['machine:bambu-p1s'])).toEqual(['Supertack Plate', 'Engineering Plate', 'Engineering Plate'])
  })

  it('lists each plate\'s own plate type in slicerx_inspect_project', async () => {
    const h = await connect()
    const model = project(join(h.dir, 'inspect.3mf'), [{ bed_type: 'Textured Cool Plate' }, {}, { bed_type: 'Default Plate' }])
    const r = await h.call('slicerx_inspect_project', { file: model })
    expect(r.isError, text(r)).toBeFalsy()
    const plates = data<{ plates: { index: number; bed_type?: string }[] }>(r).plates
    expect(plates.map((p) => p.bed_type)).toEqual(['Textured Cool Plate', undefined, undefined])
  })
})
