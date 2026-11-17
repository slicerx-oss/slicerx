// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A painted Bambu Studio project for the A1 whose filaments can be told apart by height: a 20 by 20 by 40 mm column in
// four 10 mm bands, on filament 2, with four PLA filaments (white, black, red, magenta). Band k's sides are painted
// filament k for k up to 3 ("4", "8" and "0C", the longer form for filament 3), one band 1 triangle is split ("40003",
// a quarter of it on filament 1), and band 4 is left unpainted, so it prints the column's own filament 2. Filament 4
// is listed and used by nothing.
import { writeZip } from '../src/zip'

export const BAND_COLORS = ['#FFFFFF', '#000000', '#FF0000', '#C100C1']
/** The paint text of each painted band. */
const BAND_PAINT: Record<number, string> = { 1: '4', 2: '8', 3: '0C' }
const SIDE = 20
const BANDS = 4
export const BAND_MM = 10

export function bandedProject(): Buffer {
  const v: [number, number, number][] = []
  for (let k = 0; k <= BANDS; k++) v.push([0, 0, k * BAND_MM], [SIDE, 0, k * BAND_MM], [SIDE, SIDE, k * BAND_MM], [0, SIDE, k * BAND_MM])
  const tris: [number, number, number, string | undefined][] = []
  for (let k = 0; k < BANDS; k++) {
    const lo = 4 * k
    const hi = 4 * (k + 1)
    const paint = BAND_PAINT[k + 1]
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      tris.push([lo + i, lo + j, hi + j, paint], [lo + i, hi + j, hi + i, k === 0 && i === 0 ? '40003' : paint])
    }
  }
  const top = 4 * BANDS
  tris.push([0, 2, 1, undefined], [0, 3, 2, undefined], [top, top + 1, top + 2, undefined], [top, top + 2, top + 3, undefined])
  const mesh = `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${tris.map(([a, b, c, p]) => `<triangle v1="${a}" v2="${b}" v3="${c}"${p ? ` paint_color="${p}"` : ''}/>`).join('')}</triangles></mesh>`
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">BambuStudio-02.07.01.57</metadata><resources><object id="1" type="model">${mesh}</object><object id="2" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 118 118 0"/></build></model>`
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config><object id="2"><metadata key="name" value="column"/><metadata key="extruder" value="2"/><part id="1" subtype="normal_part"><metadata key="name" value="column"/><metadata key="extruder" value="2"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate></config>`
  const settings = { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], filament_colour: BAND_COLORS, filament_type: BAND_COLORS.map(() => 'PLA'), filament_settings_id: BAND_COLORS.map(() => 'Bambu PLA Basic @BBL A1'), layer_height: '0.2', initial_layer_print_height: '0.2' }
  return writeZip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }])
}

/**
 * The tool that prints most of each band's outer wall in `gcode` (0-based, as the G-code numbers them), by band from 1,
 * with its share of the band's outer wall moves.
 */
export function bandTools(gcode: string): Record<number, { tool: number; share: number }> {
  const moves: Record<number, Map<number, number>> = {}
  let z = 0
  let tool = -1
  let feature = ''
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; Z_HEIGHT:')) z = Number(line.slice(11))
    else if (line.startsWith('; FEATURE:')) feature = line.slice(10).trim()
    else {
      const code = line.split(';', 1)[0]!.trim()
      const t = /^T(\d+)$/.exec(code)
      if (t && Number(t[1]) < 255) tool = Number(t[1])
      else if (feature === 'Outer wall' && /^G1 .*X.* E\d*\.?\d+/.test(code)) {
        const band = Math.min(BANDS, Math.floor(z / BAND_MM) + 1)
        const m = (moves[band] ??= new Map())
        m.set(tool, (m.get(tool) ?? 0) + 1)
      }
    }
  }
  return Object.fromEntries(
    Object.entries(moves).map(([band, m]) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0)
      const [best, n] = [...m].sort((a, b) => b[1] - a[1])[0]!
      return [Number(band), { tool: best, share: n / total }]
    }),
  )
}
