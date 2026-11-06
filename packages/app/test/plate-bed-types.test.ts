// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's plates each keep their own plate type. The file names a plate's in its <plate> entry of
// Metadata/model_settings.config (`bed_type`, or `curr_bed_type` in a file SlicerX saved); it wins over the project's
// `curr_bed_type` and the printer's default, and each plate's slice request carries its own.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { plateBedType } from '../src/plate/bed-type'
import { activeMeta, switchPlate } from '../src/plate/plates'
import { clearProject } from '../src/project/new'
import { startProjectPrinterSync } from '../src/project/project-printer'
import { markClean } from '../src/project/unsaved'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { plateSliceConfig } from '../src/state/slice-plate'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })

/** A host whose slice records the request and then stops. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, printers: { list: async () => [] }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async (name: string) => handle(name) } } as unknown as Host
  return { host, requests }
}

function cube(id: number): string {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" name="Box ${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/**
 * A P1S project with one box on each of its plates; `plates[i]` is plate i + 1's own metadata (such as
 * `{ bed_type: 'Cool Plate' }`), and `extra` goes in its project settings.
 */
function platesProject(plates: Record<string, string>[], extra: Record<string, unknown> = {}): Uint8Array {
  const ids = plates.map((_, i) => i + 1)
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${ids.map(cube).join('')}</resources><build>${ids.map((id) => `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${118 + (id - 1) * 307.2} 118 0"/>`).join('')}</build></model>`
  const objects = ids.map((i) => `<object id="${i}"><metadata key="name" value="Box ${i}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plateXml = plates.map((own, i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="Plate ${i + 1}"/><metadata key="locked" value="false"/>${Object.entries(own).map(([k, v]) => `<metadata key="${k}" value="${v}"/>`).join('')}<model_instance><metadata key="object_id" value="${i + 1}"/><metadata key="instance_id" value="0"/></model_instance></plate>`).join('')
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plateXml}</config>`
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
  return zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }])
}

const buffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** Opens `bytes` the way the app does, then slices each plate in turn and returns each request's `curr_bed_type`. */
async function plateTypes(bytes: Uint8Array): Promise<(SettingValue | undefined)[]> {
  const { host, requests } = capture()
  await openModelBytes(host, 'plates.3mf', buffer(bytes))
  const out: (SettingValue | undefined)[] = []
  for (const p of get().plates) {
    switchPlate(p.id)
    const before = requests.length
    await slicePlate(host, { auto: true }).catch(() => undefined)
    expect(requests.length, p.name).toBe(before + 1)
    out.push((requests.at(-1)!.config as Record<string, SettingValue>)['curr_bed_type'])
  }
  return out
}

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  clearProject()
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, openNote: null, projectFlush: null, towerFromProject: false, projectTowers: {}, tower: { auto: true, x: 0, y: 0 }, overrides: {}, projectSettings: null, projectPrinter: null, projectOpenAsk: null, printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, slice: { status: 'idle' }, toast: null, goal: 'standard' }))
  await profileReady()
  startProjectPrinterSync()
  markClean()
})

describe("each plate of a project slices on its own plate type", () => {
  it('two plates on different plate types each send their own', async () => {
    const types = await plateTypes(platesProject([{ bed_type: 'Cool Plate' }, { bed_type: 'Textured Cool Plate' }], { curr_bed_type: 'Textured PEI Plate' }))
    expect(types).toEqual(['Cool Plate', 'Textured Cool Plate'])
    // the plate card names each plate's own
    const [one, two] = get().plates
    expect(plateBedType(one, plateSliceConfig(get(), one) as Record<string, unknown>)).toMatchObject({ value: 'cool', source: 'plate' })
    expect(plateBedType(two, plateSliceConfig(get(), two) as Record<string, unknown>)).toMatchObject({ value: 'textured-cool', source: 'plate' })
  })

  it("leaves a plate without its own to the project's, and reads the spelling SlicerX saves", async () => {
    const types = await plateTypes(platesProject([{ curr_bed_type: 'Supertack Plate' }, {}, { bed_type: 'Default Plate' }], { curr_bed_type: 'Engineering Plate' }))
    expect(types).toEqual(['Supertack Plate', 'Engineering Plate', 'Engineering Plate'])
  })

  it("wins over the printer's default when the project names none", async () => {
    // the P1S profile names no default plate, so a plate with none prints on the High Temp Plate
    const types = await plateTypes(platesProject([{ bed_type: 'SuperTack Plate' }, {}]))
    expect(types).toEqual(['Supertack Plate', 'High Temp Plate'])
    expect(activeMeta(get())?.settings.bedType).toBeUndefined()
    expect(get().plates[0]!.settings.bedType).toBe('supertack')
  })
})
