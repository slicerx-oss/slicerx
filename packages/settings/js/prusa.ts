// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// PrusaSlicer presets to SlicerX settings. Reads a single exported `.ini` (one preset, or the whole configuration of a
// project with print, filament and printer keys together) and a config bundle (`[print:Name]`, `[filament:Name]`,
// `[printer:Name]` sections with `inherits`), and maps the keys through `prusa-map.json` plus a few composite
// conversions. A key that is in the schema under the same name needs no map entry. What stays unmapped is reported.
import type { PrintConfig, SettingSection } from '@slicerx/contracts/settings'
import mapJson from '../prusa-map.json'
import { LEGACY_KEYS, PROFILE_META_KEYS } from './import'
import { importValues, type Dropped } from './report'
import { settingDef } from './schema'

interface PrusaMap {
  rename: Record<string, string>
  values: { key: string; from: string; to: string }[]
  percentOf: Record<string, string>
  percentBaseDefaults: Record<string, number>
  ignoredPattern: string
  ignoredKeys: string[]
}
const MAP = mapJson as unknown as PrusaMap
const IGNORED = new Set(MAP.ignoredKeys)
const IGNORED_RE = new RegExp(MAP.ignoredPattern)

/** Prusa key to SlicerX key, for the keys that are renamed. */
export const PRUSA_KEY_MAP: Readonly<Record<string, string>> = MAP.rename

export interface PrusaPreset {
  section: SettingSection
  name: string
  /** Parents of a bundle preset, by name (abstract `*common*` sections included). Already merged into `config`. */
  inherits: string[]
  config: PrintConfig
  /** Keys PrusaSlicer has and we do not map. */
  unmappedKeys: string[]
  /** Keys that are not print settings (SLA, preset ids, host credentials, project placement). */
  ignoredKeys: string[]
  /** Keys that mapped but whose value did not fit the setting. */
  invalidKeys: string[]
  /** What did not carry over, in Prusa's keys, for the import report. */
  dropped: Dropped[]
}

type Raw = Record<string, string>

/** PrusaSlicer's escaping for a string value: `\n`, `\r` and `\\`, any other escaped character stands for itself. */
function unescape(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c === '\\' && i + 1 < s.length) {
      const e = s[i + 1] as string
      out += e === 'n' ? '\n' : e === 'r' ? '\r' : e
      i++
    } else out += c
  }
  return out
}

/** A list of strings: items separated by `;`, each optionally in double quotes (which may hold `;`). */
function splitStrings(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c === '"') quoted = !quoted
    else if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++ }
    else if (c === ';' && !quoted) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map(unescape)
}

interface IniSection { type: string; name: string; values: Raw }

/** Read the `key = value` lines of an ini file into sections. Lines before the first header form a section of type `''`. */
export function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = []
  let cur: IniSection = { type: '', name: '', values: {} }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const head = /^\[([^\]]+)\]$/.exec(line)
    if (head) {
      if (Object.keys(cur.values).length > 0 || cur.type !== '') sections.push(cur)
      const h = head[1] as string
      const colon = h.indexOf(':')
      cur = colon < 0 ? { type: h.trim(), name: '', values: {} } : { type: h.slice(0, colon).trim(), name: h.slice(colon + 1).trim(), values: {} }
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue
    cur.values[key] = line.slice(eq + 1).trim()
  }
  if (Object.keys(cur.values).length > 0 || cur.type !== '') sections.push(cur)
  return sections
}

const percent = (v: string): number | undefined => (/^\s*[-+]?\d+(\.\d+)?\s*%\s*$/.test(v) ? parseFloat(v) : undefined)
const num = (v: string | undefined): number | undefined => (v !== undefined && /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(v) ? parseFloat(v) : undefined)

/** A Prusa number that may be a percent of another key, as mm. The base is read from the same preset, else Prusa's default. */
function absolute(key: string, raw: Raw, seen = new Set<string>()): number | undefined {
  const v = raw[key]
  const base = MAP.percentOf[key]
  if (v === undefined) return MAP.percentBaseDefaults[key]
  const p = percent(v)
  if (p === undefined) return num(v)
  if (base === undefined || seen.has(key)) return undefined
  seen.add(key)
  const b = absolute(base, raw, seen)
  return b === undefined ? undefined : Math.round(b * p) / 100
}

const SECTION_ORDER: SettingSection[] = ['process', 'filament', 'printer']

/**
 * Map one preset's Prusa values to Orca-format values (the strings and lists `importFlat` reads). Returns the mapped
 * values and the Prusa keys that were not mapped or ignored.
 */
export function mapPrusaValues(prusa: Raw): { values: Record<string, unknown>; unmapped: string[]; ignored: string[] } {
  const out: Record<string, unknown> = {}
  const unmapped: string[] = []
  const ignored: string[] = []
  const done = new Set<string>()
  const put = (k: string, v: unknown): void => { out[k] = v }
  const setTemp = (keys: string[], v: string): void => { for (const k of keys) put(k, v) }

  // Composite conversions first; each marks the Prusa keys it consumed.
  const take = (...keys: string[]): void => { for (const k of keys) done.add(k) }

  // Support: the enable flag, the auto flag and the style choose Orca's support type.
  if ('support_material' in prusa) {
    const sm = prusa['support_material'] as string
    const enabled = sm === '1' || sm === 'everywhere' || sm === 'enforcers_only'
    put('enable_support', enabled ? '1' : '0')
    const auto = prusa['support_material_auto'] !== '0' && sm !== 'enforcers_only'
    const tree = prusa['support_material_style'] === 'organic'
    put('support_type', `${tree ? 'tree' : 'normal'}(${auto ? 'auto' : 'manual'})`)
    take('support_material', 'support_material_auto')
  } else if ('support_material_auto' in prusa) take('support_material_auto')

  // First layer speed: an absolute value covers every first-layer move, a percent scales each default speed.
  if ('first_layer_speed' in prusa) {
    const v = prusa['first_layer_speed'] as string
    const p = percent(v)
    if (p === undefined) {
      const n = num(v)
      if (n !== undefined) { put('initial_layer_speed', String(n)); if (!('first_layer_infill_speed' in prusa)) put('initial_layer_infill_speed', String(n)) }
    } else {
      const wall = absolute('perimeter_speed', prusa)
      const infill = absolute('infill_speed', prusa)
      if (wall !== undefined) put('initial_layer_speed', String(Math.round(wall * p) / 100))
      if (infill !== undefined && !('first_layer_infill_speed' in prusa)) put('initial_layer_infill_speed', String(Math.round(infill * p) / 100))
    }
    take('first_layer_speed')
  }

  // Ironing is a switch plus a type in Prusa, one enum in Orca.
  if ('ironing' in prusa) {
    if (prusa['ironing'] === '0') put('ironing_type', 'no ironing')
    else if (!('ironing_type' in prusa)) put('ironing_type', 'top')
    take('ironing')
  }
  if (prusa['ironing'] === '0') take('ironing_type')

  // Bed temperature: one value in Prusa, one per plate in Orca. A smooth or textured PEI sheet is the common case.
  if ('bed_temperature' in prusa) { setTemp(['hot_plate_temp', 'textured_plate_temp'], prusa['bed_temperature'] as string); take('bed_temperature') }
  if ('first_layer_bed_temperature' in prusa) { setTemp(['hot_plate_temp_initial_layer', 'textured_plate_temp_initial_layer'], prusa['first_layer_bed_temperature'] as string); take('first_layer_bed_temperature') }

  // Travel lift: a ramping lift is Orca's slope lift.
  if ('travel_ramping_lift' in prusa) { put('z_hop_types', prusa['travel_ramping_lift'] === '1' ? 'Slope Lift' : 'Normal Lift'); take('travel_ramping_lift') }

  for (const [key, rawValue] of Object.entries(prusa)) {
    if (done.has(key)) continue
    if (IGNORED.has(key) || IGNORED_RE.test(key) || PROFILE_META_KEYS.has(key)) { ignored.push(key); continue }
    const target = MAP.rename[key] ?? (settingDef(key) ? key : undefined) ?? LEGACY_KEYS[key]
    if (target === undefined) { unmapped.push(key); continue }
    const def = settingDef(target)
    let v: string = rawValue
    if (key in MAP.percentOf) {
      const a = absolute(key, prusa)
      if (a !== undefined && percent(v) !== undefined) v = String(a)
    }
    const vm = MAP.values.find((r) => r.key === key && r.from === v)
    if (vm) v = vm.to
    if (key === 'first_layer_height' && percent(rawValue) !== undefined) {
      const a = absolute(key, prusa)
      if (a !== undefined) v = String(a)
    }
    let value: unknown = v
    if (v === 'nil') value = 'nil'
    else if (def?.type === 'strings') value = splitStrings(v)
    else if (def?.type === 'gcode' || def?.type === 'string') value = unescape(v)
    // Prusa writes gcode_label_objects and similar through the value map above; a bare 1/0 stays as is.
    if (!(target in out)) put(target, value)
  }
  return { values: out, unmapped: unmapped.sort(), ignored: ignored.sort() }
}

function sectionOfKey(k: string): SettingSection | undefined {
  const t = settingDef(k)
  return t?.section
}

const PRINTER_KEY = /^(bed_|machine_|max_print_height|nozzle_|extruder|retract|deretract|wipe($|_)|z_offset|gcode|thumbnails|printer_|host_|use_|silent_mode|travel_ramping|travel_lift|travel_max_lift|travel_slope|binary_gcode|autoemit|between_objects_gcode|color_change_gcode|pause_print_gcode|template_custom_gcode|start_gcode|end_gcode|layer_gcode|before_layer_gcode|toolchange_gcode|remaining_times|single_extruder|high_current|multimaterial|variable_layer_height|cooling_tube|parking_pos|extra_loading|min_layer_height|max_layer_height)/

/** The kind of preset a Prusa key belongs to, for keys SlicerX does not map: filament keys, printer keys, the rest print keys. */
export function prusaKeyKind(key: string): SettingSection {
  if (/^(filament_|temperature$|first_layer_temperature|fan_|min_fan|max_fan|bridge_fan|disable_fan|cooling|slowdown|min_print_speed|overhang_fan|enable_dynamic_fan|full_fan|idle_temperature|chamber_|compatible_prints)/.test(key)) return 'filament'
  if (PRINTER_KEY.test(key)) return 'printer'
  return 'process'
}

function toPreset(section: SettingSection, name: string, inherits: string[], raw: Raw, mixed = false): PrusaPreset {
  const m = mapPrusaValues(raw)
  const keep: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m.values)) {
    const s = sectionOfKey(k)
    // The compatibility keys are filed under process in the schema but belong to every preset.
    if (s === section || k.startsWith('compatible_') || s === undefined) keep[k] = v
  }
  const r = importValues(keep)
  const back = (k: string): string => (k in raw ? k : (Object.keys(MAP.rename).find((p) => MAP.rename[p] === k && p in raw) ?? k))
  // A whole configuration feeds every kind; each unmapped key is reported with the kind it belongs to.
  const unmapped = mixed ? m.unmapped.filter((k) => prusaKeyKind(k) === section) : m.unmapped
  const dropped: Dropped[] = [...unmapped.map((k): Dropped => ({ key: k, value: raw[k], reason: 'unsupported' })), ...r.dropped.map((d) => ({ ...d, key: back(d.key), value: raw[back(d.key)] ?? d.value }))]
  dropped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const invalidKeys = r.dropped.filter((d) => d.reason === 'invalid').map((d) => d.target ?? d.key)
  return { section, name, inherits, config: r.config, unmappedKeys: unmapped, ignoredKeys: m.ignored, invalidKeys, dropped }
}

/**
 * Read PrusaSlicer's text: a single exported preset, an exported project configuration, or a config bundle. A bundle's
 * `inherits` chains (including abstract `*name*` sections) are merged, parents first, and the abstract ones are not returned.
 * An exported configuration holding keys of several kinds gives one preset per kind.
 */
export function importPrusaIni(text: string, fileName = ''): PrusaPreset[] {
  const sections = parseIni(text)
  const baseName = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim()
  const typed = sections.filter((s) => ['print', 'filament', 'printer'].includes(s.type))
  if (typed.length > 0) {
    const byKey = new Map(typed.map((s) => [`${s.type}:${s.name}`, s]))
    const resolveRaw = (s: IniSection, depth = 0): { raw: Raw; parents: string[] } => {
      const parents = (s.values['inherits'] ?? '').split(';').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
      let raw: Raw = {}
      if (depth < 16) for (const p of parents) {
        const ps = byKey.get(`${s.type}:${p}`)
        if (ps) raw = { ...raw, ...resolveRaw(ps, depth + 1).raw }
      }
      const own = { ...s.values }
      delete own['inherits']
      return { raw: { ...raw, ...own }, parents }
    }
    const out: PrusaPreset[] = []
    for (const s of typed) {
      if (s.name.startsWith('*')) continue
      const { raw, parents } = resolveRaw(s)
      out.push(toPreset(s.type === 'print' ? 'process' : (s.type as SettingSection), s.name, parents, raw))
    }
    return out
  }
  // No headers: one preset, or a whole configuration. Keys go to the section their target belongs to.
  const raw: Raw = {}
  for (const s of sections) Object.assign(raw, s.values)
  if (Object.keys(raw).length === 0) return []
  const m = mapPrusaValues(raw)
  const present = new Set<SettingSection>()
  for (const k of Object.keys(m.values)) {
    const s = sectionOfKey(k)
    if (s && !k.startsWith('compatible_')) present.add(s)
  }
  const nameOf = (s: SettingSection): string => {
    const id = raw[s === 'process' ? 'print_settings_id' : s === 'filament' ? 'filament_settings_id' : 'printer_settings_id']
    return (id ? unescape(id.replace(/^"|"$/g, '')) : '') || baseName || 'Imported preset'
  }
  return SECTION_ORDER.filter((s) => present.has(s)).map((s) => toPreset(s, nameOf(s), [], raw, present.size > 1))
}

/**
 * The `key = value` lines of a PrusaSlicer config wherever it is embedded: `Metadata/Slic3r_PE.config` in a 3MF
 * project and the end of a G-code file write each line after `; `. A plain `.ini` reads as is.
 */
export function readPrusaConfig(text: string): Raw {
  const raw: Raw = {}
  for (const line of text.split(/\r?\n/)) {
    const body = line.startsWith('; ') ? line.slice(2) : line
    const t = body.trim()
    if (t === '' || t.startsWith('#') || t.startsWith(';') || t.startsWith('[')) continue
    const eq = t.indexOf('=')
    if (eq < 1) continue
    const key = t.slice(0, eq).trim()
    if (/^[A-Za-z0-9_]+$/.test(key)) raw[key] = t.slice(eq + 1).trim()
  }
  return raw
}

/**
 * A PrusaSlicer project's settings (`Metadata/Slic3r_PE.config`) as Orca-format values, the form project_settings.config
 * has in an Orca or Bambu Studio project, plus the Prusa keys that have no SlicerX setting. Filament colors come back
 * as `filament_colour`.
 */
export function prusaProjectSettings(text: string): { values: Record<string, unknown>; unmapped: string[] } {
  const raw = readPrusaConfig(text)
  const m = mapPrusaValues(raw)
  const values: Record<string, unknown> = { ...m.values }
  const colors = raw['extruder_colour'] ?? raw['filament_colour']
  if (colors !== undefined) {
    const list = splitStrings(colors).map((c) => c.trim()).filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c))
    if (list.length) values['filament_colour'] = list
  }
  return { values, unmapped: m.unmapped }
}

/** One object's or volume's Prusa settings (`Slic3r_PE_model.config` metadata) as Orca-format strings. */
export function prusaOverrides(meta: Readonly<Record<string, string>>): Record<string, string> {
  const m = mapPrusaValues({ ...meta })
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m.values)) out[k] = Array.isArray(v) ? v.join(',') : String(v)
  return out
}
