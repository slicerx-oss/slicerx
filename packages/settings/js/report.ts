// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What did not carry over when a preset came in from another slicer: per setting its label, the value it had, why it
// was left out and the value SlicerX uses instead, with where that value comes from. Settings that mapped cleanly are
// not listed. `importLayers` reads a preset and the presets it inherits from into one config and the list of what
// was dropped; `buildReport` turns that into the report. src/report.rs mirrors both.
import type { PrintConfig, SettingDef, SettingSection, SettingValue } from '@slicerx/contracts/settings'
import nearestJson from '../import-nearest.json'
import { formatValue } from './diff'
import { importFlat, LEGACY_GROUPS, LEGACY_KEYS } from './import'
import { settingDef, SETTINGS } from './schema'
import { NIL, toOrca } from './value'

interface NearestFile {
  keys: { orca: Record<string, string>; prusa: Record<string, string> }
  values: Record<string, Record<string, string>>
  labels: Record<string, string>
}
const NEAREST = nearestJson as unknown as NearestFile

/** Which slicer's key names a preset uses: OrcaSlicer and Bambu Studio share theirs, PrusaSlicer has its own. */
export type KeyFamily = 'orca' | 'prusa'

/** Why a setting did not carry over: SlicerX has no such setting, the value does not fit, or the setting is obsolete. */
export type DropReason = 'unsupported' | 'invalid' | 'obsolete'

/** Where the value SlicerX uses comes from: the preset itself, a profile it inherits from, the printer profile, or the schema default. */
export type ValueSource = 'preset' | 'profile' | 'printer' | 'default'

/** A setting that did not carry over, as the file had it. */
export interface Dropped {
  /** The key in the file. */
  key: string
  /** The value in the file, as written. */
  value: unknown
  reason: DropReason
  /** The SlicerX setting the value was meant for, when there is one (an invalid value). */
  target?: string
  /** The import used the nearest value SlicerX has in place of this one. */
  nearestValue?: boolean
}

export interface Instead {
  /** The SlicerX setting. */
  key: string
  label: string
  /** As shown: enum labels, units. */
  value: string
  source: ValueSource
  /** The profile or printer the value comes from. */
  from?: string
  /** The setting or value is the closest SlicerX has, not the same one. */
  nearest: boolean
}

export interface ReportItem {
  /** The key in the file; shown only in developer mode. */
  key: string
  label: string
  oldValue: string
  reason: DropReason
  /** Null when nothing in SlicerX does what the setting did. */
  instead: Instead | null
}

export interface ImportReport {
  name: string
  section: SettingSection
  /** The profile the preset inherits from, whether SlicerX has it, and whether it came in with the preset. */
  parent?: { name: string; found: boolean; bundled?: boolean }
  items: ReportItem[]
  /** Settings the old preset never had a value for, which take the printer profile's defaults. */
  defaulted: number
}

/** One preset in an inherits chain: its own values in the file's form, or a profile SlicerX already holds as a config. */
export interface ImportLayer {
  name: string
  raw?: Record<string, unknown>
  config?: PrintConfig
}

const isEnum = (def: SettingDef | undefined): boolean => def?.type === 'enum' || def?.type === 'enums'

function enumOk(def: SettingDef, v: unknown): boolean {
  const allowed = def.enumValues
  if (!allowed || allowed.length === 0) return true
  const one = (x: unknown) => typeof x === 'string' && (allowed.includes(x) || (def.enumAliases?.[x] !== undefined && allowed.includes(def.enumAliases[x] as string)))
  return Array.isArray(v) ? v.every(one) : one(v)
}

/**
 * Read one preset's own values: `importFlat`, then enum values SlicerX does not have are dropped, or replaced by
 * the nearest value it has. Returns the typed config and what did not carry over.
 */
export function importValues(raw: Record<string, unknown>): { config: PrintConfig; dropped: Dropped[] } {
  const flat = importFlat(raw)
  const config = { ...flat.config } as Record<string, SettingValue>
  const dropped: Dropped[] = []
  // The key the file used for a setting: its own name, or the first by name of the legacy keys that became it.
  const rawKeyOf = (key: string): string => (key in raw ? key : (Object.keys(raw).sort().find((k) => LEGACY_KEYS[k] === key) ?? key))
  // A `nil` value says the old app had nothing set, so nothing is lost.
  const unset = (v: unknown): boolean => v === NIL || (Array.isArray(v) && v.length > 0 && v.every((x) => x === NIL))
  for (const k of flat.unknownKeys) if (!unset(raw[k])) dropped.push({ key: k, value: raw[k], reason: 'unsupported' })
  for (const k of flat.ignoredKeys) {
    if (unset(raw[k])) continue
    if (LEGACY_GROUPS.dropIfPercent.has(k)) dropped.push({ key: k, value: raw[k], reason: 'invalid', target: LEGACY_KEYS[k] ?? k })
    else dropped.push({ key: k, value: raw[k], reason: LEGACY_GROUPS.obsolete.has(k) ? 'obsolete' : 'unsupported' })
  }
  for (const k of flat.invalidKeys) {
    const rk = rawKeyOf(k)
    dropped.push({ key: rk, value: raw[rk], reason: 'invalid', target: k })
  }
  for (const [k, v] of Object.entries(config)) {
    const def = settingDef(k)
    if (!def || !isEnum(def) || enumOk(def, v)) continue
    const rk = rawKeyOf(k)
    const map = NEAREST.values[k]
    const swap = (x: unknown): unknown => (typeof x === 'string' && map?.[x] !== undefined ? map[x] : x)
    const near = Array.isArray(v) ? v.map(swap) : swap(v)
    if (map && enumOk(def, near)) {
      config[k] = near as SettingValue
      dropped.push({ key: rk, value: raw[rk], reason: 'invalid', target: k, nearestValue: true })
    } else {
      delete config[k]
      dropped.push({ key: rk, value: raw[rk], reason: 'invalid', target: k })
    }
  }
  dropped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { config: config as unknown as PrintConfig, dropped }
}

/** A list with `nil` entries takes those entries from the value below it, as Orca merges a user preset over its parent. */
function fillNil(raw: Record<string, unknown>, below: Readonly<Record<string, SettingValue>>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v) || !v.includes(NIL)) continue
    const key = settingDef(k) ? k : (LEGACY_KEYS[k] ?? k)
    const def = settingDef(key)
    const prev = below[key]
    if (!def || !Array.isArray(prev)) continue
    const orca = toOrca(def, prev)
    if (!Array.isArray(orca)) continue
    out ??= { ...raw }
    out[k] = v.map((x, i) => (x === NIL && i < orca.length ? orca[i] : x))
  }
  return out ?? raw
}

/**
 * A preset and the presets it inherits from, child first, into one config. Each layer is read on its own and the
 * results merge root first, so a value the child could not use leaves the parent's in place. `origin` names the
 * layer each inherited value comes from; values of the preset itself have none. `dropped` is the child's own.
 */
export function importLayers(layers: readonly ImportLayer[]): { config: PrintConfig; origin: Record<string, string>; dropped: Dropped[] } {
  const config: Record<string, SettingValue> = {}
  const origin: Record<string, string> = {}
  let dropped: Dropped[] = []
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i] as ImportLayer
    let values: Record<string, SettingValue>
    if (layer.config) values = layer.config as unknown as Record<string, SettingValue>
    else {
      const r = importValues(fillNil(layer.raw ?? {}, config))
      values = r.config as unknown as Record<string, SettingValue>
      if (i === 0) dropped = r.dropped
    }
    for (const [k, v] of Object.entries(values)) {
      config[k] = v
      if (i === 0) delete origin[k]
      else origin[k] = layer.name
    }
  }
  return { config: config as unknown as PrintConfig, origin, dropped }
}

const WORDS: Record<string, string> = { gcode: 'G-code', ams: 'AMS', xy: 'XY', id: 'ID', led: 'LED', ptc: 'PTC', ai: 'AI', pa: 'PA', x: 'X', y: 'Y', z: 'Z', e: 'E' }

/** A readable name for a setting key: the schema's label, a label kept for keys outside it, or the key's words. */
export function settingLabel(key: string): string {
  const def = settingDef(key)
  if (def) return def.label
  const kept = NEAREST.labels[key]
  if (kept) return kept
  const text = key
    .split('_')
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase())
    .join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A typed value for a person: enum labels in place of enum values, units, lists that repeat one value once. */
export function displayValue(def: SettingDef | undefined, v: SettingValue | undefined): string {
  if (def && isEnum(def) && def.enumValues && def.enumLabels && v !== undefined) {
    const label = (x: unknown) => {
      const i = typeof x === 'string' ? def.enumValues!.indexOf(x) : -1
      return i >= 0 ? (def.enumLabels![i] ?? String(x)) : String(x)
    }
    if (Array.isArray(v)) {
      const items = v as unknown[]
      return items.length > 0 && items.every((x) => x === items[0]) ? label(items[0]) : items.map(label).join(', ')
    }
    return label(v)
  }
  return formatValue(def, v)
}

const clip = (s: string): string => {
  const one = s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  return one === '' ? 'empty' : one.length > 60 ? one.slice(0, 57) + '...' : one
}

/** A value as the file wrote it, for a person: lists that repeat one value once, long text cut short. */
export function displayRaw(v: unknown): string {
  if (v === undefined || v === null) return 'not set'
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every((x) => typeof x !== 'object' && x === v[0])) return displayRaw(v[0])
    return clip(v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', '))
  }
  return typeof v === 'object' ? clip(JSON.stringify(v)) : clip(String(v))
}

export interface ReportInput {
  name: string
  section: SettingSection
  family: KeyFamily
  dropped: readonly Dropped[]
  /** What the preset became: its own values over those of the profiles it inherits from. */
  config: PrintConfig
  /** Inherited keys, by the name of the profile their value comes from. */
  origin: Readonly<Record<string, string>>
  /** The printer profile that fills what the preset does not set. */
  printer?: { name: string; config: PrintConfig }
  parent?: { name: string; found: boolean; bundled?: boolean }
  defaulted: number
}

const REASON_ORDER: Record<DropReason, number> = { invalid: 0, unsupported: 1, obsolete: 2 }

/** The report of one imported preset. Items are sorted by reason, then label. */
export function buildReport(input: ReportInput): ImportReport {
  const config = input.config as unknown as Record<string, SettingValue | undefined>
  const printer = input.printer?.config as unknown as Record<string, SettingValue | undefined> | undefined
  const insteadFor = (key: string, nearest: boolean): Instead | null => {
    const def = settingDef(key)
    if (!def) return null
    const base = { key, label: def.label, nearest }
    const own = config[key]
    if (own !== undefined) {
      const from = input.origin[key]
      return { ...base, value: displayValue(def, own), ...(from !== undefined ? { source: 'profile' as const, from } : { source: 'preset' as const }) }
    }
    const p = printer?.[key]
    if (p !== undefined && input.printer) return { ...base, value: displayValue(def, p), source: 'printer', from: input.printer.name }
    return { ...base, value: displayValue(def, def.default), source: 'default' }
  }
  const items: ReportItem[] = input.dropped.map((d) => {
    const target = d.target ?? NEAREST.keys[input.family][d.key]
    const nearest = d.target === undefined ? target !== undefined : d.nearestValue === true
    const labelKey = d.target ?? d.key
    return {
      key: d.key,
      label: settingLabel(labelKey),
      oldValue: displayRaw(d.value),
      reason: d.reason,
      instead: target === undefined ? null : insteadFor(target, nearest),
    }
  })
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  items.sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] || cmp(a.label.toLowerCase(), b.label.toLowerCase()) || cmp(a.key, b.key))
  return { name: input.name, section: input.section, ...(input.parent ? { parent: input.parent } : {}), items, defaulted: input.defaulted }
}

/** How many settings of a kind a config leaves to the printer profile (hidden settings are not counted). */
export function countDefaulted(section: SettingSection, config: PrintConfig): number {
  const c = config as unknown as Record<string, unknown>
  return SETTINGS.filter((d) => d.section === section && d.mode !== 'hidden' && c[d.key] === undefined).length
}

const KIND_WORD: Record<SettingSection, string> = { process: 'process', filament: 'filament', printer: 'printer' }

/** Why, in words. */
export function reasonText(r: DropReason): string {
  return r === 'unsupported' ? 'SlicerX has no such setting' : r === 'invalid' ? 'SlicerX cannot use this value' : 'Obsolete setting'
}

/** Where the value comes from, in words. */
export function sourceText(i: Instead): string {
  if (i.source === 'preset') return 'this preset'
  if (i.source === 'profile') return `the ${i.from ?? 'parent'} profile`
  if (i.source === 'printer') return `the ${i.from ?? 'printer'} printer profile`
  return 'the SlicerX default'
}

/** What SlicerX does instead, in words: "Uses Lateral lattice, the nearest value." */
export function insteadText(item: ReportItem): string {
  const i = item.instead
  if (!i) return 'Nothing in SlicerX does this.'
  if (item.reason === 'invalid') return i.nearest ? `Uses ${i.value}, the nearest value SlicerX has.` : `Uses ${i.value}, from ${sourceText(i)}.`
  return `${i.nearest ? 'Nearest equivalent is' : 'Uses'} ${i.label}: ${i.value}, from ${sourceText(i)}.`
}

/** The one line about settings the old preset never had. Empty when there are none. */
export function defaultedText(r: ImportReport): string {
  if (r.defaulted === 0) return ''
  return `${r.defaulted} ${r.defaulted === 1 ? 'setting uses' : 'settings use'} the printer profile's defaults.`
}

/** The line about the profile the preset inherits from. Empty when it inherits from none. */
export function parentText(r: ImportReport): string {
  if (!r.parent) return ''
  if (r.parent.bundled) return `Settings it does not change come from ${r.parent.name}, imported with it.`
  return r.parent.found ? `Settings it does not change come from SlicerX's copy of ${r.parent.name}.` : `It inherits from ${r.parent.name}, which SlicerX does not have.`
}

/** The reports as plain text, for saving or pasting. Keys appear only when `keys` is set (developer mode). */
export function reportText(reports: readonly ImportReport[], opts: { keys?: boolean; source?: string } = {}): string {
  const out: string[] = ['SlicerX import report' + (opts.source ? `: ${opts.source}` : ''), '']
  for (const r of reports) {
    out.push(`${r.name} (${KIND_WORD[r.section]} preset)`)
    const p = parentText(r)
    if (p) out.push(p)
    if (r.items.length === 0) out.push('Every setting carried over.')
    else out.push(`${r.items.length} ${r.items.length === 1 ? 'setting' : 'settings'} did not carry over:`)
    for (const it of r.items) {
      const key = opts.keys ? ` [${it.key}]` : ''
      out.push(`  ${it.label}${key}: ${it.oldValue}. ${reasonText(it.reason)}. ${insteadText(it)}`)
    }
    const d = defaultedText(r)
    if (d) out.push(d)
    out.push('')
  }
  return out.join('\n').trimEnd() + '\n'
}
