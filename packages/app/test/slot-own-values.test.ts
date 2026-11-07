// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slot set by hand to another filament changes that slot's values only. On the A1, slot 2 set to TPU beside a PLA
// slot 1 gave slot 1 TPU's 30 C cool plate and its 200 to 250 C range, because a setting the PLA preset leaves out
// came from the TPU slot. The other slot keeps what it sliced with before, and the TPU slot gets TPU's own values.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'

const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta } = await import('../src/plate/plates')
const { resolveSlots, setSlot } = await import('../src/filament/slots')
const { zip } = await import('../src/export/zip')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const cubeMesh = (s: number) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}

/** A Bambu Studio project for the A1 of two 12 mm PLA cubes, cube k printing with filament k. */
function twoPla(): ArrayBuffer {
  const ids = [0, 1]
  const objects = ids.map((k) => `<object id="${2 * k + 1}" type="model">${cubeMesh(12)}</object><object id="${2 * k + 2}" type="model"><components><component objectid="${2 * k + 1}"/></components></object>`).join('')
  const items = ids.map((k) => `<item objectid="${2 * k + 2}" transform="1 0 0 0 1 0 0 0 1 ${100 + 20 * k} 110 0"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources>${objects}</resources><build>${items}</build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${ids.map((k) => `<object id="${2 * k + 2}"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/><part id="${2 * k + 1}" subtype="normal_part"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/></part></object>`).join('')}<plate><metadata key="plater_id" value="1"/>${ids.map((k) => `<model_instance><metadata key="object_id" value="${2 * k + 2}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], filament_colour: ['#00AE42', '#C12E1F'], filament_type: ['PLA', 'PLA'], layer_height: '0.2', initial_layer_print_height: '0.2' }
  return buf(zip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
const KEYS = ['cool_plate_temp', 'cool_plate_temp_initial_layer', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high', 'filament_type'] as const

async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

/** The slice config's entries of KEYS, slot by slot. */
function sliced(): Record<string, unknown[]> {
  const s = get()
  const cfg = plateSliceConfig(s, activeMeta(s)) as Record<string, unknown>
  return Object.fromEntries(KEYS.map((k) => [k, cfg[k] as unknown[]]))
}

beforeEach(() => {
  startProfileSync()
  startProjectPrinterSync()
})

describe('a slot set by hand to TPU', () => {
  it("leaves the other slot's values as they were and gives the TPU slot its own", async () => {
    set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, printerSlots: [], projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], fileSlotTypes: [], printerId: A1.id, printerModel: A1, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
    await settled()
    await openModelBytes(host, 'two-pla.3mf', twoPla(), undefined, { fresh: true })
    await settled()
    const before = sliced()
    setSlot(2, { type: 'TPU' })
    await settled()
    expect(resolveSlots(get()).map((r) => r.type)).toEqual(['PLA', 'TPU'])
    const after = sliced()
    for (const k of KEYS) expect(after[k]![0], k).toEqual(before[k]![0])
    expect(after['filament_type']).toEqual(['PLA', 'TPU'])
    expect(after['cool_plate_temp']).toEqual([35, 30])
    expect(after['nozzle_temperature_range_low']).toEqual([190, 200])
    expect(after['nozzle_temperature_range_high']).toEqual([240, 250])
  })
})
