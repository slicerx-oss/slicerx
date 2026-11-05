// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Studio 2.8 overlay (packages/profiles/overlays/bbl-2.8.json) is in the shipped Bambu Lab data: applying it
// again changes nothing, so a regeneration that dropped it fails here. Rerun scripts/apply-overlay.ts after regenerating.
// The MK4 IS lift and retraction (packages/profiles/overlays/prusa-mk4is.json) is checked the same way, in
// resolved/prusa.json and machine.json, and the Prusa brim (packages/profiles/overlays/prusa-brim.json) and the MK4 and MINI
// first layer (packages/profiles/overlays/prusa-first-layer.json) in resolved/prusa.json. The plain Ender-3 V3 widths
// (packages/profiles/overlays/creality-ender-3-v3.json) are checked the same way in process-speeds.json.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyFilamentOverlay, applyMachineOverlay, applyProcessPresetOverlay, applyResolvedOverlay, BBL_OVERLAY, CREALITY_V3_OVERLAY, MAKER_OVERLAYS, PRUSA_BRIM_OVERLAY, PRUSA_FIRST_LAYER_OVERLAY, PRUSA_OVERLAY, type MachineFile, type MakerOverlay, type ResolvedBrand, type SpeedsFile, type VendorData } from './overlay'
import { printerConfig, printerProfile, processConfig, processSpeedSource } from './profiles'
import { resolvedProfile } from './resolved'
import { loadFilamentPreset } from './filaments'
import { defaultConfig } from './schema'
import { stockLayer } from './stock-layer'

const profiles = fileURLToPath(new URL('../../profiles/', import.meta.url))
const read = <T>(path: string): T => JSON.parse(readFileSync(profiles + path, 'utf8')) as T
const overlay = read<MakerOverlay>(BBL_OVERLAY)
const nozzle = (model: string): number => printerProfile(model)?.defaultNozzle ?? 0.4

describe('Bambu Studio 2.8 overlay', () => {
  it('is applied to filaments/BBL.json', () => {
    const shipped = readFileSync(profiles + 'filaments/BBL.json', 'utf8')
    const file = JSON.parse(shipped) as VendorData
    applyFilamentOverlay(file, overlay)
    expect(JSON.stringify(file)).toBe(shipped)
  })

  it('is applied to resolved/bambu-lab.json', () => {
    const shipped = readFileSync(profiles + 'resolved/bambu-lab.json', 'utf8')
    const data = JSON.parse(shipped) as ResolvedBrand
    applyResolvedOverlay(data, overlay, nozzle)
    expect(JSON.stringify(data) + '\n').toBe(shipped)
  })

  it('gives the presets Bambu Studio 2.8 values', async () => {
    const asa = await loadFilamentPreset('BBL', 'Bambu ASA-CF', 'BBL X1C')
    expect(asa!.config['pre_start_fan_time']).toEqual([3])
    const abs = await loadFilamentPreset('BBL', 'Bambu ABS', 'BBL X1C')
    expect(abs!.config['filament_cooling_before_tower']).toEqual([0])
    const x1c = await resolvedProfile('bambu-x1-carbon', 'standard')
    expect(x1c!.process['sparse_infill_pattern']).toBe('grid')
    // Our by-object clearance stays until it is checked on a printer.
    expect(x1c!.machine['extruder_clearance_radius']).toBe(68)
    // A tier the overlay writes over keeps its own values on top of the new base.
    const fine = await resolvedProfile('bambu-x1-carbon', 'fine')
    expect(fine!.process['layer_height']).toBe(0.12)
    expect(fine!.process['bottom_color_penetration_layers']).toBe(5)
    // 0.12mm High Quality keeps gyroid infill in Bambu Studio 2.8, so the tier still differs from the new base there.
    expect(fine!.process['sparse_infill_pattern'] ?? defaultConfig()['sparse_infill_pattern']).toBe('gyroid')
  })

  it('gives every process tier of every model and nozzle internal bridges at the bridge speed', () => {
    const data = read<ResolvedBrand>('resolved/bambu-lab.json')
    expect(overlay.every_process?.values).toEqual({ internal_bridge_speed: '100%', precise_outer_wall: '0' })
    let parts = 0
    for (const [model, entry] of Object.entries(data.models)) {
      for (const [size, part] of [['default', entry] as const, ...Object.entries(entry.nozzles ?? {})]) {
        expect((part.process[part.base] as Record<string, unknown>)['internal_bridge_speed'], `${model} ${size}`).toEqual(['100%'])
        for (const [tier, p] of Object.entries(part.process)) {
          if (tier === part.base) continue
          const d = p as { set: Record<string, unknown>; unset: string[] }
          expect('internal_bridge_speed' in d.set || d.unset.includes('internal_bridge_speed'), `${model} ${size} ${tier}`).toBe(false)
        }
        parts++
      }
    }
    expect(parts).toBeGreaterThan(40)
    // The schema default stays for every other printer.
    expect(defaultConfig()['internal_bridge_speed']).toEqual(['150%'])
  })

  it('turns precise outer wall off on every process tier of every model and nozzle', async () => {
    const data = read<ResolvedBrand>('resolved/bambu-lab.json')
    let parts = 0
    for (const [model, entry] of Object.entries(data.models)) {
      for (const [size, part] of [['default', entry] as const, ...Object.entries(entry.nozzles ?? {})]) {
        // Off is the schema default, so no tier stores the key.
        for (const [tier, p] of Object.entries(part.process)) {
          const d = tier === part.base ? { set: p as Record<string, unknown>, unset: [] } : (p as { set: Record<string, unknown>; unset: string[] })
          expect('precise_outer_wall' in d.set || d.unset.includes('precise_outer_wall'), `${model} ${size} ${tier}`).toBe(false)
        }
        parts++
      }
    }
    expect(parts).toBeGreaterThan(40)
    expect(defaultConfig()['precise_outer_wall']).toBe(false)
    for (const tier of ['standard', 'fine', 'draft']) {
      const p1s = await resolvedProfile('bambu-p1s', tier)
      expect(p1s!.process['precise_outer_wall'] ?? defaultConfig()['precise_outer_wall'], tier).toBe(false)
    }
    // Other makers keep their presets' value.
    const mk4s = await resolvedProfile('prusa-mk4s', 'standard')
    expect(mk4s!.process['precise_outer_wall']).toBe(true)
  })

  it('names a preset, model, nozzle and tier the data has for every entry', () => {
    const data = read<ResolvedBrand>('resolved/bambu-lab.json')
    for (const [model, sizes] of Object.entries(overlay.process)) {
      for (const [size, tiers] of Object.entries(sizes)) {
        const part = Number(size) === nozzle(model) ? data.models[model] : data.models[model]?.nozzles?.[size]
        expect(part, `${model} ${size}`).toBeDefined()
        for (const [tier, o] of Object.entries(tiers)) {
          expect(part!.process[tier], `${model} ${size} ${tier}`).toBeDefined()
          expect(o.preset).toMatch(/@BBL/)
        }
      }
    }
  })
})

describe('MK4 IS lift and retraction for the stock MK4', () => {
  const prusa = read<MakerOverlay>(PRUSA_OVERLAY)
  const owner = { z_hop: [0.2], retraction_length: [0.7], retract_lift_below: [219], travel_slope: [1] }
  const generic = { z_hop: [0.4], retraction_length: [0.8], retract_lift_below: [0], travel_slope: [3] }
  const pick = (cfg: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.keys(owner).map((k) => [k, cfg[k] ?? defaultConfig()[k as never]]))

  it('is applied to resolved/prusa.json and machine.json', () => {
    for (const path of ['resolved/prusa.json', 'machine.json']) {
      const shipped = readFileSync(profiles + path, 'utf8')
      if (path === 'machine.json') {
        const file = JSON.parse(shipped) as MachineFile
        applyMachineOverlay(file, prusa, nozzle)
        expect(JSON.stringify(file, null, 1) + '\n', path).toBe(shipped)
      } else {
        const data = JSON.parse(shipped) as ResolvedBrand
        applyResolvedOverlay(data, prusa, nozzle)
        expect(JSON.stringify(data) + '\n', path).toBe(shipped)
      }
    }
  })

  it('sets only the four values, on the 0.4 mm nozzle of the MK4', () => {
    expect(Object.keys(prusa.machine)).toEqual(['prusa-mk4'])
    expect(Object.keys(prusa.machine['prusa-mk4']!)).toEqual(['0.4'])
    expect(Object.keys(prusa.machine['prusa-mk4']!['0.4']!.values).sort()).toEqual(Object.keys(owner).sort())
    expect(prusa.filament).toEqual({})
    expect(prusa.process).toEqual({})
  })

  it('gives the MK4 printer profile and its stock presets the MK4 IS values and keeps the other nozzles', async () => {
    expect(pick(printerConfig('prusa-mk4') as unknown as Record<string, unknown>)).toEqual(owner)
    expect(pick((await resolvedProfile('prusa-mk4', 'standard'))!.machine as unknown as Record<string, unknown>)).toEqual(owner)
    for (const n of [0.25, 0.6, 0.8]) {
      expect(pick(printerConfig('prusa-mk4', n) as unknown as Record<string, unknown>), `${n}`).toEqual(generic)
      expect(pick((await resolvedProfile('prusa-mk4', 'standard', n))!.machine as unknown as Record<string, unknown>), `${n}`).toEqual(generic)
    }
    // The MK4S has its own values from the maker and is not overlaid.
    expect(pick(printerConfig('prusa-mk4s') as unknown as Record<string, unknown>)).toEqual(owner)
  })
})

describe('Prusa brim for every process tier', () => {
  const brim = read<MakerOverlay>(PRUSA_BRIM_OVERLAY)

  it('is applied to resolved/prusa.json', () => {
    const shipped = readFileSync(profiles + 'resolved/prusa.json', 'utf8')
    const data = JSON.parse(shipped) as ResolvedBrand
    applyResolvedOverlay(data, brim, nozzle)
    expect(JSON.stringify(data) + '\n').toBe(shipped)
  })

  it('sets only the two brim keys, on every tier', () => {
    expect(brim.every_process?.values).toEqual({ brim_loop_rounding: 'whole', brim_use_efc_outline: '1' })
    expect(brim.machine).toEqual({})
    expect(brim.process).toEqual({})
    expect(brim.filament).toEqual({})
  })

  it('gives every Prusa model, nozzle and tier whole loops from the compensated outline', () => {
    const data = read<ResolvedBrand>('resolved/prusa.json')
    let parts = 0
    for (const [model, entry] of Object.entries(data.models)) {
      for (const [size, part] of [['default', entry] as const, ...Object.entries(entry.nozzles ?? {})]) {
        const base = part.process[part.base] as Record<string, unknown>
        expect(base['brim_loop_rounding'], `${model} ${size}`).toBe('whole')
        expect(base['brim_use_efc_outline'], `${model} ${size}`).toBe(true)
        for (const [tier, p] of Object.entries(part.process)) {
          if (tier === part.base) continue
          const d = p as { set: Record<string, unknown>; unset: string[] }
          for (const k of ['brim_loop_rounding', 'brim_use_efc_outline']) expect(k in d.set || d.unset.includes(k), `${model} ${size} ${tier} ${k}`).toBe(false)
        }
        parts++
      }
    }
    expect(parts).toBeGreaterThan(20)
  })

  it('reaches the printer layer of the Prusa catalog printers and no other maker', async () => {
    for (const printerId of ['prusa-mk4', 'prusa-mk4s', 'prusa-mini-plus', 'prusa-xl', 'prusa-xl-5-toolhead', 'prusa-core-one', 'prusa-core-one-l']) {
      for (const tier of ['draft', 'standard', 'fine', 'strong'] as const) {
        const layer = await stockLayer({ printerId, tier, slots: [] })
        expect(layer!.values['brim_loop_rounding'], `${printerId} ${tier}`).toBe('whole')
        expect(layer!.values['brim_use_efc_outline'], `${printerId} ${tier}`).toBe(true)
      }
    }
    for (const printerId of ['bambu-p1s', 'bambu-a1', 'creality-k1']) {
      const layer = await stockLayer({ printerId, tier: 'standard', slots: [] })
      expect(layer!.values['brim_loop_rounding'], printerId).toBeUndefined()
      expect(layer!.values['brim_use_efc_outline'] ?? false, printerId).toBe(false)
    }
  })
})

describe('Prusa MK4 and MINI first layer', () => {
  const first = read<MakerOverlay>(PRUSA_FIRST_LAYER_OVERLAY)
  // The stock MK4 IS and MINI IS print presets, every nozzle: first layer line width and elephant foot compensation.
  // Brim separation is 0 in every stock 0.25 mm preset; the other nozzles keep the catalog's 0.1 mm gap.
  const stock: Record<string, { width: string; efc: number | undefined; gap?: number }> = {
    '0.25': { width: '0.32', efc: undefined, gap: 0 },
    '0.4': { width: '0.5', efc: 0.2 },
    '0.6': { width: '0.68', efc: 0.2 },
    '0.8': { width: '1', efc: 0.2 },
  }

  it('is applied to resolved/prusa.json', () => {
    const shipped = readFileSync(profiles + 'resolved/prusa.json', 'utf8')
    const data = JSON.parse(shipped) as ResolvedBrand
    applyResolvedOverlay(data, first, nozzle)
    expect(JSON.stringify(data) + '\n').toBe(shipped)
  })

  it('writes only the first layer keys, and the brim gap on the 0.25 mm nozzle, on the MK4 and the MINI', () => {
    expect(Object.keys(first.process).sort()).toEqual(['prusa-mini-plus', 'prusa-mk4'])
    for (const [model, sizes] of Object.entries(first.process)) {
      for (const [size, tiers] of Object.entries(sizes)) {
        for (const [tier, o] of Object.entries(tiers)) {
          const want: Record<string, string> = { initial_layer_line_width: stock[size]!.width }
          if (stock[size]!.efc !== undefined) want['elefant_foot_compensation'] = String(stock[size]!.efc)
          if (stock[size]!.gap !== undefined) want['brim_object_gap'] = String(stock[size]!.gap)
          expect(o.values, `${model} ${size} ${tier}`).toEqual(want)
        }
      }
    }
    expect(first.machine).toEqual({})
    expect(first.filament).toEqual({})
    expect(first.every_process).toBeUndefined()
  })

  it('gives every MK4 and MINI nozzle and tier the stock first layer', async () => {
    for (const printerId of ['prusa-mk4', 'prusa-mini-plus']) {
      for (const size of printerProfile(printerId)!.nozzles) {
        for (const tier of ['draft', 'standard', 'fine', 'strong'] as const) {
          const layer = await stockLayer({ printerId, tier, slots: [], nozzle: size })
          const want = stock[String(size)]!
          expect(layer!.nozzle, `${printerId} ${size} ${tier}`).toBe(size)
          expect(layer!.values['initial_layer_line_width'], `${printerId} ${size} ${tier}`).toBe(want.width)
          expect(layer!.values['elefant_foot_compensation'] ?? 0, `${printerId} ${size} ${tier}`).toBe(want.efc ?? 0)
          expect(layer!.values['brim_object_gap'] ?? defaultConfig()['brim_object_gap'], `${printerId} ${size} ${tier}`).toBe(want.gap ?? 0.1)
          // The whole brim keys still reach every tier, so the gap to the part stays the brim gap at this compensation.
          expect(layer!.values['brim_use_efc_outline'], `${printerId} ${size} ${tier}`).toBe(true)
          expect(layer!.values['brim_loop_rounding'], `${printerId} ${size} ${tier}`).toBe('whole')
        }
      }
    }
  })

  it('leaves the other Prusa models as they were', async () => {
    const mk4s = await stockLayer({ printerId: 'prusa-mk4s', tier: 'standard', slots: [] })
    expect(mk4s!.values['initial_layer_line_width']).toBe('0.5')
    expect(mk4s!.values['elefant_foot_compensation']).toBe(0.2)
  })
})

describe('process preset overlay', () => {
  const file = (): SpeedsFile => ({ presets: { 'A/a': { travel_speed: '300', default_jerk: '9' }, 'A/b': { travel_speed: '200' } }, models: { m: { standard: 'A/a' } } })

  it('writes raw values into the named preset only, keys sorted, and twice changes nothing', () => {
    const f = file()
    const o: MakerOverlay = { filament: {}, machine: {}, process: {}, process_presets: { 'A/a': { support_line_width: '0.42', initial_layer_line_width: '0.5' } } }
    applyProcessPresetOverlay(f, o)
    expect(Object.keys(f.presets['A/a']!)).toEqual(['default_jerk', 'initial_layer_line_width', 'support_line_width', 'travel_speed'])
    expect(f.presets['A/a']).toEqual({ default_jerk: '9', initial_layer_line_width: '0.5', support_line_width: '0.42', travel_speed: '300' })
    expect(f.presets['A/b']).toEqual({ travel_speed: '200' })
    const once = JSON.stringify(f)
    applyProcessPresetOverlay(f, o)
    expect(JSON.stringify(f)).toBe(once)
    // An overlay without the section leaves the file alone.
    applyProcessPresetOverlay(f, { filament: {}, machine: {}, process: {} })
    expect(JSON.stringify(f)).toBe(once)
  })

  it('refuses a preset the file does not have and a key the schema does not know', () => {
    expect(() => applyProcessPresetOverlay(file(), { filament: {}, machine: {}, process: {}, process_presets: { 'A/c': { travel_speed: '1' } } })).toThrow(/no process preset A\/c/)
    expect(() => applyProcessPresetOverlay(file(), { filament: {}, machine: {}, process: {}, process_presets: { 'A/a': { not_a_setting: '1' } } })).toThrow(/not a setting/)
  })
})

describe('Ender-3 V3 first layer and support widths', () => {
  const v3 = (): MakerOverlay => read<MakerOverlay>(CREALITY_V3_OVERLAY)
  const tiers = ['draft', 'standard', 'fine', 'extra_fine', 'strong'] as const

  it('is applied to process-speeds.json and listed with the maker overlays', () => {
    const shipped = readFileSync(profiles + 'process-speeds.json', 'utf8')
    const f = JSON.parse(shipped) as SpeedsFile
    applyProcessPresetOverlay(f, v3())
    expect(JSON.stringify(f)).toBe(shipped)
    expect(MAKER_OVERLAYS.find((o) => o.path === CREALITY_V3_OVERLAY)).toMatchObject({ processSpeeds: true, machineJson: false })
  })

  it('writes only the two widths, on the plain Ender-3 V3 presets no other model uses', () => {
    const f = read<SpeedsFile>('process-speeds.json')
    const own = new Set(tiers.map((t) => processSpeedSource('creality-ender-3-v3', t)))
    expect(Object.keys(v3().process_presets ?? {}).sort()).toEqual([...own].sort())
    for (const [name, values] of Object.entries(v3().process_presets ?? {})) {
      expect(values, name).toEqual({ initial_layer_line_width: '0.5', support_line_width: '0.42' })
      const users = Object.entries(f.models).filter(([, m]) => Object.values(m).includes(name)).map(([id]) => id)
      expect(users, name).toEqual(['creality-ender-3-v3'])
    }
    expect(v3().machine).toEqual({})
    expect(v3().process).toEqual({})
    expect(v3().filament).toEqual({})
    expect(v3().every_process).toBeUndefined()
  })

  it('gives every tier of the plain Ender-3 V3 the stock widths on the 0.4 mm nozzle', async () => {
    for (const tier of ['draft', 'standard', 'fine', 'strong'] as const) {
      const layer = await stockLayer({ printerId: 'creality-ender-3-v3', tier, slots: [] })
      expect(layer!.nozzle, tier).toBe(0.4)
      expect(layer!.source, tier).toBe('slicerx')
      expect(layer!.values['initial_layer_line_width'], tier).toBe('0.5')
      expect(layer!.values['support_line_width'], tier).toBe('0.42')
      // The other widths stay SlicerX's 0.42 mm.
      expect(layer!.values['line_width'], tier).toBe('0.42')
      expect(layer!.values['outer_wall_line_width'], tier).toBe('0.42')
    }
  })

  it('leaves the other nozzles and the other Ender-3 V3 models as they were', async () => {
    for (const nozzle of [0.6, 0.8]) {
      const layer = await stockLayer({ printerId: 'creality-ender-3-v3', tier: 'standard', slots: [], nozzle })
      expect(layer!.nozzle).toBe(nozzle)
      expect(layer!.values['initial_layer_line_width'] ?? '0', `${nozzle}`).toBe('0')
      expect(layer!.values['support_line_width'] ?? '0', `${nozzle}`).toBe('0')
    }
    for (const printerId of ['creality-ender-3-v3-se', 'creality-ender-3-v3-ke', 'creality-ender-3-v3-plus', 'creality-k1']) {
      const cfg = processConfig('standard', 0.4, printerId) as unknown as Record<string, unknown>
      expect(cfg['initial_layer_line_width'], printerId).toBeUndefined()
      expect(cfg['support_line_width'], printerId).toBeUndefined()
    }
  })
})
