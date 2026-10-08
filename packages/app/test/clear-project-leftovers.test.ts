// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Clearing the plate clears the old job: every plate, the project's printer and the settings it brought, so the next
// file opens on its own. After tangela.3mf (a P1S project on two plates) was cleared, its "Bambu - Charcoal" plate
// stayed and the next m.3mf showed tangela's raft_first_layer_expansion error.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { startProjectPrinterSync } from '../src/project/project-printer'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { clearPlate, openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

function cube(id: string): string {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const AREA = ['0x0', '256x0', '256x256', '0x256']

/** tangela.3mf's shape: a P1S project with one object on each of two plates, the second named "Bambu - Charcoal". */
function tangelaLike(): ArrayBuffer {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube('1')}${cube('2')}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 407 100 0"/></build></model>`
  const cfg = '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="Part_13"/><metadata key="extruder" value="2"/></object><object id="2"><metadata key="name" value="Part_1"/><metadata key="extruder" value="4"/></object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Bambu - Marine Blue"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Bambu - Charcoal"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>'
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], printable_area: AREA, layer_height: '0.16', wall_loops: '5', raft_first_layer_expansion: '-1', filament_colour: ['#000000', '#0078BF', '#DE4343', '#FFFFFF'] }
  return buf(zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

/** m.3mf's shape: one object, for a printer SlicerX has no profile for. */
function mLike(): ArrayBuffer {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube('1')}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 80 80 0"/></build></model>`
  const settings = { printer_model: 'bench machine', printable_area: AREA, filament_colour: ['#00AE42'] }
  return buf(zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', overrides: { wall_loops: 2 }, vouchedGcode: {}, projectGcode: null, projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, toast: null, unsavedPrompt: null }))
  await profileReady()
  startProjectPrinterSync()
  startDirtyTracking()
  markClean()
})

describe('clearing the plate after a project', () => {
  it('takes its plates, printer and settings with it, and gives back what the person had', async () => {
    await openModelBytes(host, 'tangela.3mf', tangelaLike(), undefined, { fresh: true })
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Bambu - Charcoal'])
    expect(get().projectPrinter).not.toBeNull()
    expect(get().overrides).toMatchObject({ wall_loops: 5, layer_height: 0.16 })
    clearPlate()
    const s = get()
    expect(s.plate).toEqual([])
    expect(s.plates.map((p) => [p.name, p.objects.length])).toEqual([['Plate 1', 0]])
    expect(s.projectPrinter).toBeNull()
    expect(s.projectSettings).toBeNull()
    expect(s.printerId).toBe(A1_MINI.id)
    expect(s.fileSlotColors).toEqual([])
    expect(s.overrides).not.toHaveProperty('raft_first_layer_expansion')
    expect(s.overrides).not.toHaveProperty('layer_height')
    // The person's own wall count from before the project is back.
    expect(s.overrides['wall_loops']).toBe(2)
  })

  it('then opens the next project alone, with none of the old one', async () => {
    await openModelBytes(host, 'tangela.3mf', tangelaLike(), undefined, { fresh: true })
    clearPlate()
    // Add model onto the cleared plate, as the report did it.
    await openModelBytes(host, 'm.3mf', mLike())
    const s = get()
    expect(s.plates).toHaveLength(1)
    expect(s.plate.map((e) => e.name)).toEqual(['Part'])
    expect(s.overrides).not.toHaveProperty('raft_first_layer_expansion')
    expect(s.fileSlotColors).toEqual(['#00AE42'])
    expect(s.projectSettings?.source ?? 'm.3mf').toBe('m.3mf')
  })

  it('drops what a project for a printer SlicerX has no profile for brought, too', async () => {
    const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube('1')}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 80 80 0"/></build></model>`
    const bytes = zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_model: 'bench machine', printable_area: AREA, wall_loops: '4', sparse_infill_density: '35%' }) }])
    await openModelBytes(host, 'bench.3mf', buf(bytes), undefined, { fresh: true })
    expect(get().projectPrinter).toBeNull()
    expect(get().overrides['wall_loops']).toBe(4)
    clearPlate()
    expect(get().overrides['wall_loops']).toBe(2)
    expect(get().overrides).not.toHaveProperty('sparse_infill_density')
  })
})

describe('a project onto plates the person emptied by hand', () => {
  it('leaves the old project behind first', async () => {
    await openModelBytes(host, 'tangela.3mf', tangelaLike(), undefined, { fresh: true })
    // Every object deleted, plate by plate: the plates and the project's settings are still there.
    set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })) }))
    expect(get().plates).toHaveLength(2)
    await openModelBytes(host, 'm.3mf', mLike())
    const s = get()
    expect(s.plates.map((p) => p.name)).toEqual(['Plate 1'])
    expect(s.plate.map((e) => e.name)).toEqual(['Part'])
    expect(s.projectPrinter).toBeNull()
    expect(s.overrides).not.toHaveProperty('raft_first_layer_expansion')
    expect(s.overrides['wall_loops']).toBe(2)
  })
})
