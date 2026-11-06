// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small Bambu Studio project for the P1S, made here with our own writer: one 12 mm cube, its own start G-code, and
// a key no SlicerX setting has, which that start G-code reads (KEY, 187 for the first filament). The MCP server's
// project-script-keys test and the app's project route test share it.
import { writeZip } from '../src/zip'

/** A key no slicer setting has, which the project's own start G-code reads. */
export const KEY = 'hold_probe_temp'
export const START = `; our own start G-code\nM104 S{${KEY}[0]} ; hold\nG28\nM109 S{nozzle_temperature_initial_layer[0]}\n`

const cubeMesh = (s: number) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}

/** A Bambu Studio project for the P1S of one 12 mm cube, with its own start G-code and the unknown key it reads. */
export function scriptKeyProject(): Buffer {
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.08.04.61</metadata><resources><object id="1" type="model">${cubeMesh(12)}</object><object id="2" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config><object id="2"><metadata key="name" value="cube"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="cube"/><metadata key="extruder" value="1"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', gcode_flavor: 'marlin', nozzle_diameter: ['0.4'], filament_colour: ['#00AE42'], filament_type: ['PLA'], layer_height: '0.2', initial_layer_print_height: '0.2', machine_start_gcode: START, [KEY]: ['187'] }
  return writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }])
}
