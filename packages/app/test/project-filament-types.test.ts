// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Another slicer's project opens with the filament type its file names for each slot (filament_type): a PETG or TPU
// slot shows and slices as PETG or TPU, on the printer's own filament of that type under the project's values, not
// as PLA. A slot the file names no type for stays PLA, and a type set by hand wins over the file's. The MCP server's
// project open does the same (packages/mcp/test/project-filament-types.test.ts).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'

const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta } = await import('../src/plate/plates')
const { resolveSlots, setSlot } = await import('../src/filament/slots')
const { clearProject } = await import('../src/project/new')
const { zip } = await import('../src/export/zip')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const prusa = resolve(__dirname, '../../settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')

const cubeMesh = (s: number) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}

/** A Bambu Studio project for the A1 of one 12 mm cube per filament in `types`, cube k printing with filament k. */
function a1Project(types: string[]): ArrayBuffer {
  const ids = types.map((_, k) => k)
  const objects = ids.map((k) => `<object id="${2 * k + 1}" type="model">${cubeMesh(12)}</object><object id="${2 * k + 2}" type="model"><components><component objectid="${2 * k + 1}"/></components></object>`).join('')
  const items = ids.map((k) => `<item objectid="${2 * k + 2}" transform="1 0 0 0 1 0 0 0 1 ${100 + 20 * k} 110 0"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources>${objects}</resources><build>${items}</build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${ids.map((k) => `<object id="${2 * k + 2}"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/><part id="${2 * k + 1}" subtype="normal_part"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/></part></object>`).join('')}<plate><metadata key="plater_id" value="1"/>${ids.map((k) => `<model_instance><metadata key="object_id" value="${2 * k + 2}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], filament_colour: ['#00AE42', '#C12E1F'].slice(0, types.length), filament_type: types, layer_height: '0.2', initial_layer_print_height: '0.2' }
  return buf(zip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
const MK4 = { id: 'my-mk4', vendor: 'Prusa Research', model: 'MK4' }

/** Waits for the printer layer the store writes ask for, and the ones those builds start in turn. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

/** `data` opened on a fresh plate with `printer` selected: the slots' types, and the types the plate slices with. */
async function open(name: string, data: ArrayBuffer, printer: typeof A1): Promise<{ slots: string[]; sliced: unknown }> {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slotSetup: {}, printerSlots: [], projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], fileSlotTypes: [], printerId: printer.id, printerModel: printer, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
  await settled()
  await openModelBytes(host, name, data, undefined, { fresh: true })
  await settled()
  const s = get()
  return { slots: resolveSlots(s).map((r) => r.type), sliced: (plateSliceConfig(s, activeMeta(s)) as Record<string, unknown>)['filament_type'] }
}

beforeEach(() => {
  startProfileSync()
  startProjectPrinterSync()
})

describe("an opened project's filament types", () => {
  it('opens a PETG project as PETG', async () => {
    const r = await open('petg.3mf', a1Project(['PETG']), A1)
    expect(r.slots).toEqual(['PETG'])
    expect(r.sliced).toEqual(['PETG'])
  })

  it('opens the TPU slot of a PLA and TPU project as TPU', async () => {
    const r = await open('pla-tpu.3mf', a1Project(['PLA', 'TPU']), A1)
    expect(r.slots).toEqual(['PLA', 'TPU'])
    expect(r.sliced).toEqual(['PLA', 'TPU'])
  })

  it("opens a PrusaSlicer project's PETG as PETG", async () => {
    const r = await open('prusaslicer-2.9.6.3mf', buf(readFileSync(prusa)), MK4)
    expect(r.slots[0]).toBe('PETG')
    expect(r.sliced).toEqual(['PETG'])
  })

  it('keeps PLA for a slot the file names no type for', async () => {
    const r = await open('unnamed.3mf', a1Project(['PETG', '']), A1)
    expect(r.slots).toEqual(['PETG', 'PLA'])
  })

  it("keeps a type set by hand over the file's, and a new project drops the file's", async () => {
    await open('pla-tpu.3mf', a1Project(['PLA', 'TPU']), A1)
    expect(get().fileSlotTypes).toEqual(['PLA', 'TPU'])
    setSlot(2, { type: 'PETG' })
    expect(resolveSlots(get()).map((r) => r.type)).toEqual(['PLA', 'PETG'])
    clearProject()
    expect(get().fileSlotTypes).toEqual([])
  })
})
