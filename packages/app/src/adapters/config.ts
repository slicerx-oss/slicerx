// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The resolved config for a plate, without the settings schema: the defaults, then Easy mode, then Expert
// overrides. Startup paths (slicing, export, the command bar's goals) use this; it needs only the defaults table
// and the Easy map, about 10 KB gzip. Labels, ranges and tiers live in ./settings and load on demand (./load).
import type { EasyGoal, EasySettings, PrintConfig, SettingValue } from '@slicerx/contracts'
import { defaultConfig } from '@slicerx/settings/defaults'
import { applyEasy, goalEasy, layerConfig, matchGoal, presetDefaults, SLICERX_PRESET_DEFAULTS } from '@slicerx/settings/easy'
import { GENERIC_BED, bedSettings } from './generic-bed'

export { goalEasy, matchGoal }

let base: PrintConfig | null = null

/** Schema defaults. Every required PrintConfig key has a schema default, which the settings tests check. */
export function baseConfig(): PrintConfig {
  base ??= defaultConfig() as PrintConfig
  return base
}

/** What a printer's shipped presets contribute under the Easy choices, and which Easy controls the person has moved. */
type ProfileLayer = { values: Record<string, SettingValue>; touched: ReadonlySet<string> }
let profile: ProfileLayer | null = null

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

/** The profile layer in use, as a value that changes whenever setProfileLayer replaces it (null for none): a cache key. */
export function profileLayerToken(): object | null {
  return profile
}

// SlicerX's own defaults on top of a maker's process preset (wall_generator aegis, not on Bambu Lab printers), shared
// with the MCP server.
export { SLICERX_PRESET_DEFAULTS }

/**
 * What the maker's preset says for a key SlicerX takes over, when it says something else: the value "Use this
 * preset's own" would restore. Null without a maker preset, or when it agrees with SlicerX.
 */
export function presetOwnValue(key: string): SettingValue | null {
  if (!profile) return null
  const mine = presetDefaults(profile.values)[key]
  const theirs = profile.values[key]
  if (mine === undefined || theirs === undefined) return null
  const text = (v: SettingValue): string => String(Array.isArray(v) ? v[0] : v)
  return text(theirs) === text(mine) ? null : theirs
}

function computeConfig(easy: EasySettings, overrides: Record<string, SettingValue>): PrintConfig {
  // Without a printer the plate is the generic bed, not the schema's 200 mm default, so the slice and its preflight match the plate.
  const out = profile ? (layerConfig(profile.values, easy, profile.touched) as PrintConfig) : applyEasy(easy, { ...baseConfig(), ...bedSettings(GENERIC_BED) } as PrintConfig)
  for (const [k, v] of Object.entries(overrides)) out[k] = v
  return out
}

/** The last resolved config and what it was built from. The store replaces easy and overrides on every change, so the references are the key. */
let last: { easy: EasySettings; overrides: Record<string, SettingValue>; profile: ProfileLayer | null; config: PrintConfig } | null = null

/**
 * The defaults, the profile layer, Easy mode and the overrides, in that order. Store subscribers call this on every store
 * write, so the last result is kept until easy, overrides or the profile layer is a new object.
 */
export function resolveConfig(easy: EasySettings, overrides: Record<string, SettingValue>): PrintConfig {
  let hit = last
  if (!hit || hit.easy !== easy || hit.overrides !== overrides || hit.profile !== profile) hit = last = { easy, overrides, profile, config: computeConfig(easy, overrides) }
  // Each caller gets its own object, as before the cache: some set keys on it, and that must not reach the next caller.
  return { ...hit.config }
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

/**
 * What picking `goal` gives on this printer: its Easy values with nothing moved by the person and no overrides. With a
 * maker preset, the layer is the one built for the tier in use, so this holds for that goal (the plate's base goal).
 */
export function goalConfig(goal: EasyGoal): PrintConfig {
  const easy = goalEasy(goal)
  return profile ? applyEasy(easy, { ...baseConfig(), ...profile.values } as PrintConfig, new Set(['smartLayer', 'varyLayerHeight'])) : applyEasy(easy, { ...baseConfig(), ...bedSettings(GENERIC_BED) } as PrintConfig)
}

let goalKeyList: string[] | null = null

/** The keys a goal decides: those SlicerX's own goals set differently. A goal pick sets them; the edited mark lists them. */
export function goalKeys(): readonly string[] {
  if (goalKeyList) return goalKeyList
  const cfgs = GOALS.map((g) => applyEasy(goalEasy(g), baseConfig()))
  const text = (v: SettingValue | undefined) => JSON.stringify(v)
  goalKeyList = Object.keys(cfgs[0]!).filter((k) => cfgs.some((c) => text(c[k]) !== text(cfgs[0]![k])))
  return goalKeyList
}

export function isGoal(v: string): v is EasyGoal {
  return (GOALS as readonly string[]).includes(v)
}
