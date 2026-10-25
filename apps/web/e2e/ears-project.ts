// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small Bambu-style project with painted brim ears in file format 1, made from our own boxes. It has the shape of the
// projects that showed the ear reading bug: three objects on two plates, each an assembly of two parts that only move
// (translation-only components), meshes that lie flat in their own space with a build item turned on two axes that
// stands them up, a per part matrix in the settings that disagrees with the components (it must be ignored), and a
// Metadata/brim_ear_points.txt with `brim_points_format_version=1` and five numbers per ear (x y z r -1).
import { zip } from './project-zip'

/** The radius every ear in the file has. */
export const EAR_RADIUS = 4

type Spec = {
  /** The body's half sizes in x and y (its z half size is 2), and the inlay's. */
  body: [number, number]
  inlay: [number, number]
  /** Where the component puts the body in the object's space; the inlay sits 2 lower. */
  at: [number, number, number]
  /** The item's turn about z, in degrees, after the mesh is stood up (its y becomes the height). */
  turn: number
  /** The item's place on its plate. */
  on: [number, number]
  plate: 1 | 2
  /** The ears' x positions along the body's bottom edge, and their z. */
  ears: { x: number; z: number }[]
}

const SPECS: Spec[] = [
  { body: [15, 10], inlay: [5, 5], at: [2, 3, -10], turn: 30, on: [50, 55], plate: 1, ears: [{ x: -13, z: -10 }, { x: 17, z: -10 }, { x: 2, z: -8 }] },
  { body: [12, 8], inlay: [4, 4], at: [-4, 20, 6], turn: 75, on: [90, 60], plate: 1, ears: [{ x: -16, z: 6 }, { x: 8, z: 6 }, { x: -4, z: 7.5 }] },
  { body: [18, 9], inlay: [6, 4], at: [0, -6, 2], turn: -40, on: [90, 95], plate: 2, ears: [{ x: -18, z: 2 }, { x: -6, z: 2 }, { x: 6, z: 2 }, { x: 18, z: 2 }] },
]

/** The A1 mini bed, and the gap between plates the readers lay a project out with (1.2 bed widths). */
const BED = 180
const PLATE_2_AT = BED * 1.2

const ns = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'

function box(id: number, [hx, hy]: [number, number], hz: number): string {
  const v = Array.from({ length: 8 }, (_, i) => [i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz])
  const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** What the file says about its ears, for a check to compare the opened project with. */
export type EarsFile = { buffer: Buffer; ears: number; perObject: number[]; radius: number }

/** The project, and what its ear file holds. */
export function earsProject(): EarsFile {
  const meshes = SPECS.map((s, i) => box(2 * i + 1, s.body, 2) + box(2 * i + 2, s.inlay, 1.5)).join('')
  const objects = SPECS.map((s, i) => {
    const [x, y, z] = s.at
    const part = (n: number, dz: number) => `<component p:path="/3D/Objects/object_1.model" objectid="${2 * i + n}" transform="1 0 0 0 1 0 0 0 1 ${x} ${y} ${z + dz}"/>`
    return `<object id="${10 * (i + 1)}" type="model"><components>${part(1, 0)}${part(2, -2)}</components></object>`
  }).join('')
  const items = SPECS.map((s, i) => {
    // Row vectors: x and z turn about the height, and the mesh's y becomes the height. The body's lowest edge ends at z 0.
    const c = Math.cos((s.turn * Math.PI) / 180)
    const n = Math.sin((s.turn * Math.PI) / 180)
    const height = s.body[1] - s.at[1]
    const at = [s.on[0] + (s.plate === 2 ? PLATE_2_AT : 0), s.on[1], height]
    return `<item objectid="${10 * (i + 1)}" transform="${c} ${n} 0 0 0 1 ${n} ${-c} 0 ${at.join(' ')}" printable="1"/>`
  }).join('')
  const settings = SPECS.map((s, i) => {
    const [x, y, z] = s.at
    // The per part matrix is the components' move times 3: Bambu Studio's own files do not agree like this, so a reader
    // that took it for the parts' place would put them somewhere else.
    const part = (n: number, name: string, dz: number, extruder: number) =>
      `<part id="${n}" subtype="normal_part"><metadata key="name" value="${name}"/><metadata key="matrix" value="1 0 0 ${3 * x} 0 1 0 ${3 * y} 0 0 1 ${3 * (z + dz)} 0 0 0 1"/><metadata key="extruder" value="${extruder}"/></part>`
    return `<object id="${10 * (i + 1)}"><metadata key="name" value="Assembly ${i + 1}"/><metadata key="extruder" value="1"/>${part(1, 'body', 0, 1)}${part(2, 'inlay', -2, 2)}</object>`
  }).join('')
  const plate = (n: 1 | 2) =>
    `<plate><metadata key="plater_id" value="${n}"/><metadata key="plater_name" value="Plate ${n}"/><metadata key="locked" value="false"/>${SPECS.flatMap((s, i) => (s.plate === n ? [`<model_instance><metadata key="object_id" value="${10 * (i + 1)}"/><metadata key="instance_id" value="0"/></model_instance>`] : [])).join('')}</plate>`
  // The ear file: one line per build item (from 1), five numbers per ear. The ear sits on the body's lowest edge.
  const lines = SPECS.map((s, i) => {
    const y = s.at[1] - s.body[1]
    return `object_id=${i + 1}|${s.ears.map((e) => `${e.x} ${y} ${e.z} ${EAR_RADIUS} -1`).join(' ')}`
  })
  const project = {
    printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle',
    printer_model: 'Bambu Lab A1 mini',
    nozzle_diameter: ['0.4'],
    printable_area: ['0x0', '180x0', '180x180', '0x180'],
    layer_height: '0.2',
    filament_colour: ['#00AE42', '#FFFFFF'],
    brim_type: 'painted',
    brim_width: '5',
  }
  const buffer = zip({
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${ns}><resources>${objects}</resources><build>${items}</build></model>`,
    '3D/Objects/object_1.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${ns}><resources>${meshes}</resources><build/></model>`,
    'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${settings}${plate(1)}${plate(2)}</config>`,
    'Metadata/project_settings.config': JSON.stringify(project),
    'Metadata/brim_ear_points.txt': `brim_points_format_version=1\n${lines.join('\n')}\n`,
  })
  return { buffer, ears: SPECS.reduce((n, s) => n + s.ears.length, 0), perObject: SPECS.map((s) => s.ears.length), radius: EAR_RADIUS }
}
