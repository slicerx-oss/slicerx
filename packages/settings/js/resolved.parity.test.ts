// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shipped resolved profiles (printer, default filament and process of each quality tier) against the settings
// OrcaSlicer 2.4.2 resolved for the same presets, for the day-one printers. Runs only when ORCA_RESOLVED_DIR points at
// the dumps (orca-<model>.<tier>.json, the config block of Orca's own G-code), which stay out of the repository.
// Every difference must be listed here with its reason.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultConfig } from './schema'
import { importFlat } from './import'
import { printerConfig } from './profiles'
import { resolvedProfile } from './resolved'
import { sameValue } from './diff'

const DIR = process.env['ORCA_RESOLVED_DIR']
const PRINTERS = ['bambu-p1s', 'bambu-a1', 'bambu-x1-carbon', 'prusa-mk4s', 'creality-k1']
const TIERS = ['draft', 'standard', 'fine', 'extra_fine', 'strong']

const REASONS: Record<string, string> = {
  machine_start_gcode: 'G-code is the shipped text (packages/profiles/gcode.json), compared separately',
  machine_end_gcode: 'same', layer_change_gcode: 'same', before_layer_change_gcode: 'same', change_filament_gcode: 'same',
  machine_pause_gcode: 'same', time_lapse_gcode: 'same', template_custom_gcode: 'same', toolchange_gcode: 'same', wrapping_detection_gcode: 'same',
  change_extrusion_role_gcode: 'same', printing_by_object_gcode: 'same',
  default_filament_profile: 'Orca preset name, not a setting',
  default_print_profile: 'Orca preset name, not a setting',
  printer_notes: 'Orca preset note, not a setting',
  curr_bed_type: 'the dump sets the plate so Orca accepts the filament; the app keeps the plate of the printer and plate settings',
  required_nozzle_HRC: 'Orca only warns when the nozzle hardness is unknown (0); the engine refuses, so the request is not sent until the nozzle is known',
  filament_start_gcode: 'filament G-code ships with the filament presets, not the resolved profile',
  filament_end_gcode: 'same',
}

const GCODE = ['machine_start_gcode', 'machine_end_gcode', 'layer_change_gcode', 'before_layer_change_gcode', 'change_filament_gcode', 'machine_pause_gcode', 'time_lapse_gcode', 'template_custom_gcode', 'wrapping_detection_gcode', 'toolchange_gcode']

const unescape = (v: string): string => v.replace(/\\(.)/g, (m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === '"' ? '"' : c === '\\' ? '\\' : m))
const clean = (v: string): string => unescape(v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v)

describe.skipIf(!DIR || !existsSync(DIR ?? ''))('resolved profiles against OrcaSlicer 2.4.2', () => {
  for (const id of PRINTERS) {
    for (const tier of TIERS) {
      const file = `${DIR}/orca-${id}.${tier}.json`
      it.skipIf(!existsSync(file))(`${id} ${tier}`, async () => {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
        const orca = importFlat(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]))).config as Record<string, unknown>
        const r = await resolvedProfile(id, tier)
        expect(r, `${id} has resolved data`).toBeDefined()
        const ours = { ...defaultConfig(), ...r!.machine, ...r!.filament, ...r!.process, ...Object.fromEntries(Object.entries(printerConfig(id) ?? {}).filter(([k]) => GCODE.includes(k))) } as Record<string, unknown>
        const differ = Object.keys(orca).filter((k) => !(k in REASONS) && !sameValue(orca[k] as never, ours[k] as never) && JSON.stringify(orca[k]) !== JSON.stringify(ours[k]))
        if (process.env['ORCA_RESOLVED_REPORT']) for (const k of differ) appendFileSync(process.env['ORCA_RESOLVED_REPORT'], `${id}\t${tier}\t${k}\torca ${JSON.stringify(orca[k])?.slice(0, 120)}\tours ${JSON.stringify(ours[k])?.slice(0, 120)}\n`)
        expect(differ.map((k) => `${k}: orca ${JSON.stringify(orca[k])?.slice(0, 80)} ours ${JSON.stringify(ours[k])?.slice(0, 80)}`)).toEqual([])
      })
    }
  }
})
