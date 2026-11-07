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

/**
 * The parent side of a compare: the maker preset over the stock settings `a` goes over. A preset applies over the stock
 * settings, never over its parent, so both sides of a parent compare stand on the same ground.
 */
export function parentSide(a: Pick<UserPreset, 'easy'>, parent: CompareSide): CompareSide {
  return { name: parent.name, config: { ...stockFor(a), ...parent.config } as PrintConfig }
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

// Copies, undos and the reload of the list run one at a time, each reading the preset after the one before has landed,
// so two quick presses never build on the same old values and lose one of them.
let writes: Promise<unknown> = Promise.resolve()
/** Runs `fn` after every preset write queued before it, and before any queued after. */
export function presetWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writes.then(fn, fn)
  writes = run.catch(() => undefined)
  return run
}

/** One copied setting: the preset, the key, the value the preset had before (absent: none of its own) and after. */
export interface CopyRecord {
  id: string
  name: string
  key: string
  was?: SettingValue
  now?: SettingValue
}

/** An undo that would undo something else: the preset is gone, or its setting no longer holds the copied value. */
export class CopyChanged extends Error {}

/** A check run in the queue right before a write, such as the app link's busy refusal; it throws to stop the write. */
type Check = (p: UserPreset) => void

const keyOnly = (values: Record<string, SettingValue>, key: string, v: SettingValue | undefined): Record<string, SettingValue> => {
  const out = { ...values }
  if (v === undefined) delete out[key]
  else out[key] = structuredClone(v)
  return out
}

/**
 * Copies `key`'s value from `from` into preset `id`, whose values go over `base` (its stock settings, `stockFor`). A
 * value equal to what the preset gets without it is dropped from the preset rather than kept as a change. Returns what
 * `undoCopy` needs to put that one setting back.
 */
export function copyValue(id: string, key: string, from: PrintConfig, base: PrintConfig, check?: Check): Promise<CopyRecord | null> {
  return presetWrite(async () => {
    const before = get().userPresets.find((p) => p.id === id)
    if (!before) return null
    check?.(before)
    const value = from[key]
    const now = value === undefined || sameValue(value, base[key]) ? undefined : value
    const after = await updatePreset(id, { values: keyOnly(before.values, key, now), ...(before.easy ? { easy: before.easy } : {}) })
    if (after) followOnPlate(after, key, after.values[key])
    const was = before.values[key]
    return { id, name: before.name, key, ...(was !== undefined ? { was: structuredClone(was) } : {}), ...(now !== undefined ? { now: structuredClone(now) } : {}) }
  })
}

/**
 * Puts back the one setting a copy changed, leaving every other setting of the preset as it is now. Refused with
 * CopyChanged when the preset is gone or that setting no longer holds the copied value.
 */
export function undoCopy(rec: CopyRecord, check?: Check): Promise<UserPreset> {
  return presetWrite(async () => {
    const cur = get().userPresets.find((p) => p.id === rec.id)
    if (!cur) throw new CopyChanged(`${rec.name} is gone`)
    if (!sameValue(cur.values[rec.key], rec.now)) throw new CopyChanged(`${rec.name} changed that setting again after the copy`)
    check?.(cur)
    const after = await updatePreset(rec.id, { values: keyOnly(cur.values, rec.key, rec.was), ...(cur.easy ? { easy: cur.easy } : {}) })
    if (!after) throw new CopyChanged(`${rec.name} is gone`)
    followOnPlate(after, rec.key, after.values[rec.key])
    return after
  })
}
