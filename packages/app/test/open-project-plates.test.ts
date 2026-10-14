// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project with many named plates opens with the file's plates as they are: the first plate keeps its
// name (it showed as "Plate 1"), an empty plate between full ones stays, so plate N is plate N in the file, and every
// object lands on the plate that lists it. The agent bridge's app_state reads the same plates back.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { appState } from '../src/agent-bridge/page'
import { zip } from '../src/export/zip'
import { answerOpenProject } from '../src/project/open-ask'
import { allPlates } from '../src/plate/plates'
import { startProjectPrinterSync } from '../src/project/project-printer'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

function cube(id: string, name: string): string {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" name="${name}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const AREA = ['0x0', '256x0', '256x256', '0x256']

/** The plates of the reported deck box project in small: listed in their own order, one empty, one with two objects. */
const PLATES: [string, string[]][] = [
  ['Deck Box Bottom', ['23']],
  ['Deck Box Top', ['21']],
  ['Connectors', ['7', '8']],
  ['Insert Button', []],
  ['Colored Buttons', ['2', '3']],
]
const NAMES: Record<string, string> = { '2': 'Button A', '3': 'Button B', '7': 'Connector 1', '8': 'Connector 2', '21': 'Top', '23': 'Bottom' }

function deckBoxLike(): ArrayBuffer {
  const ids = Object.keys(NAMES).sort((a, b) => Number(a) - Number(b))
  const items = ids.map((id, i) => `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${40 + 30 * (i % 4)} ${60 + 40 * Math.floor(i / 4)} 0"/>`).join('')
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${ids.map((id) => cube(id, NAMES[id]!)).join('')}</resources><build>${items}</build></model>`
  const objects = ids.map((id) => `<object id="${id}"><metadata key="name" value="${NAMES[id]}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plates = PLATES.map(
    ([name, on], i) =>
      `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="${name}"/><metadata key="locked" value="false"/><metadata key="thumbnail_file" value="Metadata/plate_${i + 1}.png"/>${on.map((o) => `<model_instance><metadata key="object_id" value="${o}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`,
  ).join('')
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plates}</config>`
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], printable_area: AREA, layer_height: '0.2', filament_colour: ['#000000'] }
  return buf(zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

const A1_MINI = { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], printerId: A1_MINI.id, printerModel: A1_MINI, printerNozzles: {}, nozzleReported: {}, toast: null, unsavedPrompt: null }))
  await profileReady()
  startProjectPrinterSync()
  startDirtyTracking()
  markClean()
})

describe('a multi-plate Bambu Studio project', () => {
  it('opens with the file plates in order, each named, with its own objects', async () => {
    await openModelBytes(host, 'Deck Box.3mf', deckBoxLike(), undefined, { fresh: true })
    const plates = allPlates()
    expect(plates.map((p) => p.name)).toEqual(PLATES.map(([name]) => name))
    expect(plates.map((p) => p.objects.map((o) => o.name))).toEqual(PLATES.map(([, on]) => on.map((id) => NAMES[id])))
    expect(get().activePlate).toBe(plates[0]!.id)
  })

  it('reads back the same plates through app_state', async () => {
    await openModelBytes(host, 'Deck Box.3mf', deckBoxLike(), undefined, { fresh: true })
    const plate = appState(get())['plate'] as { plates: { name: string; objects: number }[] }
    expect(plate.plates.map(({ name, objects }) => ({ name, objects }))).toEqual(PLATES.map(([name, on]) => ({ name, objects: on.length })))
  })

  it('opened again onto its own plates as geometry, adds only the plates with objects', async () => {
    await openModelBytes(host, 'Deck Box.3mf', deckBoxLike(), undefined, { fresh: true })
    const opening = openModelBytes(host, 'Deck Box.3mf', deckBoxLike())
    // The open asks: the whole project in this one's place, or its geometry alone.
    await expect.poll(() => get().projectOpenAsk).not.toBeNull()
    answerOpenProject('geometry')
    await opening
    const names = allPlates().map((p) => p.name)
    expect(names.slice(0, PLATES.length)).toEqual(PLATES.map(([name]) => name))
    expect(names.slice(PLATES.length)).toEqual(['Deck Box Top', 'Connectors', 'Colored Buttons'])
  })
})
