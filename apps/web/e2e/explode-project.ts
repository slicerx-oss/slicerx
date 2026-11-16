// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small 3MF project for the exploded view, made from our own boxes, in the layout the project reader imports
// (components in a separate model file, parts listed in model_settings.config, the Application tag it reads): one object of three parts that sit
// together (a base, a post standing on it and a cap on the post), each on its own filament, and a single box beside it.
import type { Page } from '@playwright/test'
import { expect } from './fixtures'
import { openModel, setState } from './journeys/lib/model'
import { zip } from './project-zip'

const ns = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'

/** A box from the origin to (x, y, z), as a mesh object. */
function box(id: number, [x, y, z]: [number, number, number]): string {
  const v = Array.from({ length: 8 }, (_, i) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0])
  const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([a, b, c]) => `<vertex x="${a}" y="${b}" z="${c}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** The parts: size, and where the component puts them in the object's space. */
const PARTS: { name: string; size: [number, number, number]; at: [number, number, number] }[] = [
  { name: 'Base', size: [40, 40, 6], at: [0, 0, 0] },
  { name: 'Post', size: [12, 12, 24], at: [14, 14, 6] },
  { name: 'Cap', size: [24, 24, 5], at: [8, 8, 30] },
]

export const ASSEMBLY = 'Lamp stand'
export const SINGLE = 'Spacer'

export function explodeProject(): Buffer {
  const meshes = PARTS.map((p, i) => box(i + 1, p.size)).join('') + box(4, [16, 16, 10])
  const parts = PARTS.map((p, i) => `<component p:path="/3D/Objects/object_1.model" objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${p.at.join(' ')}"/>`).join('')
  const objects = `<object id="10" type="model"><components>${parts}</components></object><object id="20" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="4"/></components></object>`
  const items = '<item objectid="10" transform="1 0 0 0 1 0 0 0 1 108 108 0" printable="1"/><item objectid="20" transform="1 0 0 0 1 0 0 0 1 170 110 0" printable="1"/>'
  const settings =
    `<object id="10"><metadata key="name" value="${ASSEMBLY}"/><metadata key="extruder" value="1"/>` +
    PARTS.map((p, i) => `<part id="${i + 1}" subtype="normal_part"><metadata key="name" value="${p.name}"/><metadata key="extruder" value="${i + 1}"/></part>`).join('') +
    `</object><object id="20"><metadata key="name" value="${SINGLE}"/><metadata key="extruder" value="1"/><part id="4" subtype="normal_part"><metadata key="name" value="${SINGLE}"/><metadata key="extruder" value="1"/></part></object>`
  const plate = '<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Plate 1"/><metadata key="locked" value="false"/><model_instance><metadata key="object_id" value="10"/><metadata key="instance_id" value="0"/></model_instance><model_instance><metadata key="object_id" value="20"/><metadata key="instance_id" value="0"/></model_instance></plate>'
  const project = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printer_model: 'Bambu Lab P1S',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    layer_height: '0.2',
    filament_colour: ['#E8E4DA', '#2F80ED', '#F2994A'],
    filament_type: ['PLA', 'PLA', 'PLA'],
  }
  return zip({
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${ns}><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${objects}</resources><build>${items}</build></model>`,
    '3D/Objects/object_1.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${ns}><resources>${meshes}</resources><build/></model>`,
    'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${settings}${plate}</config>`,
    'Metadata/project_settings.config': JSON.stringify(project),
  })
}

type Entry = { id: string; name: string; parts: unknown[]; transform: number[] }
export type ExplodeState = { plate: Entry[]; explode: { spread: number; axis: string }; selection: string | null; selectedIds: string[] }
type Sx = { getState(): ExplodeState }
type Vp = { exploded(): Record<string, number[][]>; drawnObjects(): string[] }

export const appState = (page: Page): Promise<ExplodeState> => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
export const exploded = (page: Page): Promise<Record<string, number[][]>> => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.exploded())

/** Opens the project and selects the assembly; answers the two objects' ids. */
export async function openAssembly(page: Page): Promise<{ assembly: string; single: string }> {
  await setState(page, { autoSlice: false })
  await openModel(page, { name: 'Lamp stand.3mf', mimeType: 'model/3mf', buffer: explodeProject() }, { asProject: true })
  const s = await appState(page)
  const assembly = s.plate.find((p) => p.name === ASSEMBLY)
  const single = s.plate.find((p) => p.name === SINGLE)
  expect(assembly?.parts).toHaveLength(3)
  expect(single?.parts).toHaveLength(1)
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: Vp }).__vp.drawnObjects().includes(id), assembly!.id)).toBe(true)
  await setState(page, { selection: assembly!.id, selectedIds: [assembly!.id] })
  return { assembly: assembly!.id, single: single!.id }
}
