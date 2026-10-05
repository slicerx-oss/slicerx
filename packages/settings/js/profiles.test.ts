// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listFilamentProfiles, listPrinterProfiles, listProcessPresets, printerConfig, filamentConfig, filamentSources, processConfig, profileConfig, printerProfile } from './profiles'
import { K } from './knowledge'
import { settingDef } from './schema'
import { validate } from './validate'

const catalogPath = fileURLToPath(new URL('../../connect/catalog/src/index.ts', import.meta.url))

describe('printer profiles', () => {
  it('has one per catalog model, with a maker source and a flavor', () => {
    const ps = listPrinterProfiles()
    expect(ps).toHaveLength(64)
    for (const p of ps) {
      expect(p.sources.length, p.id).toBeGreaterThan(0)
      for (const s of p.sources) expect(s, p.id).toMatch(/^https:\/\//)
      expect(['marlin', 'marlin2', 'klipper', 'reprapfirmware', 'griffin', 'cheetah'], p.id).toContain(p.flavor)
      expect(p.nozzles, p.id).toContain(p.defaultNozzle)
    }
    expect(new Set(ps.map((p) => p.id)).size).toBe(64)
  })
  it('agrees with the printer catalog when it is present', async () => {
    if (!existsSync(catalogPath)) return
    const { PRINTER_MODELS } = (await import(/* @vite-ignore */ catalogPath)) as { PRINTER_MODELS: { id: string; buildVolume: unknown; nozzles: number[]; kinematics: string }[] }
    expect(PRINTER_MODELS.map((m) => m.id)).toEqual(listPrinterProfiles().map((p) => p.id))
    for (const m of PRINTER_MODELS) {
      const p = printerProfile(m.id)
      expect(p?.buildVolume, m.id).toEqual(m.buildVolume)
      expect(p?.nozzles, m.id).toEqual(m.nozzles)
      expect(p?.kinematics, m.id).toBe(m.kinematics)
    }
  })
  it('builds a config of known keys with the bed, nozzle and limits', () => {
    const c = printerConfig('bambu-x1-carbon', 0.6) as Record<string, unknown>
    expect(c).toMatchObject({ printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]], printable_height: 250, nozzle_diameter: [0.6], gcode_flavor: 'marlin', machine_max_acceleration_extruding: [20000, 20000, 20000, 20000] })
    for (const p of listPrinterProfiles()) for (const k of Object.keys(printerConfig(p.id) ?? {})) expect(settingDef(k), `${p.id} ${k}`).toBeDefined()
    const delta = printerConfig('flsun-v400') as Record<string, unknown>
    expect((delta['printable_area'] as number[][]).length).toBe(72)
    expect(printerConfig('nope')).toBeUndefined()
  })
})

describe('filament profiles', () => {
  it('has one per material, from the knowledge base, with sources', () => {
    expect(listFilamentProfiles().map((f) => f.id)).toEqual(Object.keys(K.materials))
    const petg = filamentConfig('petg') as Record<string, unknown>
    expect(petg['nozzle_temperature']).toEqual([245])
    for (const id of Object.keys(K.materials)) {
      expect(filamentSources(id).length, id).toBeGreaterThan(0)
      for (const k of Object.keys(filamentConfig(id) ?? {})) expect(settingDef(k), `${id} ${k}`).toBeDefined()
    }
    expect(filamentConfig('nope')).toBeUndefined()
  })
})

describe('process presets', () => {
  it('has quality tiers per nozzle with layer heights inside the nozzle limits', () => {
    for (const n of [0.2, 0.4, 0.6, 0.8]) {
      const presets = listProcessPresets(n)
      expect(presets.map((p) => p.id)).toEqual(['draft', 'standard', 'fine', 'extra_fine', 'strong'])
      for (const p of presets) {
        expect(p.layerHeight, `${n} ${p.id}`).toBeGreaterThanOrEqual(0.2 * n - 1e-9)
        expect(p.layerHeight, `${n} ${p.id}`).toBeLessThanOrEqual(0.75 * n + 1e-9)
      }
    }
    expect(listProcessPresets(0.4).map((p) => p.label)).toEqual(['0.28 mm Draft', '0.20 mm Standard', '0.12 mm Fine', '0.08 mm Extra fine', '0.20 mm Strong'])
    expect(processConfig('nope')).toBeUndefined()
  })
  it('merges into a config that validates without errors, for every printer and material', () => {
    for (const p of listPrinterProfiles()) {
      for (const filament of ['pla', 'petg', 'tpu_95a']) {
        const cfg = profileConfig({ printer: p.id, filament })
        expect(cfg, p.id).toBeDefined()
        const errors = validate(cfg as never, { filament }).filter((i) => i.severity === 'error')
        expect(errors.map((e) => `${p.id} ${e.code}`)).toEqual([])
      }
    }
    expect(profileConfig({ printer: 'nope' })).toBeUndefined()
  })
})

// Both languages must build the same configs. Run with UPDATE_GOLDEN=1 to rewrite fixtures/profiles-golden.json.
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v)
const hash = (cfg: unknown): string => fnv(JSON.stringify(canon(cfg)))

function goldenTable(): Record<string, string> {
  const t: Record<string, string> = {}
  for (const p of listPrinterProfiles()) {
    t[`printer ${p.id}`] = hash(printerConfig(p.id))
    t[`printer ${p.id} 0.6`] = hash(printerConfig(p.id, 0.6))
  }
  for (const id of Object.keys(K.materials)) {
    t[`filament ${id}`] = hash(filamentConfig(id))
    t[`filament ${id} high_flow`] = hash(filamentConfig(id, { hotend: 'high_flow' }))
    t[`sources ${id}`] = fnv(filamentSources(id).join('\u0001'))
  }
  for (const n of [0.2, 0.4, 0.6, 0.8]) {
    for (const pr of listProcessPresets(n)) {
      t[`process ${pr.id} ${n}`] = hash(processConfig(pr.id, n))
      t[`label ${pr.id} ${n}`] = fnv(pr.label)
    }
  }
  for (const printer of ['bambu-p2s', 'bambu-h2d', 'bambu-h2s', 'bambu-x1-carbon', 'bambu-a1', 'prusa-mk4s', 'prusa-core-one', 'creality-k1', 'elegoo-neptune-4', 'snapmaker-u1', 'voron-2.4-300', 'flsun-v400', 'generic-klipper']) {
    for (const pr of listProcessPresets(0.4, printer)) {
      t[`process ${pr.id} 0.4 ${printer}`] = hash(processConfig(pr.id, 0.4, printer))
      t[`label ${pr.id} 0.4 ${printer}`] = fnv(pr.label)
    }
  }
  for (const [printer, filament, process] of [['bambu-x1-carbon', 'pla', 'fine'], ['prusa-mk4s', 'petg', 'strong'], ['voron-2.4-300', 'tpu_95a', 'draft'], ['flsun-v400', 'abs', undefined]] as const) {
    t[`merged ${printer} ${filament} ${process ?? ''}`] = hash(profileConfig({ printer, filament, ...(process ? { process } : {}) }))
  }
  return t
}

const goldenPath = fileURLToPath(new URL('../fixtures/profiles-golden.json', import.meta.url))
describe('profile golden file', () => {
  if (process.env['UPDATE_GOLDEN'] === '1') {
    it('rewrites the golden file', () => {
      writeFileSync(goldenPath, JSON.stringify({ comment: 'Written by js/profiles.test.ts (UPDATE_GOLDEN=1). FNV-1a hashes of the sorted-key JSON of each profile config; the Rust tests must match.', hashes: goldenTable() }, null, 1) + '\n')
    })
    return
  }
  it('matches', () => {
    const file = JSON.parse(readFileSync(goldenPath, 'utf8')) as { hashes: Record<string, string> }
    expect(goldenTable()).toEqual(file.hashes)
  })
})
