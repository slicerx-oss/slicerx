// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Diff two configs with a plain reason for every change. src/diff.rs mirrors it.
import type { ConfigDiffEntry, EasySettings, PrintConfig, SettingChange, SettingDef, SettingsPlan, SettingUnit, SettingValue, SetupRef } from '@slicerx/contracts/settings'
import { SLICE_STAGES } from '@slicerx/contracts/slice'
import { failedConditions } from './config'
import { easyControlFor, EASY_MAP } from './easy'
import { settingDef } from './schema'

const UNIT_TEXT: Record<SettingUnit, string> = {
  mm: ' mm', 'mm/s': ' mm/s', 'mm/s2': ' mm/s2', 'mm3/s': ' mm3/s', '%': '%', C: ' C', s: ' s', 'g/cm3': ' g/cm3',
  deg: ' deg', 'money/kg': ' per kg', mm3: ' mm3', layers: ' layers', Hz: ' Hz', 'delta-C': ' C', 'money/h': ' per hour',
}

export function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** An enum value's label (`Outer brim only` for `outer_only`); an alias reads as the value it stands for. */
function enumText(def: SettingDef | undefined, s: string): string {
  if (def?.type !== 'enum' && def?.type !== 'enums') return s
  const i = def.enumValues?.indexOf(def.enumAliases?.[s] ?? s) ?? -1
  return (i >= 0 ? def.enumLabels?.[i] : undefined) ?? s
}

/** Human text for a value: `0.2 mm`, `on`, `220 C`, `Rectilinear`. Lists that repeat one value show it once. */
export function formatValue(def: SettingDef | undefined, v: SettingValue | undefined): string {
  if (v === undefined) return 'not set'
  const unit = def?.unit && def.type !== 'floatOrPercent' && def.type !== 'floatsOrPercents' ? UNIT_TEXT[def.unit] : ''
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return String(v) + (def?.unit === '%' ? '%' : unit)
  if (typeof v === 'string') {
    const t = enumText(def, v)
    return t === '' ? 'empty' : t.length > 60 ? t.slice(0, 57) + '...' : t
  }
  if (Array.isArray(v)) {
    const items = v as unknown[]
    if (items.length > 0 && items.every((x) => typeof x !== 'object' && x === items[0])) return formatValue(def, items[0] as SettingValue)
    const text = items.map((x) => (typeof x === 'object' ? JSON.stringify(x) : enumText(def, String(x)))).join(', ')
    return text.length > 60 ? text.slice(0, 57) + '...' : text
  }
  return JSON.stringify(v)
}

function firstNumber(v: SettingValue | undefined): number | undefined {
  const x = Array.isArray(v) ? (v as unknown[])[0] : v
  if (typeof x === 'number') return x
  if (typeof x === 'boolean') return x ? 1 : 0
  if (typeof x === 'string') {
    const t = x.endsWith('%') ? x.slice(0, -1) : x
    const n = Number(t)
    return t.trim() !== '' && Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function reasonFor(def: SettingDef | undefined, key: string, before: SettingValue | undefined, after: SettingValue | undefined, next: PrintConfig, easy: EasySettings | undefined): string {
  const label = def?.label ?? key
  const control = easyControlFor(key)
  if (easy && control) {
    const c = EASY_MAP.controls[control]
    const v = (easy as unknown as Record<string, unknown>)[control]
    return `${label} follows the ${c?.label ?? control} control (${String(v)}).`
  }
  const parts: string[] = []
  if (before === undefined) parts.push(`${label} is now set to ${formatValue(def, after)}.`)
  else if (after === undefined) parts.push(`${label} is no longer set; the default ${def ? formatValue(def, def.default) : 'value'} applies.`)
  else {
    const b = firstNumber(before)
    const a = firstNumber(after)
    const effect = def?.effect
    if (effect && a !== undefined && b !== undefined && a !== b) {
      const text = a > b ? effect.increase : effect.decrease
      if (text) parts.push(`${label} goes from ${formatValue(def, before)} to ${formatValue(def, after)}. ${text}.`)
    }
    if (parts.length === 0) parts.push(`${label} changes from ${formatValue(def, before)} to ${formatValue(def, after)}.`)
  }
  if (def && after !== undefined) {
    const failed = failedConditions(def, next)[0]
    if (failed) {
      const dep = settingDef(failed.key)
      parts.push(`It has no effect while ${dep?.label ?? failed.key} is ${formatValue(dep, next[failed.key] ?? dep?.default)}.`)
    }
  }
  return parts.join(' ')
}

const STAGE_RANK: Record<string, number> = Object.fromEntries(SLICE_STAGES.map((s, i) => [s, i]))

/**
 * Every key whose value differs between `before` and `after`, earliest slice stage first.
 * Pass the Easy controls to have Easy-driven keys explained by their control.
 */
export function diffConfigs(before: PrintConfig, after: PrintConfig, opts: { easy?: EasySettings } = {}): ConfigDiffEntry[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: ConfigDiffEntry[] = []
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (sameValue(b, a)) continue
    const def = settingDef(key)
    const entry: ConfigDiffEntry = {
      key,
      label: def?.label ?? key,
      group: def?.group ?? 'other',
      kind: b === undefined ? 'added' : a === undefined ? 'removed' : 'changed',
      stage: def?.invalidates ?? 'layers',
      reason: reasonFor(def, key, b, a, after, opts.easy),
      ...(def?.unit ? { unit: def.unit } : {}),
      ...(b !== undefined ? { before: b } : {}),
      ...(a !== undefined ? { after: a } : {}),
    }
    out.push(entry)
  }
  return out.sort((x, y) => (STAGE_RANK[x.stage] ?? 0) - (STAGE_RANK[y.stage] ?? 0) || x.group.localeCompare(y.group) || x.key.localeCompare(y.key))
}

/** The earliest slice stage any of the changes invalidates, or undefined when nothing changed. */
export function firstStage(changes: readonly ConfigDiffEntry[]) {
  return changes.reduce<ConfigDiffEntry['stage'] | undefined>((acc, c) => (acc === undefined || (STAGE_RANK[c.stage] ?? 0) < (STAGE_RANK[acc] ?? 0) ? c.stage : acc), undefined)
}

/**
 * Wrap a config diff as the `SettingsPlan` that Pilot shows. `sources` names where the after
 * values came from, such as `orca:BBL/process/0.12mm Fine @BBL X1C.json`. Keys the new config
 * drops go to `unresolved`.
 */
export function toSettingsPlan(from: SetupRef, to: SetupRef, before: PrintConfig, after: PrintConfig, opts: { sources?: string[]; easy?: EasySettings } = {}): SettingsPlan {
  const t0 = performance.now()
  const sources = opts.sources ?? []
  const changes: SettingChange[] = []
  const unresolved: { key: string; reason: string }[] = []
  for (const d of diffConfigs(before, after, opts.easy ? { easy: opts.easy } : {})) {
    if (d.after === undefined) {
      unresolved.push({ key: d.key, reason: 'The new setup does not set this key, so its default applies.' })
      continue
    }
    const def = settingDef(d.key)
    changes.push({
      key: d.key,
      label: d.label,
      section: def?.section ?? 'process',
      ...(d.unit ? { unit: d.unit } : {}),
      before: d.before ?? null,
      after: d.after,
      reason: d.reason,
      sources,
      origin: 'profile',
      klass: def?.pilot ?? 'read',
      approval: 'none',
    })
  }
  return { from, to, changes, unresolved, warnings: [], clamps: [], refused: [], blockers: [], questions: [], caveats: [], advice: [], tellUser: [], computedMs: Math.round(performance.now() - t0) }
}
