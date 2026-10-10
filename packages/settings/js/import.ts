// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Orca and Bambu Studio profile JSON to a typed PrintConfig, with `inherits` resolved.
import type { PrintConfig, ProfileImport, SettingSection } from '@slicerx/contracts/settings'
import { SETTINGS, settingDef } from './schema'
import { coerce, NIL, toOrca } from './value'
import legacyJson from '../legacy.json'

interface LegacyRules {
  meta: string[]
  rename: Record<string, string>
  value_map: { key: string; from: string; to: string }[]
  drop_if_percent: string[]
  obsolete: string[]
  foreign: string[]
}

const LEGACY = legacyJson as unknown as LegacyRules

/** Keys that describe the profile file itself and are not settings. */
export const PROFILE_META_KEYS: ReadonlySet<string> = new Set(LEGACY.meta)
const OBSOLETE = new Set([...LEGACY.obsolete, ...LEGACY.foreign])
const DROP_IF_PERCENT = new Set(LEGACY.drop_if_percent)

/** Keys Orca dropped over time, keys only Bambu Studio and other forks define, and keys Orca drops when they hold a percent. */
export const LEGACY_GROUPS: Readonly<{ obsolete: ReadonlySet<string>; foreign: ReadonlySet<string>; dropIfPercent: ReadonlySet<string> }> = {
  obsolete: new Set(LEGACY.obsolete),
  foreign: new Set(LEGACY.foreign),
  dropIfPercent: DROP_IF_PERCENT,
}

/** Orca's legacy key names, from its `handle_legacy`, that older profiles still use. */
export const LEGACY_KEYS: Readonly<Record<string, string>> = LEGACY.rename

function mapLegacyValue(key: string, raw: unknown): unknown {
  const rules = LEGACY.value_map.filter((r) => r.key === key)
  if (rules.length === 0) return raw
  const one = (v: unknown): unknown => (typeof v === 'string' ? (rules.find((r) => r.from === v)?.to ?? v) : v)
  return Array.isArray(raw) ? raw.map(one) : one(raw)
}

function hasPercent(raw: unknown): boolean {
  return Array.isArray(raw) ? raw.some((x) => typeof x === 'string' && x.includes('%')) : typeof raw === 'string' && raw.includes('%')
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

const MAX_DEPTH = 32

function sectionOf(type: unknown): SettingSection | undefined {
  if (type === 'process' || type === 'print') return 'process'
  if (type === 'filament') return 'filament'
  if (type === 'machine' || type === 'printer') return 'printer'
  return undefined
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * Bambu Studio 2.8 replaced the `reduce_infill_retraction` switch with `reduce_infill_retraction_mode`. Its tooltip:
 * "Enabled" always skips retraction for travels within the infill area, "Disabled" always retracts, and "Auto" skips it
 * for filaments with low metal stickiness (PLA) but not medium or high (PETG), where `filament_metal_stickiness` "None"
 * (untested) counts as low. The engine has one switch for the print, so Auto turns it on when every filament of the
 * file is low (or when it names no filament). Undefined when the file has no mode, or one of another name, which then imports as before.
 */
export function infillRetractionFromMode(merged: Record<string, unknown>): boolean | undefined {
  const one = (v: unknown): unknown => (Array.isArray(v) && v.length === 1 ? v[0] : v)
  const mode = one(merged['reduce_infill_retraction_mode'])
  if (typeof mode !== 'string') return undefined
  switch (mode.trim().toLowerCase()) {
    case 'enabled':
      return true
    case 'disabled':
      return false
    case 'auto': {
      const raw = merged['filament_metal_stickiness']
      const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
      return list.every((x) => typeof x === 'string' && ['none', 'low', 'nil'].includes(x.trim().toLowerCase()))
    }
    default:
      return undefined
  }
}

export interface FlatImport {
  config: PrintConfig
  unknownKeys: string[]
  ignoredKeys: string[]
  nilKeys: string[]
  invalidKeys: string[]
}

/** Read one flat object of Orca JSON values (a merged profile, or a project's settings file). */
export function importFlat(merged: Record<string, unknown>): FlatImport {
  const config: PrintConfig = {} as PrintConfig
  const unknownKeys: string[] = []
  const ignoredKeys: string[] = []
  const nilKeys: string[] = []
  const invalidKeys: string[] = []
  const fromMode = infillRetractionFromMode(merged)
  for (const [rawKey, rawValue] of Object.entries(merged)) {
    if (PROFILE_META_KEYS.has(rawKey)) continue
    // The mode replaces the old switch when the file has both (see infillRetractionFromMode).
    if (fromMode !== undefined && (rawKey === 'reduce_infill_retraction_mode' || rawKey === 'reduce_infill_retraction')) continue
    if (OBSOLETE.has(rawKey) && !settingDef(rawKey)) {
      ignoredKeys.push(rawKey)
      continue
    }
    if (DROP_IF_PERCENT.has(rawKey) && hasPercent(rawValue)) {
      ignoredKeys.push(rawKey)
      continue
    }
    const key = settingDef(rawKey) ? rawKey : (LEGACY.rename[rawKey] ?? rawKey)
    const def = settingDef(key)
    if (!def) {
      unknownKeys.push(rawKey)
      continue
    }
    const raw = mapLegacyValue(rawKey, rawValue)
    const c = coerce(def, raw)
    if (c.ok === true) config[key] = c.value
    else if (c.ok === 'nil') nilKeys.push(key)
    else invalidKeys.push(key)
  }
  if (fromMode !== undefined) config['reduce_infill_retraction'] = fromMode
  return { config, unknownKeys: unknownKeys.sort(), ignoredKeys: ignoredKeys.sort(), nilKeys: nilKeys.sort(), invalidKeys: invalidKeys.sort() }
}

/**
 * Merge a profile and its parents, child first in `layers`. A child's value replaces the parent's, except a `nil`
 * entry, which keeps the parent's value for that extruder, as Orca and Bambu Studio merge user presets.
 */
export function mergeLayers(layers: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const layer of layers.slice().reverse()) {
    for (const [k, v] of Object.entries(layer)) {
      const prev = merged[k]
      if (v === NIL && prev !== undefined) continue
      if (Array.isArray(v) && Array.isArray(prev) && v.includes(NIL)) merged[k] = v.map((x, i) => (x === NIL && i < prev.length ? prev[i] : x))
      else merged[k] = v
    }
  }
  return merged
}

/**
 * Import a profile. `resolve(name)` returns the parent profile JSON by name (or undefined).
 * Values are merged root first, so a child key replaces the parent's. Throws ProfileError on a
 * cycle, a missing parent, or an input that is not a profile object.
 */
export function importOrcaProfile(json: unknown, resolve: (name: string) => unknown): ProfileImport {
  const root = asObject(json)
  if (!root) throw new ProfileError('profile is not a JSON object')
  const chain: string[] = []
  const layers: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let cur: Record<string, unknown> | undefined = root
  while (cur) {
    const name = typeof cur['name'] === 'string' ? cur['name'] : ''
    if (name) {
      if (seen.has(name)) throw new ProfileError(`inherits cycle at "${name}"`)
      seen.add(name)
    }
    chain.push(name)
    layers.push(cur)
    if (chain.length > MAX_DEPTH) throw new ProfileError('inherits chain is too deep')
    const parentName = cur['inherits']
    if (typeof parentName !== 'string' || parentName === '') break
    const parent = asObject(resolve(parentName))
    if (!parent) throw new ProfileError(`parent profile "${parentName}" not found (needed by "${name}")`)
    cur = parent
  }
  const flat = importFlat(mergeLayers(layers))
  const section = sectionOf(root['type']) ?? sectionOf(layers[layers.length - 1]?.['type']) ?? 'process'
  return {
    name: chain[0] ?? '',
    section,
    chain,
    config: flat.config,
    unknownKeys: flat.unknownKeys,
    ignoredKeys: flat.ignoredKeys,
    nilKeys: flat.nilKeys,
    invalidKeys: flat.invalidKeys,
  }
}

/** Back to Orca's string-typed JSON, for saving a profile Orca and Bambu Studio can open. */
export function exportOrcaProfile(config: PrintConfig, meta: { name: string; section: SettingSection; inherits?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: meta.section === 'printer' ? 'machine' : meta.section,
    name: meta.name,
    from: 'User',
    instantiation: 'true',
  }
  if (meta.inherits) out['inherits'] = meta.inherits
  const inSection = new Set(SETTINGS.filter((d) => d.section === meta.section).map((d) => d.key))
  for (const key of Object.keys(config).sort()) {
    if (!inSection.has(key)) continue
    const def = settingDef(key)
    const v = config[key]
    if (def && v !== undefined) out[key] = toOrca(def, v)
  }
  return out
}

/** Layer configs left to right: process, filament and printer parts into one config. Later parts win. */
export function mergeConfigs(...parts: PrintConfig[]): PrintConfig {
  const out = {} as PrintConfig
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k] = v
  return out
}
