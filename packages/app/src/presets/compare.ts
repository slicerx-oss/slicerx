// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Compares a saved preset with another of its kind, with the maker preset it was made from (its parent), or with the
// stock settings it goes over. Each side is read whole (the preset's values over what it starts from), so a setting one
// side leaves alone shows the value that side really gets. The rows come from @slicerx/settings compareConfigs, the
// same compare the MCP's slicerx_preset_compare returns. A value can be copied into the first preset, and put back.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { compareConfigs, sameValue, vendorParent, type ConfigComparison } from '@slicerx/settings'
import { resolveConfig } from '../adapters/config'
import { get, markStale, set, type AppState } from '../state/store'
import { updatePreset } from './presets'
import type { PresetKind, UserPreset } from './store'

export type CompareWith = 'preset' | 'parent' | 'stock'

/** The second side of a comparison: a whole config and what to call it. */
export interface CompareSide {
  name: string
  config: PrintConfig
}

/** The settings a preset of `kind` starts from: the printer's stock settings under the preset's own Easy choices. */
export function stockFor(p: Pick<UserPreset, 'easy'>, s: Pick<AppState, 'easy'> = get()): PrintConfig {
  return resolveConfig(p.easy ?? s.easy, {})
}

/** The maker preset `p` was made from, when it names one SlicerX ships. */
export async function parentFor(p: Pick<UserPreset, 'kind' | 'inherits'>): Promise<CompareSide | undefined> {
  if (!p.inherits) return undefined
  const parent = await vendorParent(p.kind, p.inherits)
  return parent ? { name: parent.name, config: parent.config } : undefined
}

/** What a preset gives, whole: its values over `base`. */
export function whole(p: Pick<UserPreset, 'values'>, base: PrintConfig): PrintConfig {
  return { ...base, ...p.values } as PrintConfig
}

/** Compares preset `a` (over `base`) with `b`, settings of `a`'s kind only. */
export function comparePreset(a: UserPreset, base: PrintConfig, b: CompareSide, opts: { all?: boolean } = {}): ConfigComparison {
  return compareConfigs(whole(a, base), b.config, { section: a.kind, all: opts.all === true, names: [a.name, b.name] })
}

/** Presets that can be compared with `p`: the same kind, not itself. */
export function comparable(p: UserPreset, all: readonly UserPreset[]): UserPreset[] {
  return all.filter((o) => o.kind === p.kind && o.id !== p.id)
}

/** The kind's settings changed in place on the plate while `p` is the preset in use, so the plate keeps following it. */
function followOnPlate(p: UserPreset, key: string, value: SettingValue | undefined): void {
  if (get().activePresets[p.kind as PresetKind] !== p.id) return
  set((s) => {
    const overrides = { ...s.overrides }
    if (value === undefined) delete overrides[key]
    else overrides[key] = value
    return { overrides }
  })
  markStale()
}

/**
 * Copies `key`'s value from `from` into preset `id` (whose values go over `base`). A value equal to what the preset
 * starts from is dropped from the preset rather than kept as a change. Returns the preset as it was, for `undoCopy`.
 */
export async function copyValue(id: string, key: string, from: PrintConfig, base: PrintConfig): Promise<UserPreset | null> {
  const before = get().userPresets.find((p) => p.id === id)
  if (!before) return null
  const value = from[key]
  const values = { ...before.values }
  if (value === undefined || sameValue(value, base[key])) delete values[key]
  else values[key] = structuredClone(value)
  const after = await updatePreset(id, { values, ...(before.easy ? { easy: before.easy } : {}) })
  if (after) followOnPlate(after, key, values[key])
  return structuredClone(before)
}

/** Puts back a preset as `copyValue` found it. */
export async function undoCopy(before: UserPreset, key: string): Promise<void> {
  const after = await updatePreset(before.id, { values: before.values, ...(before.easy ? { easy: before.easy } : {}) })
  if (after) followOnPlate(after, key, before.values[key])
}
