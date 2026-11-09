// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locks the machine settings each printer profile carries. They are Orca's own numbers and choices for the
// same model (checked by a private script against OrcaSlicer's current vendor profiles), so a change here
// needs a new check: run the private parity script, then UPDATE_GOLDEN=1 to write the lock again. The stock Prusa MK4
// also carries the MK4 IS lift and retraction (packages/profiles/overlays/prusa-mk4is.json, scripts/apply-overlay.ts).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importFlat } from './import'
import { MACHINE_CHECKED_COMMIT, gcodeStatus, listPrinterProfiles, machineEntry, mergeWrittenGcode, printerConfig } from './profiles'
import gcodeJson from '@slicerx/profiles/gcode.json'
import gcodeWrittenJson from '@slicerx/profiles/gcode-written.json'
import machineJson from '@slicerx/profiles/machine.json'
import { SETTINGS, settingDef } from './schema'

const models = (machineJson as unknown as { models: Record<string, ReturnType<typeof machineEntry> & object & { derived?: string[] }> }).models
const lockPath = fileURLToPath(new URL('../fixtures/machine-lock.json', import.meta.url))

function fnv(text: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v)
type GcodeDoc = { families: Record<string, Record<string, string>>; models: Record<string, string>; pending: string[] }
const extracted = gcodeJson as unknown as GcodeDoc
const written = gcodeWrittenJson as unknown as Pick<GcodeDoc, 'families' | 'models'>
// gcode.json with the hand-written families of gcode-written.json, as the profiles load them.
const gcode = mergeWrittenGcode(extracted as never, written as never) as unknown as GcodeDoc
const table = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(models).map(([id, e]) => [id, fnv(JSON.stringify(canon({ machine: e.machine, nozzles: e.nozzles })))])),
  ...Object.fromEntries(Object.entries(gcode.families).map(([id, f]) => [`gcode ${id}`, fnv(JSON.stringify(canon(f)))])),
  gcodeModels: fnv(JSON.stringify(canon({ models: gcode.models, pending: gcode.pending }))),
})

describe('machine settings', () => {
  it('covers the models Orca has a profile for and records what was checked', () => {
    expect(Object.keys(models)).toHaveLength(62)
    expect(MACHINE_CHECKED_COMMIT).toMatch(/^[0-9a-f]{7,}$/)
    for (const [id, e] of Object.entries(models)) {
      // A model no slicer has a profile for is written from the maker's own documents, which it names.
      if (e.makerDocs) {
        expect(e.orca, id).toBeUndefined()
        expect(e.makerDocs.checked, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(e.makerDocs.sources.length, id).toBeGreaterThan(0)
        continue
      }
      // A model Orca has no profile for yet carries the Bambu Studio release its values come from.
      expect(e.orca?.checked, id).toBe(e.bambuStudio ? `bambu-studio-${e.bambuStudio}` : MACHINE_CHECKED_COMMIT)
      expect(e.orca?.profile, id).toMatch(/nozzle/)
    }
    const missing = listPrinterProfiles().map((p) => p.id).filter((id) => !models[id])
    // The UltiMaker S series comes from Cura's definitions (cura/ultimaker.json), not Orca.
    expect(missing).toEqual(['prusa-mk3.9', 'snapmaker-a150', 'ultimaker-s3', 'ultimaker-s5', 'ultimaker-s7', 'ultimaker-s6', 'ultimaker-s8', 'generic-klipper-delta', 'generic-klipper', 'generic-octoprint', 'generic-duet', 'generic-export'])
  })
  it('holds only keys the schema knows, none of them templates', () => {
    for (const [id, e] of Object.entries(models)) {
      const r = importFlat(e.machine)
      expect(r.unknownKeys, id).toEqual([])
      expect(r.invalidKeys, id).toEqual([])
      for (const k of Object.keys(e.machine)) {
        expect(settingDef(k)?.section, `${id} ${k}`).toBe('printer')
        expect(settingDef(k)?.type, `${id} ${k}`).not.toBe('gcode')
      }
    }
  })
  it('puts the maker values into the printer config, for every nozzle that has its own profile', () => {
    const x1c = printerConfig('bambu-x1-carbon') as unknown as Record<string, unknown>
    expect(x1c).toMatchObject({ printable_height: 250, gcode_flavor: 'marlin' })
    expect((x1c['machine_max_acceleration_extruding'] as number[])[0]).toBe(20000)
    for (const [id, e] of Object.entries(models)) {
      for (const [n, ov] of Object.entries(e.nozzles)) {
        const cfg = printerConfig(id, Number(n)) as unknown as Record<string, unknown>
        expect((cfg['nozzle_diameter'] as number[])[0], `${id} ${n}`).toBe(Number(n))
        for (const [k, v] of Object.entries(ov.differs)) expect(cfg[k], `${id} ${n} ${k}`).toEqual(importFlat({ [k]: v }).config[k as never])
      }
    }
  })
  it('marks every printer setting advanced or deeper, so casual users never see them', () => {
    for (const d of Object.values(models).flatMap((e) => Object.keys(e.machine)).map((k) => settingDef(k))) expect(d?.mode).not.toBe('simple')
    for (const d of SETTINGS.filter((s) => s.section === 'printer')) expect(d.mode, d.key).not.toBe('simple')
  })
  it('has start, end, layer change and filament change G-code for every model', () => {
    const ids = listPrinterProfiles().map((p) => p.id)
    // The H3C's and the MK3.5's maker G-code families go into packages/profiles/gcode.json as their own changes. Until
    // its family is there a printer takes the schema's start and end G-code; once it is, that printer is held to this
    // check like every other model.
    const awaiting = ['bambu-h3c', 'prusa-mk3.5'].filter((id) => !gcode.models[id])
    for (const id of ids) if (!awaiting.includes(id)) expect(gcodeStatus(id), id).toBeDefined()
    expect(Object.keys(gcode.models).filter((id) => gcode.pending.includes(id))).toEqual([])
    for (const id of ids) {
      const cfg = printerConfig(id) as unknown as Record<string, unknown>
      const has = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode'].filter((k) => k in cfg)
      expect(has.length, id).toBeGreaterThanOrEqual(gcodeStatus(id) === 'written' ? 5 : 0)
    }
    expect(gcode.pending).toEqual([])
  })
  it('has the Prusa MK3.5 from the maker profiles, every nozzle the maker covers', () => {
    const e = machineEntry('prusa-mk3.5')
    expect(e?.orca?.profile).toBe('Prusa MK3.5 0.4 nozzle')
    expect(Object.keys(e?.nozzles ?? {})).toEqual(['0.25', '0.6', '0.8'])
    for (const n of [0.25, 0.4, 0.6, 0.8]) {
      const c = printerConfig('prusa-mk3.5', n) as unknown as Record<string, unknown>
      expect(c['nozzle_diameter'], String(n)).toEqual([n])
      expect(c['printable_area'], String(n)).toEqual([[0, 0], [250, 0], [250, 210], [0, 210]])
      expect(c['printable_height'], String(n)).toBe(210)
      expect(c['gcode_flavor'], String(n)).toBe('marlin2')
    }
    const c = printerConfig('prusa-mk3.5') as unknown as Record<string, unknown>
    expect(c['machine_max_acceleration_extruding']).toEqual([4000, 4000])
    expect(c['retraction_length']).toEqual([0.8])
    expect((printerConfig('prusa-mk3.5', 0.8) as unknown as Record<string, unknown>)['max_layer_height']).toEqual([0.55])
  })
  it('matches the lock file', () => {
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(lockPath, JSON.stringify({ comment: 'FNV-1a of the sorted-key JSON of each model machine settings. Written by js/machine.test.ts (UPDATE_GOLDEN=1) after the private parity check passes.', orcaCommit: MACHINE_CHECKED_COMMIT, hashes: table() }, null, 1) + '\n')
      return
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { orcaCommit: string; hashes: Record<string, string> }
    expect(lock.orcaCommit).toBe(MACHINE_CHECKED_COMMIT)
    expect(table()).toEqual(lock.hashes)
  })
})

describe('hand-written G-code families', () => {
  it('keeps each written family and model out of gcode.json and gives it to the printer config', () => {
    const fields: [string, string][] = [['start', 'machine_start_gcode'], ['end', 'machine_end_gcode'], ['beforeLayerChange', 'before_layer_change_gcode'], ['layerChange', 'layer_change_gcode'], ['changeFilament', 'change_filament_gcode']]
    expect(Object.keys(written.models).length).toBeGreaterThan(0)
    // No script in the repository writes gcode.json; a stock refresh outside it can bring a written key back. Fail here,
    // fast and with the fix, rather than only when the profiles load.
    const owned = (key: string) => `remove ${key} from gcode.json; it is owned by gcode-written.json`
    for (const family of Object.keys(written.families)) expect(extracted.families[family], owned(family)).toBeUndefined()
    for (const [id, family] of Object.entries(written.models)) {
      expect(extracted.models[id], owned(id)).toBeUndefined()
      const cfg = printerConfig(id) as unknown as Record<string, unknown>
      for (const [field, key] of fields) expect(cfg[key], `${id} ${key}`).toBe(written.families[family]![field])
    }
  })
  it('refuses a family or model that is in both files', () => {
    const file = { families: { stock: { start: 'G28' } }, models: { 'printer-a': 'stock' }, pending: [] }
    expect(() => mergeWrittenGcode(file as never, { families: { stock: { start: 'G90' } } } as never)).toThrow(/family stock is in both gcode.json and gcode-written.json/)
    expect(() => mergeWrittenGcode(file as never, { models: { 'printer-a': 'ours' } })).toThrow('printer model printer-a is in both gcode.json and gcode-written.json: remove printer-a from gcode.json; it is owned by gcode-written.json')
    expect(mergeWrittenGcode(file as never, { families: { ours: { start: 'G90' } }, models: { 'printer-b': 'ours' } } as never).models).toEqual({ 'printer-a': 'stock', 'printer-b': 'ours' })
  })
})

describe('dual and multi nozzle printers', () => {
  it('carry an extruder printable area for every nozzle', () => {
    // The maker's nozzle list decides.
    const multi = listPrinterProfiles().filter((p) => ((printerConfig(p.id) as Record<string, unknown>)['nozzle_diameter'] as unknown[]).length > 1 && models[p.id])
    expect(multi.map((p) => p.id)).toEqual(['bambu-h2d', 'bambu-h2d-pro', 'bambu-h2c', 'bambu-x2d', 'prusa-xl-5-toolhead', 'snapmaker-u1', 'snapmaker-j1', 'snapmaker-artisan', 'sovol-sv04'])
    for (const p of multi) {
      const cfg = printerConfig(p.id) as Record<string, unknown>
      expect((cfg['extruder_printable_area'] as unknown[]).length, p.id).toBe((cfg['nozzle_diameter'] as unknown[]).length)
    }
  })
  it('keeps the maker areas on the H2 printers and fills the others from the bed, saying which', () => {
    const area = (id: string): unknown => (printerConfig(id) as Record<string, unknown>)['extruder_printable_area']
    expect(area('bambu-h2c')).toEqual([[[0, 0], [325, 0], [325, 320], [0, 320]], [[25, 0], [330, 0], [330, 320], [25, 320]]])
    expect(area('bambu-h2d')).toEqual([[[0, 0], [325, 0], [325, 320], [0, 320]], [[25, 0], [350, 0], [350, 320], [25, 320]]])
    expect(models['bambu-h2d']?.derived).toBeUndefined()
    for (const id of ['prusa-xl-5-toolhead', 'snapmaker-u1', 'snapmaker-j1', 'snapmaker-artisan']) {
      expect(models[id]?.derived, id).toEqual(['extruder_printable_area'])
      const bed = (printerConfig(id) as Record<string, unknown>)['printable_area']
      for (const a of area(id) as unknown[]) expect(a, id).toEqual(bed)
    }
    // A single nozzle printer keeps whatever the maker sets (the H2S sets none).
    expect(area('bambu-h2s')).toEqual([])
  })
  it('has the Sovol SV04 as two extruders from the maker\'s firmware, with tool changes and no manual swaps', () => {
    const e = machineEntry('sovol-sv04')
    expect(e?.orca).toBeUndefined()
    expect(e?.makerDocs?.sources.every((s) => s.startsWith('https://github.com/Sovol3d/SV04-IDEX-3D-Printer-Mainboard-Source-code/'))).toBe(true)
    const c = printerConfig('sovol-sv04') as unknown as Record<string, unknown>
    expect(c['nozzle_diameter']).toEqual([0.4, 0.4])
    expect(c['single_extruder_multi_material']).toBe(false)
    // Auto-park mode: the firmware applies the carriage offset itself, so the slicer's is zero for both.
    expect(c['extruder_offset']).toEqual([[0, 0], [0, 0]])
    expect(c['printable_area']).toEqual([[0, 0], [300, 0], [300, 300], [0, 300]])
    expect(c['extruder_printable_area']).toEqual([c['printable_area'], c['printable_area']])
    expect(c['printable_height']).toBe(400)
    expect(c['gcode_flavor']).toBe('marlin2')
    expect(gcode.models['sovol-sv04']).toBe('sovol_sv04')
    const change = c['change_filament_gcode'] as string
    expect(change).not.toMatch(/M600/)
    expect(change).toMatch(/^T\[next_extruder\]$/m)
    expect(change).toMatch(/^M109 T\[next_extruder\] S/m)
    const start = c['machine_start_gcode'] as string
    for (const heat of ['M104 T0 S{nozzle_temperature_initial_layer[0]}', 'M104 T1 S{nozzle_temperature_initial_layer[1]}', 'M109 T0 S', 'M109 T1 S']) expect(start).toContain(heat)
  })
  it('has the H3C from Bambu Studio 2.9.1\'s presets: one extruder that holds nine nozzles', () => {
    const e = machineEntry('bambu-h3c')
    expect(e?.orca?.profile).toBe('Bambu Lab H3C 0.4 nozzle')
    expect(e?.bambuStudio).toBe('02.09.01.70')
    expect(Object.keys(e?.nozzles ?? {})).toEqual(['0.2', '0.6', '0.8'])
    for (const n of [0.2, 0.4, 0.6, 0.8]) {
      const c = printerConfig('bambu-h3c', n) as Record<string, unknown>
      expect(c['nozzle_diameter'], String(n)).toEqual([n])
      expect(c['printable_area'], String(n)).toEqual([[0, 0], [330, 0], [330, 320], [0, 320]])
      expect(c['printable_height'], String(n)).toBe(325)
      expect(c['extruder_max_nozzle_count'], String(n)).toEqual([9])
    }
    const c = printerConfig('bambu-h3c') as Record<string, unknown>
    // Tool 8 is the TPU tool in the maker's presets (2.85 mm filament).
    expect(c['default_nozzle_volume_type']).toEqual(['Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'TPU285', 'Standard'])
    expect(c['machine_switch_extruder_time']).toBe(4)
    expect(c['support_chamber_temp_control']).toBe(true)
    expect((printerConfig('bambu-h3c', 0.8) as Record<string, unknown>)['max_layer_height']).toEqual([0.56])
  })
  it('has the H2C and Kobra X from the makers profiles', () => {
    const h2c = printerConfig('bambu-h2c') as Record<string, unknown>
    expect(h2c['printable_height']).toBe(325)
    expect(h2c['nozzle_diameter']).toEqual([0.4, 0.4])
    expect(h2c['extruder_type']).toEqual(['Direct Drive', 'Direct Drive'])
    expect(machineEntry('bambu-h2c')?.orca?.profile).toBe('Bambu Lab H2C 0.4 nozzle')
    expect(Object.keys(machineEntry('bambu-h2c')?.nozzles ?? {})).toEqual(['0.2', '0.6', '0.8'])
    const k = printerConfig('anycubic-kobra-x') as Record<string, unknown>
    expect(k['gcode_flavor']).toBe('klipper')
    expect(k['printable_height']).toBe(260)
    expect(k['printable_area']).toEqual([[0, 0], [260, 0], [260, 260], [0, 260]])
    expect(k['machine_max_acceleration_x']).toEqual([10000, 10000])
    expect(k['z_hop_types']).toEqual(['Slope Lift'])
    expect(gcodeStatus('bambu-h2c')).toBe('written')
    expect(gcodeStatus('anycubic-kobra-x')).toBe('written')
  })
})
