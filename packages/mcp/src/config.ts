// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings for one slice: schema defaults, then the project file's own settings,
// then each profile in order, then the user's preset files, then a filament per slot,
// then overrides.
// Shared by the file tools and cloud slicing.
import type { SettingValue } from '@slicerx/contracts'
import { GCODE_TEXT_KEYS, printerConfig, printerProfile, reviewProjectGcode, type GcodeChange, type GcodeKept } from '@slicerx/settings'
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
  /** The project's G-code settings used as they are, because they are the printer's stock text or the profile's. */
  gcodeKept: GcodeKept[]
  /** The project's G-code settings left for the printer profile's (project.gcode "profile"). */
  gcodeReplaced: string[]
}

/** What to do with a project's G-code that is not the printer's stock text. */
export type ProjectGcode = 'review' | 'profile'

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
  /**
   * A project file's own settings, applied first. `model` is the printer model the project was saved for (`bambu-a1`),
   * which its G-code is compared with when no printer profile names one.
   */
  project?: { name: string; config: Record<string, SettingValue>; model?: string | undefined; gcode?: ProjectGcode | undefined } | undefined
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
  const { kept, replaced } = extra.project ? projectGcode(store, profiles, names, extra.project, explicit) : { kept: [], replaced: [] }
  // A preset file's G-code inherited from a shipped profile is that profile's text; only its own G-code is untrusted.
  // The project's G-code that is left is stock text, which projectGcode checked.
  const untrusted = (extra.presets ?? []).some((l) => l.customGcode) || Object.keys(typed).some(isGcodeKey) || Object.keys(extra.project?.config ?? {}).some((k) => isGcodeKey(k) && !GCODE_TEXT_KEYS.includes(k))
  return { config: { ...defaultConfig(store), ...explicit }, explicit, applied, trustedGcode: !untrusted && !untrustedProfile && !untrustedSlot, gcodeKept: kept, gcodeReplaced: replaced }
}

/** The refusal for a project whose G-code is not the printer's stock text: the diff and flags for a person to see. */
function projectGcodeReview(project: string, changes: GcodeChange[]): ToolInputError {
  return new ToolInputError(projectGcodeMessage(project, changes), 'project_gcode_review', {
    project,
    approvable: changes.every((c) => c.approvable),
    changes: changes.map((c) => ({ key: c.key, ...(c.slot !== undefined ? { slot: c.slot } : {}), label: c.label, added: c.added, removed: c.removed, approvable: c.approvable, fingerprint: c.fingerprint, flags: c.flags, diff: c.unified })),
  })
}

function projectGcodeMessage(project: string, changes: GcodeChange[]): string {
  const parts = changes.map((c) => {
    const flags = c.flags.map((f) => `line ${f.line}: ${f.reason}${f.severity === 'error' ? ' (not allowed even with approval)' : ''}`)
    return `The ${c.label} differs from the printer profile's (${c.added} ${c.added === 1 ? 'line' : 'lines'} added, ${c.removed} removed)${flags.length ? `. Flagged: ${flags.join('; ')}` : ', with no flagged lines'}.`
  })
  return `${project} carries printer G-code that is not the printer's stock text. ${parts.join(' ')} Show the diff to the person. To slice now with the printer profile's G-code instead, call again with project_gcode "profile". Only a person can choose the project's own G-code, in SlicerX.`
}

/**
 * Compares the G-code settings a project brings with what the printer profile would use. Stock text stays; anything
 * else is replaced with the profile's (`gcode: "profile"`) or refused with the diff (`"review"`, the default).
 */
function projectGcode(store: DataStore, profiles: ProfileCatalog, names: string[], project: NonNullable<ExtraLayers['project']>, explicit: Record<string, SettingValue>): { kept: GcodeKept[]; replaced: string[] } {
  // Only keys whose value is still the project's: a later profile, preset or override replaces the project's text.
  const own = Object.fromEntries(Object.entries(project.config).filter(([k, v]) => GCODE_TEXT_KEYS.includes(k) && explicit[k] === v))
  if (Object.keys(own).length === 0) return { kept: [], replaced: [] }
  // The printer the slice is for: a printer profile named in the call, else the one the project was saved for.
  const machine = names.map((n) => profiles.get(n)).find((p) => p?.id.startsWith('machine:'))
  const model = machine ? machine.id.slice('machine:'.length) : project.model
  // What the slice would use without the project's text: the profiles' G-code, else the model's shipped text.
  const layered: Record<string, unknown> = {}
  for (const n of names) Object.assign(layered, Object.fromEntries(Object.entries(profiles.get(n)?.config ?? {}).filter(([k]) => GCODE_TEXT_KEYS.includes(k))))
  const shipped = (model ? (printerConfig(model) ?? {}) : {}) as Record<string, unknown>
  const defaults = defaultConfig(store)
  const reference = Object.fromEntries(Object.keys(own).map((k) => [k, layered[k] ?? shipped[k] ?? defaults[k]]))
  const limits = model ? printerProfile(model)?.limits : undefined
  const review = reviewProjectGcode({ project: own, profile: reference, model, limits: { nozzleMaxC: limits?.hotendMaxTemp, bedMaxC: limits?.bedMaxTemp } })
  if (review.changes.length === 0) return { kept: review.kept, replaced: [] }
  if ((project.gcode ?? 'review') === 'review') throw projectGcodeReview(project.name, review.changes)
  const replaced = [...new Set(review.changes.map((c) => c.key))]
  for (const k of replaced) {
    const v = reference[k] as SettingValue | undefined
    if (v === undefined) delete explicit[k]
    else explicit[k] = v
  }
  return { kept: review.kept, replaced }
}
