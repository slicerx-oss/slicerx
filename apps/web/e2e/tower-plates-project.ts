// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small Bambu-style project with three plates and a prime tower spot of its own on each, made from our own boxes. A
// project keeps one wipe_tower_x and wipe_tower_y entry per plate. Each plate holds one object of two stacked boxes, the
// lower one on filament 1 and the upper one on filament 2, so a prime tower is needed on every plate. The settings are a
// P1S's: a 256 mm bed and a 35 mm wide tower.
import { zip } from './project-zip'

/** Each plate's tower spot (the front left corner, mm), in the order of the file's plates. */
export const TOWER_SPOTS: readonly { x: number; y: number }[] = [
  { x: 30, y: 200 },
  { x: 180, y: 30 },
  { x: 200, y: 180 },
]

/** The P1S bed, and the gap between plates the readers lay a project out with (1.2 bed widths). */
const BED = 256
const SIZE = 20
const HALF = 4

const ns = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'

/** A box from the origin to (SIZE, SIZE, HALF), as a mesh object. */
function box(id: number): string {
  const v = Array.from({ length: 8 }, (_, i) => [i & 1 ? SIZE : 0, i & 2 ? SIZE : 0, i & 4 ? HALF : 0])
  const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** The project: three plates, one two-filament object on each, and a tower spot per plate in the settings. */
export function towerPlatesProject(): Buffer {
  const plates = TOWER_SPOTS.map((_, i) => i)
  const meshes = plates.map((i) => box(2 * i + 1) + box(2 * i + 2)).join('')
  const objects = plates
    .map((i) => `<object id="${10 * (i + 1)}" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="${2 * i + 1}"/><component p:path="/3D/Objects/object_1.model" objectid="${2 * i + 2}" transform="1 0 0 0 1 0 0 0 1 0 0 ${HALF}"/></components></object>`)
    .join('')
  // Plates are laid out two to a row on the project's grid: plate 1 and 2 side by side, plate 3 below plate 1.
  const items = plates
    .map((i) => `<item objectid="${10 * (i + 1)}" transform="1 0 0 0 1 0 0 0 1 ${(i % 2) * BED * 1.2 + 118} ${-Math.floor(i / 2) * BED * 1.2 + 118} 0" printable="1"/>`)
    .join('')
  const settings = plates
    .map(
      (i) =>
        `<object id="${10 * (i + 1)}"><metadata key="name" value="Two color box ${i + 1}"/><metadata key="extruder" value="1"/>` +
        `<part id="${2 * i + 1}" subtype="normal_part"><metadata key="name" value="lower"/><metadata key="extruder" value="1"/></part>` +
        `<part id="${2 * i + 2}" subtype="normal_part"><metadata key="name" value="upper"/><metadata key="extruder" value="2"/></part></object>`,
    )
    .join('')
  const plateList = plates
    .map((i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="Tower plate ${i + 1}"/><metadata key="locked" value="false"/><model_instance><metadata key="object_id" value="${10 * (i + 1)}"/><metadata key="instance_id" value="0"/></model_instance></plate>`)
    .join('')
  const project = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
    printer_model: 'Bambu Lab P1S',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', `${BED}x0`, `${BED}x${BED}`, `0x${BED}`],
    layer_height: '0.2',
    filament_colour: ['#FFFFFF', '#FF0000'],
    filament_type: ['PLA', 'PLA'],
    enable_prime_tower: '1',
    prime_tower_width: '35',
    wipe_tower_x: TOWER_SPOTS.map((s) => String(s.x)),
    wipe_tower_y: TOWER_SPOTS.map((s) => String(s.y)),
  }
  return zip({
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${ns}><metadata name="Application">BambuStudio-02.08.02.61</metadata><resources>${objects}</resources><build>${items}</build></model>`,
    '3D/Objects/object_1.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${ns}><resources>${meshes}</resources><build/></model>`,
    'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${settings}${plateList}</config>`,
    'Metadata/project_settings.config': JSON.stringify(project),
  })
}
