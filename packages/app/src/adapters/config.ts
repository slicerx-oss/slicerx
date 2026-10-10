// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The resolved config for a plate, without the settings schema: the defaults, then Easy mode, then Expert
// overrides. Startup paths (slicing, export, the command bar's goals) use this; it needs only the defaults table
// and the Easy map, about 10 KB gzip. Labels, ranges and tiers live in ./settings and load on demand (./load).
import type { EasyGoal, EasySettings, PrintConfig, SettingValue } from '@slicerx/contracts'
import { defaultConfig } from '@slicerx/settings/defaults'
import { applyEasy, goalEasy, matchGoal } from '@slicerx/settings/easy'
import { GENERIC_BED, bedSettings } from './generic-bed'

export { goalEasy, matchGoal }

let base: PrintConfig | null = null

/** Schema defaults. Every required PrintConfig key has a schema default, which the settings tests check. */
export function baseConfig(): PrintConfig {
  base ??= defaultConfig() as PrintConfig
  return base
}

/** What a printer's shipped presets contribute under the Easy choices, and which Easy controls the person has moved. */
let profile: { values: Record<string, SettingValue>; touched: ReadonlySet<string> } | null = null

/**
 * Sets the printer, filament and process layer (null for none). With a layer, Easy mode changes only the controls the
 * person moved, plus sleipnir, so the maker's own values stand until they ask for something else.
 */
export function setProfileLayer(values: Record<string, SettingValue> | null, touched: readonly string[]): void {
  profile = values ? { values, touched: new Set([...touched, 'smartLayer', 'varyLayerHeight']) } : null
}

export function hasProfileLayer(): boolean {
  return profile !== null
}

/**
 * SlicerX's own defaults on top of a maker's process preset. The vendor presets carry the vendor's wall generator
 * (arachne on MK4S and K1, classic on Bambu Lab), so without this the stock presets would never use aegis. The vendor
 * data stays as it is; the layer applies only while the person has not set the key themselves.
 */
export const SLICERX_PRESET_DEFAULTS: Readonly<Record<string, SettingValue>> = { wall_generator: 'aegis' }

/**
 * What the maker's preset says for a key SlicerX takes over, when it says something else: the value "Use this
 * preset's own" would restore. Null without a maker preset, or when it agrees with SlicerX.
 */
export function presetOwnValue(key: string): SettingValue | null {
  const mine = SLICERX_PRESET_DEFAULTS[key]
  const theirs = profile?.values[key]
  if (!profile || mine === undefined || theirs === undefined) return null
  const text = (v: SettingValue): string => String(Array.isArray(v) ? v[0] : v)
  return text(theirs) === text(mine) ? null : theirs
}

export function resolveConfig(easy: EasySettings, overrides: Record<string, SettingValue>): PrintConfig {
  // Without a printer the plate is the generic bed, not the schema's 200 mm default, so the slice and its preflight match the plate.
  const out = profile ? applyEasy(easy, { ...baseConfig(), ...profile.values } as PrintConfig, profile.touched) : applyEasy(easy, { ...baseConfig(), ...bedSettings(GENERIC_BED) } as PrintConfig)
  if (profile) for (const [k, v] of Object.entries(SLICERX_PRESET_DEFAULTS)) if (!(k in overrides)) out[k] = v
  for (const [k, v] of Object.entries(overrides)) out[k] = v
  return out
}

/**
 * Where the Detail and Strength sliders stand for a configuration that did not come from them: the position whose layer
 * height, and whose walls and infill, are nearest the ones the printer's preset has. With a maker preset under the
 * Easy controls, the sliders show what the preset does until the person moves them.
 */
export function inferEasy(cfg: PrintConfig, easy: EasySettings): { detail: number; strength: number } {
  const num = (v: SettingValue | undefined): number => (Array.isArray(v) ? Number(v[0]) : Number(v))
  const layer = num(cfg['layer_height'])
  const walls = num(cfg['wall_loops'])
  const infill = num(String(Array.isArray(cfg['sparse_infill_density']) ? cfg['sparse_infill_density'][0] : cfg['sparse_infill_density']).replace('%', ''))
  let detail = easy.detail
  let bestD = Number.POSITIVE_INFINITY
  let strength = easy.strength
  let bestS = Number.POSITIVE_INFINITY
  for (let v = 0; v <= 100; v += 5) {
    const a = applyEasy({ ...easy, detail: v }, cfg, new Set(['detail']))
    const dd = Math.abs(num(a['layer_height']) - layer)
    if (dd < bestD - 1e-9) {
      bestD = dd
      detail = v
    }
    const b = applyEasy({ ...easy, strength: v }, cfg, new Set(['strength']))
    const ds = Math.abs(num(b['wall_loops']) - walls) * 10 + Math.abs(num(String(Array.isArray(b['sparse_infill_density']) ? b['sparse_infill_density'][0] : b['sparse_infill_density']).replace('%', '')) - infill)
    if (ds < bestS - 1e-9) {
      bestS = ds
      strength = v
    }
  }
  return { detail, strength }
}

export function easyConfig(easy: EasySettings): PrintConfig {
  return profile ? applyEasy(easy, { ...baseConfig(), ...profile.values } as PrintConfig, profile.touched) : applyEasy(easy, baseConfig())
}

/** easyConfig with `controls` applied as if the person had moved them: what a choice for one object gives. */
export function easyConfigFor(easy: EasySettings, controls: readonly string[]): PrintConfig {
  return profile ? applyEasy(easy, { ...baseConfig(), ...profile.values } as PrintConfig, new Set([...profile.touched, ...controls])) : applyEasy(easy, baseConfig())
}

export const GOALS: readonly EasyGoal[] = ['draft', 'standard', 'fine', 'strong']

export function isGoal(v: string): v is EasyGoal {
  return (GOALS as readonly string[]).includes(v)
}
