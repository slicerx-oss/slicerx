// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings for one slice: schema defaults, then the project file's own settings,
// then each profile in order, then the user's preset files, then a filament per slot,
// then overrides.
// Shared by the file tools and cloud slicing.
import type { SettingValue } from '@slicerx/contracts'
import type { DataStore } from './data'
import type { PresetLayer } from './presets'
import { ToolInputError } from './models'
import type { ProfileCatalog } from './profiles'
import { defaultConfig, toSchemaValue, validateConfig } from './settings'

export interface ResolvedConfig {
  config: Record<string, SettingValue>
  /** Only the keys the profiles and overrides set. */
  explicit: Record<string, SettingValue>
  applied: string[]
  /**
   * The custom G-code is the text SlicerX ships: no G-code setting came from a profile SlicerX does not ship, a
   * project file, a preset file or an override. Only then does the engine use its normal G-code checks instead of
   * the strict ones (the app's rule).
   */
  trustedGcode: boolean
}

export const isGcodeKey = (k: string): boolean => k.endsWith('_gcode')

/** Profile sources whose G-code is text SlicerX ships: its printer profiles and the makers' presets. */
export const SHIPPED_GCODE_SOURCES: ReadonlySet<string> = new Set(['slicerx', 'stock'])

/** One filament slot's preset: its filament values go into that slot only. */
export interface SlotLayer {
  slot: number
  /** For `applied`, such as `stock-filament:BBL/Bambu PETG HF @BBL A1` or `filament-file:My PETG`. */
  name: string
  values: Record<string, SettingValue>
  /** The spool's color, #RRGGBB, for the .gcode.3mf and the printer's screen. */
  color?: string | undefined
  /** The values bring custom G-code that SlicerX does not ship, which gets the strict checks. */
  customGcode: boolean
}

export interface ExtraLayers {
  /** A project file's own settings, applied first. */
  project?: { name: string; config: Record<string, SettingValue> } | undefined
  /** The user's preset files, applied after the profiles. */
  presets?: PresetLayer[] | undefined
  /** A filament per slot, applied after the preset files and before the overrides. */
  slots?: SlotLayer[] | undefined
}

/** Keys of a filament preset that describe the preset, not a slot. */
const NOT_PER_SLOT = /^(compatible_|inherits$)/

/** `list` with `value` at 1-based `slot`; slots in between keep the last value the list had, or `fill` when it was empty. */
export function setSlot(list: readonly unknown[], slot: number, value: unknown, fill: unknown = value): unknown[] {
  const out = [...list]
  while (out.length < slot) out.push(out.length ? out[out.length - 1] : fill)
  out[slot - 1] = value
  return out
}

/** Profiles must be loaded with `profiles.prepare(names)` first, for stock filament presets. */
export function resolveSliceConfig(store: DataStore, profiles: ProfileCatalog, names: string[], overrides: Record<string, unknown> | undefined, extra: ExtraLayers = {}): ResolvedConfig {
  const explicit: Record<string, SettingValue> = {}
  const applied: string[] = []
  if (extra.project) {
    Object.assign(explicit, extra.project.config)
    applied.push(`project:${extra.project.name}`)
  }
  let untrustedProfile = false
  for (const name of names) {
    const p = profiles.get(name)
    if (!p) throw new ToolInputError(`No profile "${name}". Use slicerx_list_profiles to find ids such as printer:bambu_x1c or filament:petg.`, 'unknown_profile')
    Object.assign(explicit, p.config)
    applied.push(p.id)
    if (!SHIPPED_GCODE_SOURCES.has(p.source) && Object.keys(p.config).some(isGcodeKey)) untrustedProfile = true
  }
  for (const layer of extra.presets ?? []) {
    Object.assign(explicit, layer.values)
    applied.push(`${layer.section}-file:${layer.name}`)
  }
  let untrustedSlot = false
  if (extra.slots?.length) {
    const defaults = defaultConfig(store)
    for (const layer of extra.slots) {
      for (const [k, v] of Object.entries(layer.values)) {
        if (NOT_PER_SLOT.test(k)) continue
        const cur = explicit[k] ?? defaults[k]
        explicit[k] = (Array.isArray(v) && Array.isArray(cur) ? setSlot(cur, layer.slot, v[0]) : v) as SettingValue
      }
      if (layer.customGcode) untrustedSlot = true
      if (layer.color) explicit['filament_colour'] = setSlot(Array.isArray(explicit['filament_colour']) ? explicit['filament_colour'] : [], layer.slot, layer.color, '#FFFFFF') as SettingValue
      applied.push(`slot ${layer.slot}: ${layer.name}`)
    }
  }
  const typed = Object.fromEntries(Object.entries(overrides ?? {}).map(([k, v]) => [k, toSchemaValue(store.setting(k), v)]))
  const errors = validateConfig(store, typed).filter((i) => i.severity === 'error' || i.code === 'unknown_key')
  if (errors.length > 0) throw new ToolInputError(`Invalid overrides:\n${errors.map((i) => `- ${i.message}`).join('\n')}`, 'invalid_settings')
  Object.assign(explicit, typed)
  // A preset file's G-code inherited from a shipped profile is that profile's text; only its own G-code is untrusted.
  const untrusted = (extra.presets ?? []).some((l) => l.customGcode) || [extra.project?.config ?? {}, typed].some((layer) => Object.keys(layer).some(isGcodeKey))
  return { config: { ...defaultConfig(store), ...explicit }, explicit, applied, trustedGcode: !untrusted && !untrustedProfile && !untrustedSlot }
}
