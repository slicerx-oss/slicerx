// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project keeps one prime tower spot per plate (wipe_tower_x and wipe_tower_y, one entry per plate). An
// opened project's plates each slice with their own spot, the shown plate's tower is its own, and a file whose plate
// numbers leave it open which entry is whose leaves every tower to the engine.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { plateTowerIndexes, projectTowerFrom } from '../src/filament/project-kept'
import { clearProject } from '../src/project/new'
import { startProjectPrinterSync } from '../src/project/project-printer'
import { markClean } from '../src/project/unsaved'
import { switchPlate } from '../src/plate/plates'
import { moveTower } from '../src/plate/tower'
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

/** Each plate's tower spot, as the file's per-plate lists hold them. */
const SPOTS = [{ x: 30, y: 200 }, { x: 180, y: 30 }, { x: 200, y: 180 }]

/** A P1S project with one box per entry of `ids` (its plater_id, in the file's order), on the project's plate grid. */
function project(ids: number[]): ArrayBuffer {
  const cols = Math.ceil(Math.sqrt(ids.length))
  const items = ids.map((_, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${(i % cols) * 256 * 1.2 + 118} ${-Math.floor(i / cols) * 256 * 1.2 + 118} 0"/>`).join('')
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${ids.map((_, i) => cube(i + 1)).join('')}</resources><build>${items}</build></model>`
  const objects = ids.map((_, i) => `<object id="${i + 1}"><metadata key="name" value="Box ${i + 1}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plates = ids.map((id, i) => `<plate><metadata key="plater_id" value="${id}"/><metadata key="plater_name" value="Plate ${id}"/><model_instance><metadata key="object_id" value="${i + 1}"/><metadata key="instance_id" value="0"/></model_instance></plate>`).join('')
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plates}</config>`
  const settings = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printer_model: 'Bambu Lab P1S',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    layer_height: '0.2',
    filament_colour: ['#FFFFFF', '#FF0000'],
    filament_type: ['PLA', 'PLA'],
    enable_prime_tower: '1',
    wipe_tower_x: SPOTS.map((s) => String(s.x)),
    wipe_tower_y: SPOTS.map((s) => String(s.y)),
  }
  const b = zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }])
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** Slots 1 and 2 in use on every plate (the slots a slice uses come from the objects' handles), so a tower is sliced. */
const twoSlots = (): void => {
  const two = <T extends { handle: unknown }>(e: T): T => ({ ...e, handle: { ...(e.handle as object), parts: [{ name: 'a', slot: 1 }, { name: 'b', slot: 2 }] } })
  set((s) => ({ plate: s.plate.map(two), plates: s.plates.map((p) => ({ ...p, objects: p.objects.map(two) })) }))
}

/** The tower keys plate `i` (0-based, in the app's order) slices with. */
function towerOf(i: number): { auto: SettingValue | undefined; x: SettingValue | undefined; y: SettingValue | undefined } {
  const s = get()
  const cfg = plateSliceConfig(s, s.plates[i]) as Record<string, SettingValue | undefined>
  return { auto: cfg['prime_tower_auto_position'], x: cfg['wipe_tower_x'], y: cfg['wipe_tower_y'] }
}

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  clearProject()
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, openNote: null, projectFlush: null, towerFromProject: false, projectTowers: {}, tower: { auto: true, x: 0, y: 0 }, overrides: {}, projectSettings: null, projectPrinter: null, projectOpenAsk: null, printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, slice: { status: 'idle' }, toast: null, goal: 'standard' }))
  await profileReady()
  startProjectPrinterSync()
  markClean()
})

describe("a project's tower spot per plate", () => {
  it('reads the plate\'s own entry of the lists, and one number for every plate', () => {
    const settings = { wipe_tower_x: ['30', '180', '200'], wipe_tower_y: ['200', '30', '180'] }
    expect([0, 1, 2].map((i) => projectTowerFrom(settings, [0, 0], i))).toEqual(SPOTS)
    expect(projectTowerFrom(settings, [0, 0], 3)).toBeNull()
    expect(projectTowerFrom({ wipe_tower_x: 15, wipe_tower_y: '220' }, [5, 10], 2)).toEqual({ x: 10, y: 210 })
  })

  it('maps plates to entries only when the file numbers them 1, 2, 3 in order', () => {
    expect(plateTowerIndexes([1, 2, 3])).toEqual([0, 1, 2])
    expect(plateTowerIndexes([undefined])).toEqual([0])
    // plate 2 taken out by hand, or plates out of order: not certain
    expect(plateTowerIndexes([1, 3])).toEqual([null, null])
    expect(plateTowerIndexes([2, 1, 3])).toEqual([null, null, null])
    expect(plateTowerIndexes([undefined, undefined])).toEqual([null, null])
  })

  it('slices each opened plate with its own spot', async () => {
    const { host } = capture()
    await openModelBytes(host, 'three-towers.3mf', project([1, 2, 3]))
    twoSlots()
    expect(get().plates).toHaveLength(3)
    expect(get().openNote?.text).toContain("Kept the project's prime tower position.")
    expect([0, 1, 2].map(towerOf)).toEqual(SPOTS.map((s) => ({ auto: false, ...s })))
  })

  it('shows and slices the shown plate at its own spot', async () => {
    const { host, requests } = capture()
    await openModelBytes(host, 'three-towers.3mf', project([1, 2, 3]))
    twoSlots()
    expect(get().tower).toEqual({ auto: false, ...SPOTS[0] })
    switchPlate(get().plates[1]!.id)
    expect(get().tower).toEqual({ auto: false, ...SPOTS[1] })
    await slicePlate(host, { auto: true }).catch(() => undefined)
    const cfg = requests.at(-1)?.config as Record<string, SettingValue> | undefined
    expect(cfg?.['wipe_tower_x']).toBe(180)
    expect(cfg?.['wipe_tower_y']).toBe(30)
    switchPlate(get().plates[2]!.id)
    expect(get().tower).toEqual({ auto: false, ...SPOTS[2] })
  })

  it('leaves every tower to the engine when the plate numbers have a gap', async () => {
    const { host } = capture()
    await openModelBytes(host, 'gap.3mf', project([1, 3]))
    twoSlots()
    expect(get().tower.auto).toBe(true)
    expect(get().openNote?.text ?? '').not.toContain('prime tower position')
    expect([0, 1].map((i) => towerOf(i).auto)).toEqual([true, true])
  })

  it('a tower the person moves is every plate\'s', async () => {
    const { host } = capture()
    await openModelBytes(host, 'three-towers.3mf', project([1, 2, 3]))
    twoSlots()
    switchPlate(get().plates[1]!.id)
    moveTower(40, 60)
    expect([0, 1, 2].map(towerOf)).toEqual([0, 1, 2].map(() => ({ auto: false, x: 40, y: 60 })))
    switchPlate(get().plates[2]!.id)
    expect(get().tower).toEqual({ auto: false, x: 40, y: 60 })
  })
})
