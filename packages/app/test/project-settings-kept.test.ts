// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project opened on its own printer slices with the plate type, the prime tower spot and the filament vendors the
// file was saved with. The file names its plate type in curr_bed_type, which picks the bed temperatures; its tower spot
// is in printer coordinates to the thousandth of a millimeter; its filament_vendor names each slot's maker.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { plateBedType } from '../src/plate/bed-type'
import { activeMeta } from '../src/plate/plates'
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

/** A one plate P1S project with two boxes, one per filament, and `extra` in its project settings. */
function project(extra: Record<string, unknown>): ArrayBuffer {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${cube(1)}${cube(2)}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 90 118 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 140 118 0"/></build></model>`
  const objects = [1, 2].map((i) => `<object id="${i}"><metadata key="name" value="Box ${i}"/><metadata key="extruder" value="${i}"/></object>`).join('')
  const plate = '<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Plate 1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate>'
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>`
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
  const b = zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }])
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** Slots 1 and 2 in use (the slots a slice uses come from the objects' handles), so the tower and vendors are sliced. */
const twoSlots = (): void => {
  const two = <T extends { handle: unknown }>(e: T, i: number): T => ({ ...e, handle: { ...(e.handle as object), parts: [{ name: 'a', slot: i + 1 }] } })
  set((s) => ({ plate: s.plate.map(two), plates: s.plates.map((p) => ({ ...p, objects: p.objects.map(two) })) }))
}

/** Opens `bytes` the way the app does and returns the config of the slice request it sends. */
async function sliced(bytes: ArrayBuffer): Promise<Record<string, SettingValue>> {
  const { host, requests } = capture()
  await openModelBytes(host, 'kept.3mf', bytes)
  twoSlots()
  await slicePlate(host, { auto: true }).catch(() => undefined)
  const cfg = requests.at(-1)?.config as Record<string, SettingValue> | undefined
  expect(cfg).toBeDefined()
  return cfg!
}

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  clearProject()
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, openNote: null, projectFlush: null, towerFromProject: false, projectTowers: {}, tower: { auto: true, x: 0, y: 0 }, overrides: {}, projectSettings: null, projectPrinter: null, projectOpenAsk: null, printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, slice: { status: 'idle' }, toast: null, goal: 'standard' }))
  await profileReady()
  startProjectPrinterSync()
  markClean()
})

describe("an opened project's own plate type, tower spot and filament vendors", () => {
  it('reach the slice request as the file has them', async () => {
    const cfg = await sliced(project({
      curr_bed_type: 'Textured PEI Plate',
      wipe_tower_x: ['165.375'],
      wipe_tower_y: ['211.626'],
      filament_vendor: ['Bambu Lab', 'Polymaker'],
    }))
    expect.soft(cfg['curr_bed_type']).toBe('Textured PEI Plate')
    expect.soft(cfg['prime_tower_auto_position']).toBe(false)
    expect.soft(cfg['wipe_tower_x']).toBe(165.375)
    expect.soft(cfg['wipe_tower_y']).toBe(211.626)
    expect.soft(cfg['filament_vendor']).toEqual(['Bambu Lab', 'Polymaker'])
    // the plate card names the project's plate type
    expect(plateBedType(activeMeta(get()), plateSliceConfig(get(), activeMeta(get())) as Record<string, unknown>)).toMatchObject({ value: 'textured-pei', source: 'settings' })
  })

  it("keeps every plate type the file names, and leaves Default Plate to the printer's", async () => {
    for (const plate of ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured Cool Plate', 'Supertack Plate']) {
      clearProject()
      expect((await sliced(project({ curr_bed_type: plate })))['curr_bed_type'], plate).toBe(plate)
    }
    clearProject()
    // the P1S profile names no default plate, so smooth PEI, the engine's High Temp Plate
    expect((await sliced(project({ curr_bed_type: 'Default Plate' })))['curr_bed_type']).toBe('High Temp Plate')
  })

  it("lets a plate type set on the plate win over the project's", async () => {
    await sliced(project({ curr_bed_type: 'Textured PEI Plate' }))
    set((s) => ({ plates: s.plates.map((p) => ({ ...p, settings: { ...p.settings, bedType: 'cool' as const } })) }))
    expect(plateSliceConfig(get(), activeMeta(get()))['curr_bed_type' as never]).toBe('Cool Plate')
  })

  it("drops a slot's maker once the person sets that slot, and New project forgets them", async () => {
    await sliced(project({ filament_vendor: ['Bambu Lab', 'Polymaker'] }))
    set({ slotSetup: { 2: { type: 'PETG', brand: '', color: '#00ff00' } } })
    expect(plateSliceConfig(get(), activeMeta(get()))['filament_vendor' as never]).toEqual(['Bambu Lab', '(Undefined)'])
    clearProject()
    expect(get().fileSlotVendors).toEqual([])
  })
})
