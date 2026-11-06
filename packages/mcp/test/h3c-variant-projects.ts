// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two small Bambu Lab H3C projects in the layout Bambu Studio 2.9.1 saves, made here with our own writer and holding
// only the settings the variant rule reads (plus the printer, filament names and types). Four 12 mm cubes, cube k on
// filament k: three PLA filaments listed with a Standard and a High Flow variant each, and a 2.85 mm TPU listed with
// its TPU285 variant only (`filament_self_index` 1, 1, 2, 2, 3, 3, 4). The filaments are on hotends 0, 2, 6 and 7 by
// hand (`filament_nozzle_map`, hotends from 0); hotend 7 is the TPU285 one.
//
// `saved` is the project as it is saved for the printer: `nozzle_volume_type` Standard and the hotend types in
// `default_nozzle_volume_type`. `synced` is the same project after the printer's hotends are read in: the printer
// reports each hotend's type (`extruder_nozzle_volume_type`, the TPU hotend at index 7), counts them
// (`extruder_nozzle_stats_new`), and calls the extruder Hybrid (`nozzle_volume_type`), a type no variant lists.
//
// Each variant value differs, so a test can tell which one was picked: filament k's Standard
// `filament_max_volumetric_speed` is 20 + k, its High Flow one 40 + k, the TPU's TPU285 one 9; the Standard
// `outer_wall_speed` is 200, the High Flow 500, the TPU285 150.
import { writeZip } from '../src/zip'

const SAVED_SETTINGS: Record<string, unknown> = {
  printer_model: 'Bambu Lab H3C',
  printer_settings_id: 'Bambu Lab H3C 0.4 nozzle',
  filament_settings_id: ['Bambu PLA Basic @BBL H3C', 'Bambu PLA Basic @BBL H3C', 'Bambu PLA Basic @BBL H3C', 'Bambu TPU 75A(2.85mm) @BBL H3C'],
  filament_type: ['PLA', 'PLA', 'PLA', 'TPU'],
  filament_colour: ['#FFFFFF', '#0A2CA5', '#F72323', '#000000'],
  filament_diameter: ['1.75', '1.75', '1.75', '2.85'],
  nozzle_diameter: ['0.4'],
  extruder_type: ['Direct Drive'],
  nozzle_volume_type: ['Standard'],
  default_nozzle_volume_type: ['Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'TPU285', 'Standard'],
  extruder_max_nozzle_count: ['9'],
  extruder_nozzle_stats: ['Standard#8|TPU285#1'],
  filament_map_mode: 'Manual',
  filament_map: ['1', '1', '1', '1'],
  filament_nozzle_map: ['0', '2', '6', '7'],
  filament_self_index: ['1', '1', '2', '2', '3', '3', '4'],
  filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU285'],
  filament_max_volumetric_speed: ['21', '41', '22', '42', '23', '43', '9'],
  print_extruder_id: ['1', '1', '1'],
  print_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU285'],
  outer_wall_speed: ['200', '500', '150'],
}

// The synced file names each hotend's type itself, so it is left without the printer's defaults here.
const SYNCED_SETTINGS: Record<string, unknown> = {
  ...Object.fromEntries(Object.entries(SAVED_SETTINGS).filter(([k]) => k !== 'default_nozzle_volume_type')),
  nozzle_volume_type: ['Hybrid'],
  extruder_nozzle_count: ['9'],
  extruder_nozzle_slot: ['0', '1', '2', '3', '4', '5', '6', '7', '8'],
  extruder_nozzle_volume_type: ['Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'TPU285', 'Standard'],
  extruder_nozzle_stats: ['Standard#9'],
  extruder_nozzle_stats_new: ['Standard#8|TPU285#1'],
}

/** The settings of each layout, for tests that read them directly. */
export const H3C_VARIANT_SETTINGS = { saved: SAVED_SETTINGS, synced: SYNCED_SETTINGS } as const

export type H3cLayout = keyof typeof H3C_VARIANT_SETTINGS

const cube = (s: number): string => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}

/** The project in `layout` as 3MF bytes. */
export function h3cVariantProject(layout: H3cLayout): Buffer {
  const ids = [0, 1, 2, 3]
  const objects = ids.map((k) => `<object id="${2 * k + 1}" type="model">${cube(12)}</object><object id="${2 * k + 2}" type="model"><components><component objectid="${2 * k + 1}"/></components></object>`).join('')
  const items = ids.map((k) => `<item objectid="${2 * k + 2}" transform="1 0 0 0 1 0 0 0 1 ${125 + 25 * k} 160 0" printable="1"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><metadata name="Application">BambuStudio-02.09.01.70</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources>${objects}</resources><build>${items}</build></model>`
  const config = `<?xml version="1.0" encoding="UTF-8"?><config>${ids.map((k) => `<object id="${2 * k + 2}"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/><part id="${2 * k + 1}" subtype="normal_part"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/></part></object>`).join('')}<plate><metadata key="plater_id" value="1"/>${ids.map((k) => `<model_instance><metadata key="object_id" value="${2 * k + 2}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate></config>`
  return writeZip([
    { name: '3D/3dmodel.model', data: model },
    { name: 'Metadata/model_settings.config', data: config },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(H3C_VARIANT_SETTINGS[layout]) },
  ])
}
