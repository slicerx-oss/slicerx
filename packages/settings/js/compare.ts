// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two configs of one kind side by side: the settings where they differ (or every setting, with `all`), grouped by
// settings group, each with its label and both values as the settings panel writes them. The differing keys come from
// diffConfigs, and G-code text from the line diff a project's G-code review uses, so a compare never disagrees with
// either. The app's Compare presets and the MCP's slicerx_preset_compare both read this.
import type { PrintConfig, SettingDef, SettingSection, SettingUnit, SettingValue } from '@slicerx/contracts/settings'
import { diffConfigs, formatValue, sameValue } from './diff'
import { GCODE_TEXT_KEYS, gcodeLineCount, gcodeTextDiff, normalizeGcode } from './gcode-review'
import { settingDef, settingsFor } from './schema'

/** Settings groups in the order the settings panel reads them; a group not listed sorts after these. */
export const SETTING_GROUP_ORDER: readonly string[] = ['quality', 'strength', 'speed', 'motion', 'overhangs', 'support', 'adhesion', 'cooling', 'temperature', 'filament', 'extrusion', 'retraction', 'drying', 'multimaterial', 'special', 'advanced', 'machine', 'gcode', 'profile']

/** A settings group as people read it: `Multi-material`, `G-code`, `Quality`. */
export function settingGroupLabel(group: string): string {
  if (group === 'multimaterial') return 'Multi-material'
  if (group === 'gcode') return 'G-code'
  return group.charAt(0).toUpperCase() + group.slice(1)
}

export function settingGroupRank(group: string): number {
  const i = SETTING_GROUP_ORDER.indexOf(group)
  return i < 0 ? SETTING_GROUP_ORDER.length : i
}

export interface CompareRow {
  key: string
  label: string
  group: string
  /** False only in a compare with `all`, for a setting both sides have alike. */
  differs: boolean
  /** The value on each side; absent where that side does not set it. */
  a?: SettingValue
  b?: SettingValue
  /** Each value as the settings panel writes it (`0.2 mm`, `Gyroid`, `not set`); G-code as its line count. */
  aText: string
  bText: string
  unit?: SettingUnit
  /** G-code text only: the lines the second side adds and drops against the first, and the unified diff. */
  lines?: { added: number; removed: number; unified: string }
}

export interface CompareGroup {
  group: string
  label: string
  rows: CompareRow[]
}

export interface ConfigComparison {
  section?: SettingSection
  /** How many settings differ, whether or not `all` lists the rest. */
  differ: number
  groups: CompareGroup[]
  /** Keys that differ but that the schema does not know, so they have no label and are not listed in `groups`. */
  unknownKeys: string[]
}

export interface CompareOptions {
  /** Only settings of this kind. */
  section?: SettingSection
  /** List every setting of the kind, not only those that differ. */
  all?: boolean
  /** Names for the two sides in a G-code diff's header. */
  names?: readonly [string, string]
}

const GCODE = new Set(GCODE_TEXT_KEYS)

/**
 * A setting a compare lists: one the settings panel shows. Hidden bookkeeping (inherits, compatible printers, variant
 * ids) and the printer's network connection (host, user, password, API key) are never listed.
 */
function listed(def: SettingDef | undefined, section: SettingSection | undefined): def is SettingDef {
  return def !== undefined && (!section || def.section === section) && def.mode !== 'hidden' && def.group !== 'network'
}

/** A list that repeats one value (one per filament slot or extruder) is that value, as formatValue writes it. */
const one = (v: SettingValue | undefined): SettingValue | undefined => {
  if (!Array.isArray(v) || v.length === 0) return v
  const items = v as unknown[]
  return items.every((x) => JSON.stringify(x) === JSON.stringify(items[0])) ? ([items[0]] as SettingValue) : v
}

const textOf = (v: SettingValue | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v as unknown[]).map((x) => String(x ?? '')).join('\n') : undefined)

function gcodeText(v: SettingValue | undefined): string {
  if (v === undefined) return 'not set'
  const n = gcodeLineCount(textOf(v) ?? '')
  return n === 0 ? 'empty' : `${n} ${n === 1 ? 'line' : 'lines'}`
}

function row(def: SettingDef, a: SettingValue | undefined, b: SettingValue | undefined, differs: boolean, names: readonly [string, string] | undefined): CompareRow {
  const gcode = GCODE.has(def.key)
  const out: CompareRow = {
    key: def.key,
    label: def.label,
    group: def.group,
    differs,
    ...(a !== undefined ? { a } : {}),
    ...(b !== undefined ? { b } : {}),
    aText: gcode ? gcodeText(a) : formatValue(def, a),
    bText: gcode ? gcodeText(b) : formatValue(def, b),
    ...(def.unit ? { unit: def.unit } : {}),
  }
  if (gcode && differs) out.lines = gcodeTextDiff(textOf(a) ?? '', textOf(b) ?? '', names)
  return out
}

/** Compares `a` with `b`: the settings that differ, by group, or with `all` every listed setting of the kind. */
export function compareConfigs(a: PrintConfig, b: PrintConfig, opts: CompareOptions = {}): ConfigComparison {
  const { section } = opts
  const differing = new Set<string>()
  const unknownKeys: string[] = []
  for (const d of diffConfigs(a, b)) {
    const def = settingDef(d.key)
    if (!def) {
      unknownKeys.push(d.key)
      continue
    }
    if (!listed(def, section)) continue
    // Only the number of filament slots differs: [70, 70] and [70] are the same setting. A printer's lists are per
    // extruder, and their length is how many extruders it has, so they are compared whole.
    if (def.section !== 'printer' && sameValue(one(d.before), one(d.after))) continue
    // G-code text that differs only in line endings, trailing spaces or blank lines is the same text, as in the review.
    if (GCODE.has(d.key) && normalizeGcode(textOf(d.before) ?? '') === normalizeGcode(textOf(d.after) ?? '')) continue
    differing.add(d.key)
  }
  const defs = opts.all ? (section ? settingsFor(section) : [...new Set([...Object.keys(a), ...Object.keys(b)])].map(settingDef)).filter((d) => listed(d, section)) : [...differing].map((k) => settingDef(k)!)
  const byGroup = new Map<string, CompareRow[]>()
  for (const def of defs) {
    const r = row(def, a[def.key], b[def.key], differing.has(def.key), opts.names)
    byGroup.set(def.group, [...(byGroup.get(def.group) ?? []), r])
  }
  const groups = [...byGroup.entries()]
    .map(([group, rows]) => ({ group, label: settingGroupLabel(group), rows: rows.sort((x, y) => x.label.localeCompare(y.label) || x.key.localeCompare(y.key)) }))
    .sort((x, y) => settingGroupRank(x.group) - settingGroupRank(y.group) || x.label.localeCompare(y.label))
  return { ...(section ? { section } : {}), differ: differing.size, groups, unknownKeys: unknownKeys.sort() }
}
