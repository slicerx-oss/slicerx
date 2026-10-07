// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The configuration the app slices with, for three stock printers at their default filament and process, against what
// OrcaSlicer 2.4.2 resolves for the same presets (the config block of its own G-code, dumped by
// packages/core/bench/compare/resolved_dump.py on a machine with OrcaSlicer). It runs only when ORCA_RESOLVED_DIR points at the
// dumps (orca-<model>.<tier>.json), which stay out of the repository. Every difference is listed with its reason;
// any other difference fails the test.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultConfig, importFlat, listPrinterProfiles, sameValue } from '@slicerx/settings'
import { buildProfileLayer } from '../src/adapters/profile'

const DIR = process.env['ORCA_RESOLVED_DIR']
/** Every printer with a dump: the catalog's vendor and model name pick the shipped profile. */
const MODELS: { id: string; vendor: string; model: string }[] = DIR && existsSync(DIR)
  ? listPrinterProfiles().filter((p) => existsSync(`${DIR}/orca-${p.id}.standard.json`)).map((p) => ({ id: p.id, vendor: p.vendor, model: p.model }))
  : []

/** Differences that are expected, with the reason. */
const REASONS: Record<string, string> = {
  machine_start_gcode: 'G-code written for SlicerX (packages/profiles/gcode.json), not the maker text',
  extruder_clearance_dist_to_rod: "Bambu Studio's machine value, which Orca's preset leaves out (heimdall's gantry band)",
  extruder_clearance_max_radius: "Bambu Studio's machine value, which Orca's preset leaves out (heimdall's clearance radius)",
  machine_end_gcode: 'G-code written for SlicerX',
  layer_change_gcode: 'G-code written for SlicerX',
  before_layer_change_gcode: 'G-code written for SlicerX',
  change_filament_gcode: 'G-code written for SlicerX',
  machine_pause_gcode: 'G-code is not shipped; a pause uses the profile text, empty here',
  time_lapse_gcode: 'G-code is not shipped',
  filament_start_gcode: 'G-code is not shipped per filament',
  filament_end_gcode: 'G-code is not shipped per filament',
  template_custom_gcode: 'G-code is not shipped',
  default_filament_profile: 'Orca preset name, not a setting',
  default_print_profile: 'Orca preset name, not a setting',
  printer_notes: 'Orca preset note, not a setting',
  curr_bed_type: 'the dump sets the plate so Orca accepts the filament; the app keeps the plate of the printer and plate settings',
}

/** Two filaments other than the printer's default, on the P1S: a Bambu product and a third party one. The dumps are orca-bambu-p1s.standard.<tag>.json in ORCA_RESOLVED_FIL_DIR. */
const FIL_DIR = process.env['ORCA_RESOLVED_FIL_DIR']
const FILAMENTS: { tag: string; slot: { type: string; vendor?: string; family?: string; variant?: string } }[] = [
  { tag: 'petg-hf', slot: { type: 'PETG', vendor: 'BBL', family: 'Bambu PETG HF', variant: 'BBL X1C' } },
  { tag: 'polymaker-pla', slot: { type: 'PLA', vendor: 'OrcaFilamentLibrary', family: 'Panchroma PLA', variant: 'System' } },
]

// Orca writes a line break as backslash n, a quote as backslash quote and a backslash as two.
const unescape = (v: string): string => v.replace(/\\(.)/g, (m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === '"' ? '"' : c === '\\' ? '\\' : m))
const clean = (_k: string, v: string): string => unescape(v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v)

describe.skipIf(!FIL_DIR || !existsSync(FIL_DIR ?? ''))('a chosen filament against OrcaSlicer 2.4.2 on the P1S', () => {
  for (const f of FILAMENTS) {
    it(`${f.tag}: every setting equals Orca's, except the listed ones`, async () => {
      const raw = JSON.parse(readFileSync(`${FIL_DIR}/orca-bambu-p1s.standard.${f.tag}.json`, 'utf8')) as Record<string, string>
      const orca = importFlat(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(k, v)]))).config as Record<string, unknown>
      const layer = await buildProfileLayer({ printer: { vendor: 'Bambu Lab', model: 'P1S' }, tier: 'standard', slots: [f.slot] })
      const ours = { ...defaultConfig(), ...layer!.values } as Record<string, unknown>
      const norm = (v: unknown): string => JSON.stringify(v)?.replace(/\\\\n/g, '\\n') ?? ''
      const differ = Object.keys(orca).filter((k) => !sameValue(orca[k] as never, ours[k] as never) && norm(orca[k]) !== norm(ours[k]))
      const report = differ.map((k) => `${f.tag} ${k}: ${REASONS[k] ?? 'UNEXPLAINED'} | orca ${JSON.stringify(orca[k])?.slice(0, 70)} | ours ${JSON.stringify(ours[k])?.slice(0, 70)}`)
      if (process.env['ORCA_RESOLVED_REPORT']) writeFileSync(`${process.env['ORCA_RESOLVED_REPORT']}-fil-${f.tag}.txt`, `${Object.keys(orca).length} Orca settings, ${differ.length} differ\n${report.join('\n')}\n`)
      expect(differ.filter((k) => !(k in REASONS)), report.join('\n')).toEqual([])
    })
  }
})

describe.skipIf(!DIR || !existsSync(DIR ?? ''))('resolved configuration against OrcaSlicer 2.4.2', () => {
  for (const m of MODELS) {
    it(`${m.id}: every setting equals Orca's, except the listed ones`, async () => {
      const raw = JSON.parse(readFileSync(`${DIR}/orca-${m.id}.standard.json`, 'utf8')) as Record<string, string>
      const orca = importFlat(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(k, v)]))).config as Record<string, unknown>
      const layer = await buildProfileLayer({ printer: { vendor: m.vendor, model: m.model }, tier: 'standard', slots: [{ type: 'PLA' }] })
      expect(layer?.source).toBe('orca')
      const ours = { ...defaultConfig(), ...layer!.values } as Record<string, unknown>
      const differ: string[] = []
      const norm = (v: unknown): string => JSON.stringify(v) ?? ''
      for (const k of Object.keys(orca)) if (!sameValue(orca[k] as never, ours[k] as never) && norm(orca[k]) !== norm(ours[k])) differ.push(k)
      const report = differ.map((k) => `${m.id} ${k}: ${REASONS[k] ?? 'UNEXPLAINED'} | orca ${JSON.stringify(orca[k])?.slice(0, 60)} | ours ${JSON.stringify(ours[k])?.slice(0, 60)}`)
      if (process.env['ORCA_RESOLVED_REPORT']) writeFileSync(`${process.env['ORCA_RESOLVED_REPORT']}-${m.id}.txt`, `${Object.keys(orca).length} Orca settings, ${differ.length} differ\n${report.join('\n')}\n`)
      expect(differ.filter((k) => !(k in REASONS)), report.join('\n')).toEqual([])
      expect(layer!.bed.widthMm).toBeGreaterThan(0)
    })
  }
})

/** The presets for other nozzle sizes: every dump `orca-<model>.standard.n<size>.json` against the layer for that size. */
const NOZZLE_DUMPS: { id: string; vendor: string; model: string; nozzle: number }[] = []
if (DIR && existsSync(DIR)) {
  for (const p of listPrinterProfiles()) for (const n of [0.15, 0.2, 0.25, 0.5, 0.6, 0.8, 1.0]) if (p.nozzles.includes(n) && existsSync(`${DIR}/orca-${p.id}.standard.json`) && existsSync(`${DIR}/orca-${p.id}.standard.n${n}.json`)) NOZZLE_DUMPS.push({ id: p.id, vendor: p.vendor, model: p.model, nozzle: n })
}

describe.skipIf(NOZZLE_DUMPS.length === 0)('other nozzle sizes against OrcaSlicer 2.4.2', () => {
  for (const m of NOZZLE_DUMPS) {
    it(`${m.id} with a ${m.nozzle} mm nozzle`, async () => {
      const raw = JSON.parse(readFileSync(`${DIR}/orca-${m.id}.standard.n${m.nozzle}.json`, 'utf8')) as Record<string, string>
      const orca = importFlat(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(k, v)]))).config as Record<string, unknown>
      const layer = await buildProfileLayer({ printer: { vendor: m.vendor, model: m.model }, tier: 'standard', slots: [{ type: 'PLA' }], nozzle: m.nozzle })
      expect(layer?.nozzle).toBe(m.nozzle)
      expect(layer?.source).toBe('orca')
      const ours = { ...defaultConfig(), ...layer!.values } as Record<string, unknown>
      const norm = (v: unknown): string => JSON.stringify(v)?.replace(/\\\\n/g, '\\n') ?? ''
      const differ = Object.keys(orca).filter((k) => !sameValue(orca[k] as never, ours[k] as never) && norm(orca[k]) !== norm(ours[k]))
      const report = differ.map((k) => `${m.id} ${m.nozzle} ${k}: ${REASONS[k] ?? 'UNEXPLAINED'} | orca ${JSON.stringify(orca[k])?.slice(0, 60)} | ours ${JSON.stringify(ours[k])?.slice(0, 60)}`)
      if (process.env['ORCA_RESOLVED_REPORT']) writeFileSync(`${process.env['ORCA_RESOLVED_REPORT']}-${m.id}-n${m.nozzle}.txt`, `${Object.keys(orca).length} Orca settings, ${differ.length} differ\n${report.join('\n')}\n`)
      expect(differ.filter((k) => !(k in REASONS)), report.join('\n')).toEqual([])
    })
  }
})
