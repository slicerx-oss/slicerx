// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Studio 2.8 overlay (packages/profiles/overlays/bbl-2.8.json) is in the shipped Bambu Lab data: applying it
// again changes nothing, so a regeneration that dropped it fails here. Rerun scripts/apply-overlay.ts after regenerating.
// The MK4 IS lift and retraction (packages/profiles/overlays/prusa-mk4is.json) is checked the same way, in
// resolved/prusa.json and machine.json.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyFilamentOverlay, applyMachineOverlay, applyResolvedOverlay, BBL_OVERLAY, PRUSA_OVERLAY, type MachineFile, type MakerOverlay, type ResolvedBrand, type VendorData } from './overlay'
import { printerConfig, printerProfile } from './profiles'
import { resolvedProfile } from './resolved'
import { loadFilamentPreset } from './filaments'
import { defaultConfig } from './schema'

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
    expect(overlay.every_process?.values).toEqual({ internal_bridge_speed: '100%' })
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
