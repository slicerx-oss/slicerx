// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locks the filament presets. They are OrcaSlicer 2.4.2's values, and OrcaSlicer main's or Bambu Studio's for the
// presets 2.4.2 lacks, diffed privately against those profiles. A change needs a new check: run the private
// parity script, then UPDATE_GOLDEN=1 to write the lock again.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FILAMENT_SOURCES, filamentBrands, filamentPresetCount, listFilamentFamilies, loadFilamentPreset, loadVendorFile, resolveFilamentRaw } from './filaments'
import { settingDef } from './schema'
import { SETTINGS } from './schema'

const dir = fileURLToPath(new URL('../../profiles/filaments/', import.meta.url))
const lockPath = fileURLToPath(new URL('../fixtures/filaments-lock.json', import.meta.url))
const VENDORS = ['BBL', 'OrcaFilamentLibrary', 'Prusa', 'Creality', 'Elegoo', 'Qidi', 'Snapmaker', 'Sovol', 'FLSun']

function fnv(text: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v)

async function table(): Promise<{ files: Record<string, string>; families: Record<string, string> }> {
  const files: Record<string, string> = {}
  const families: Record<string, string> = {}
  for (const v of VENDORS) {
    files[v] = fnv(readFileSync(dir + v + '.json', 'utf8'))
    const f = (await loadVendorFile(v))!
    for (const [fam, e] of Object.entries(f.families)) {
      const all = Object.fromEntries(Object.keys(e.variants).sort().map((s) => [s, resolveFilamentRaw(f, fam, s)]))
      families[`${v}/${fam}`] = fnv(JSON.stringify(canon(all)))
    }
  }
  return { files, families }
}

describe('filament presets', () => {
  it('covers the brands and materials people print with', () => {
    expect(filamentPresetCount()).toBe(6845)
    expect(listFilamentFamilies()).toHaveLength(1116)
    const brands = filamentBrands()
    for (const b of ['Bambu Lab', 'Generic', 'Polymaker', 'eSUN', 'SUNLU', 'Elegoo', 'Overture', 'Prusa Polymers', 'HATCHBOX', 'JAYO', 'Creality', 'QIDI', 'Snapmaker']) expect(brands, b).toContain(b)
    const types = new Set(listFilamentFamilies().map((f) => f.type))
    for (const t of ['PLA', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'PC', 'PA-CF', 'PA-GF', 'TPU', 'PVA']) expect(types.has(t), t).toBe(true)
    expect(listFilamentFamilies({ brand: 'Bambu Lab', type: 'PLA' }).length).toBeGreaterThan(5)
    expect(FILAMENT_SOURCES.orcaSlicer).toMatch(/^[0-9a-f]{7,}$/)
    expect(FILAMENT_SOURCES.bambuStudio).toMatch(/^[0-9a-f]{7,}$/)
    expect(FILAMENT_SOURCES.orcaMain).toMatch(/^[0-9a-f]{7,}$/)
  })
  it('gives a typed preset with temperatures, cooling, flow and compatible printers', async () => {
    const p = await loadFilamentPreset('BBL', 'Bambu PLA Basic', 'BBL X1C')
    expect(p).toBeDefined()
    expect(p).toMatchObject({ name: 'Bambu PLA Basic @BBL X1C', brand: 'Bambu Lab', type: 'PLA', source: { app: 'OrcaSlicer 2.4.2' } })
    const c = p!.config as unknown as Record<string, unknown>
    for (const k of ['nozzle_temperature', 'nozzle_temperature_initial_layer', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high', 'hot_plate_temp', 'textured_plate_temp', 'fan_min_speed', 'fan_max_speed', 'overhang_fan_speed', 'slow_down_layer_time', 'filament_flow_ratio', 'filament_max_volumetric_speed', 'filament_density', 'filament_diameter', 'filament_cost']) expect(c[k], k).toBeDefined()
    expect(p!.compatiblePrinters.length).toBeGreaterThan(0)
  })
  it('keeps Bambu\'s material ids for Bambu Lab, and says where fallback presets come from', async () => {
    const bbl = await loadFilamentPreset('BBL', 'Bambu PLA Basic', 'BBL X1C')
    expect(bbl!.filamentId).toBe('GFA00')
    expect((await loadFilamentPreset('OrcaFilamentLibrary', 'Generic PLA', 'System'))!.source.app).toBe('OrcaSlicer 2.4.2')
    // A product 2.4.2 does not have keeps main's values, and says so.
    const jayo = listFilamentFamilies({ brand: 'JAYO' })[0]!
    expect((await loadFilamentPreset(jayo.vendor, jayo.family, jayo.variants[0]))!.source).toMatchObject({ app: 'OrcaSlicer main', commit: FILAMENT_SOURCES.orcaMain })
  })
  it('marks every filament setting advanced, except material, brand and color', () => {
    for (const d of SETTINGS.filter((s) => s.section === 'filament')) expect(d.mode, d.key).toBe(['filament_type', 'filament_vendor', 'default_filament_colour'].includes(d.key) ? 'simple' : d.group === 'profile' && d.key !== 'filament_notes' ? 'hidden' : 'advanced')
    expect(settingDef('filament_type')?.mode).toBe('simple')
  })
  it('matches the lock file', async () => {
    const now = await table()
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(lockPath, JSON.stringify({ comment: 'FNV-1a of each vendor file, and of the sorted-key JSON of every variant of each product. Written by js/filaments.test.ts (UPDATE_GOLDEN=1) after the private parity check passes; the Rust test must match.', orcaCommit: FILAMENT_SOURCES.orcaSlicer, orcaMainCommit: FILAMENT_SOURCES.orcaMain, bambuStudioCommit: FILAMENT_SOURCES.bambuStudio, ...now }, null, 1) + '\n')
      return
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { orcaCommit: string; orcaMainCommit: string; bambuStudioCommit: string; files: Record<string, string>; families: Record<string, string> }
    expect(lock.orcaCommit).toBe(FILAMENT_SOURCES.orcaSlicer)
    expect(lock.bambuStudioCommit).toBe(FILAMENT_SOURCES.bambuStudio)
    expect(lock.orcaMainCommit).toBe(FILAMENT_SOURCES.orcaMain)
    expect(now.files).toEqual(lock.files)
    expect(now.families).toEqual(lock.families)
  })
})
