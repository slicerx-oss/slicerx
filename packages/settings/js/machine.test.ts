// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locks the machine settings each printer profile carries. They are Orca's own numbers and choices for the
// same model (checked by a private script against OrcaSlicer's current vendor profiles), so a change here
// needs a new check: run the private parity script, then UPDATE_GOLDEN=1 to write the lock again.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importFlat } from './import'
import { MACHINE_CHECKED_COMMIT, gcodeStatus, listPrinterProfiles, machineEntry, printerConfig } from './profiles'
import gcodeJson from '@slicerx/profiles/gcode.json'
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
const gcode = gcodeJson as unknown as { families: Record<string, Record<string, string>>; models: Record<string, string>; pending: string[] }
const table = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(models).map(([id, e]) => [id, fnv(JSON.stringify(canon({ machine: e.machine, nozzles: e.nozzles })))])),
  ...Object.fromEntries(Object.entries(gcode.families).map(([id, f]) => [`gcode ${id}`, fnv(JSON.stringify(canon(f)))])),
  gcodeModels: fnv(JSON.stringify(canon({ models: gcode.models, pending: gcode.pending }))),
})

describe('machine settings', () => {
  it('covers the models Orca has a profile for and records what was checked', () => {
    expect(Object.keys(models)).toHaveLength(51)
    expect(MACHINE_CHECKED_COMMIT).toMatch(/^[0-9a-f]{7,}$/)
    for (const [id, e] of Object.entries(models)) {
      expect(e.orca?.checked, id).toBe(MACHINE_CHECKED_COMMIT)
      expect(e.orca?.profile, id).toMatch(/nozzle/)
    }
    const missing = listPrinterProfiles().map((p) => p.id).filter((id) => !models[id])
    // The UltiMaker S series comes from Cura's definitions (cura/ultimaker.json), not Orca.
    expect(missing).toEqual(['prusa-mk3.9', 'snapmaker-a150', 'ultimaker-s3', 'ultimaker-s5', 'ultimaker-s7', 'ultimaker-s6', 'ultimaker-s8', 'sovol-sv04', 'generic-klipper-delta', 'generic-klipper', 'generic-octoprint', 'generic-duet', 'generic-export'])
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
    for (const id of ids) expect(gcodeStatus(id), id).toBeDefined()
    expect(Object.keys(gcode.models).filter((id) => gcode.pending.includes(id))).toEqual([])
    for (const id of ids) {
      const cfg = printerConfig(id) as unknown as Record<string, unknown>
      const has = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode'].filter((k) => k in cfg)
      expect(has.length, id).toBeGreaterThanOrEqual(gcodeStatus(id) === 'written' ? 5 : 0)
    }
    expect(gcode.pending).toEqual([])
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

describe('dual and multi nozzle printers', () => {
  it('carry an extruder printable area for every nozzle', () => {
    // The maker's nozzle list decides.
    const multi = listPrinterProfiles().filter((p) => ((printerConfig(p.id) as Record<string, unknown>)['nozzle_diameter'] as unknown[]).length > 1 && models[p.id])
    expect(multi.map((p) => p.id)).toEqual(['bambu-h2d', 'bambu-h2c', 'prusa-xl-5-toolhead', 'snapmaker-u1', 'snapmaker-j1', 'snapmaker-artisan'])
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
