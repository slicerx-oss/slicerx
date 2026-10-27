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
  /** Width keys a project gives as a percent of a height, by the key the percent is of. */
  widthPercentOf: Record<string, string>
  ignoredPattern: string
  ignoredKeys: string[]
  /** Keys that carry over only through a `values` row; any other value is left out and reported as not applied. */
  onlyMappedValues: string[]
  /** Keys whose value 0 means not set, read as absent. */
  zeroIsUnset: string[]
  /** Keys that carry over in mm only; a percent is left out and reported as not applied. */
  noPercent: string[]
  composites: {
    /** One key's value set on each of several keys. */
    fanOut: Record<string, string[]>
    /** Another key's value picked by this key's value, `else` for any value the table does not list. */
    valueToKey: Record<string, { to: string; values: Record<string, string>; else: string }>
  }
  /** What a project file's settings may set (see `takesProjectValue`). */
  projectTakes: {
    sections: string[]
    types: string[]
    /** Text settings with a grammar of their own: the characters each may hold, as a regular expression class. */
    text: Record<string, string>
    textSection: string
    textMaxLength: number
    unread: string[]
    unsetValues: string[]
  }
}
const MAP = mapJson as unknown as PrusaMap
const IGNORED = new Set(MAP.ignoredKeys)
const ONLY_MAPPED = new Set(MAP.onlyMappedValues)
const ZERO_IS_UNSET = new Set(MAP.zeroIsUnset)
const NO_PERCENT = new Set(MAP.noPercent)
const TAKES = MAP.projectTakes
const TAKEN_SECTIONS = new Set(TAKES.sections)
const TAKEN_TYPES = new Set(TAKES.types)
const UNREAD = new Set(TAKES.unread)
const UNSET_VALUES = new Set(TAKES.unsetValues)

/** The text settings a project file may set, with what each accepts (the settings rows check typed text the same way). */
export const PROJECT_TEXT_RULES: Readonly<Record<string, RegExp>> = Object.fromEntries(Object.entries(TAKES.text).map(([k, cls]) => [k, new RegExp(`^[${cls}]*$`)]))

/** Whether `text` is a value a text setting can hold: one line, not too long, and the setting's own grammar when it has one. */
export function projectTextOk(key: string, text: string): boolean {
  if (/[\r\n]/.test(text) || text.length > TAKES.textMaxLength) return false
  const rule = PROJECT_TEXT_RULES[key]
  return rule ? rule.test(text) : true
}

/** A key a project's own settings leave unread (`projectTakes.unread`), dropped before any older name is read as ours. */
export function isProjectUnread(key: string): boolean {
  return UNREAD.has(key)
}

/**
 * Whether a project file's settings may set `key` to `value` (prusa-map.json `projectTakes`): a plain number, percent,
 * switch or choice of the print or filament settings, or one of the text settings with a grammar the value fits. Free
 * text, G-code, scripts, credentials, the printer's own settings and a value that means unset (`nil`) are left for the
 * person's own printer and presets. The app's project open, `prusaProjectConfig` and the engine's PrusaSlicer project
 * reading all use this rule.
 */
export function takesProjectValue(key: string, value: unknown): boolean {
  if (isProjectUnread(key) || (typeof value === 'string' && UNSET_VALUES.has(value))) return false
  const def = settingDef(key)
  if (!def || !TAKEN_SECTIONS.has(def.section)) return false
  if (TAKEN_TYPES.has(def.type)) return true
  return def.type === 'string' && def.section === TAKES.textSection && key in TAKES.text && typeof value === 'string' && projectTextOk(key, value)
}
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

/** The outer wall's width at the layer height in a project's own settings: its own width when set (a percent of the
 * layer height), else the general width, else 1.125 times the project's own nozzle diameter (0.4 when it has none). */
function outerWidth(raw: Raw): number | undefined {
  const lh = absolute('layer_height', raw)
  if (lh === undefined) return undefined
  for (const key of ['external_perimeter_extrusion_width', 'extrusion_width']) {
    const v = raw[key]
    if (v === undefined) continue
    const p = percent(v)
    const w = p === undefined ? num(v) : (p / 100) * lh
    if (w !== undefined && w !== 0) return w
  }
  const nozzle = raw['nozzle_diameter'] === undefined ? MAP.percentBaseDefaults['nozzle_diameter'] : num(raw['nozzle_diameter'].split(',')[0])
  return nozzle === undefined ? undefined : 1.125 * nozzle
}

/**
 * The mm a width percent in a project's own settings stands for (prusa-map.json `widthPercentOf`): a percent of the
 * first layer height for the first layer width, of the layer height for the other widths, and of the outer wall's width
 * for the support's XY gap. Heights are the project's own, as the project sets them, else the defaults.
 */
function widthMm(key: string, p: number, raw: Raw): number | undefined {
  const of = MAP.widthPercentOf[key]
  if (of === undefined) return undefined
  const base = of === 'external_perimeter_width' ? outerWidth(raw) : absolute(of, raw)
  // Kept to a nanometer, so float noise does not show: 150% of 0.15 is 0.225.
  return base === undefined ? undefined : Math.round(((base * p) / 100) * 1e9) / 1e9
}

/** A project's own settings with each width percent of `widthPercentOf` in mm, all read from the settings as given. */
function projectWidths(raw: Raw): Raw {
  const out: Raw = { ...raw }
  for (const [key, v] of Object.entries(raw)) {
    const p = percent(v)
    const mm = p === undefined ? undefined : widthMm(key, p, raw)
    if (mm !== undefined) out[key] = String(mm)
  }
  return out
}

const SECTION_ORDER: SettingSection[] = ['process', 'filament', 'printer']

/**
 * Map one preset's Prusa values to Orca-format values (the strings and lists `importFlat` reads). Returns the mapped
 * values, the Prusa keys that were not mapped or ignored, and the values left out because SlicerX reads them
 * differently (`notApplied`, in Prusa's keys).
 */
export function mapPrusaValues(given: Raw): { values: Record<string, unknown>; unmapped: string[]; ignored: string[]; notApplied: Dropped[] } {
  // A 0 that means "not set" is read as if the key were absent, so the composites below fill it.
  const prusa: Raw = Object.fromEntries(Object.entries(given).filter(([k, v]) => !(ZERO_IS_UNSET.has(k) && num(v) === 0)))
  const out: Record<string, unknown> = {}
  const unmapped: string[] = []
  const ignored: string[] = []
  const notApplied: Dropped[] = []
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

  // One value set on several keys (bed temperature: one value in Prusa, one per plate in Orca; a smooth or textured PEI
  // sheet is the common case), and a value that picks another key's (a ramping travel lift is Orca's slope lift).
  for (const [key, to] of Object.entries(MAP.composites.fanOut)) if (key in prusa) { setTemp(to, prusa[key] as string); take(key) }
  for (const [key, row] of Object.entries(MAP.composites.valueToKey)) if (key in prusa) { put(row.to, row.values[prusa[key] as string] ?? row.else); take(key) }

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
    if (NO_PERCENT.has(key) && percent(v) !== undefined) { notApplied.push({ key, value: rawValue, reason: 'invalid', target }); continue }
    const vm = MAP.values.find((r) => r.key === key && r.from === v)
    if (vm) v = vm.to
    else if (ONLY_MAPPED.has(key)) { notApplied.push({ key, value: rawValue, reason: 'invalid', target }); continue }
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
  notApplied.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { values: out, unmapped: unmapped.sort(), ignored: ignored.sort(), notApplied }
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
  const notApplied = m.notApplied.filter((d) => d.target === undefined || sectionOfKey(d.target) === section)
  const dropped: Dropped[] = [...unmapped.map((k): Dropped => ({ key: k, value: raw[k], reason: 'unsupported' })), ...r.dropped.map((d) => ({ ...d, key: back(d.key), value: raw[back(d.key)] ?? d.value })), ...notApplied]
  dropped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const invalidKeys = [...r.dropped, ...notApplied].filter((d) => d.reason === 'invalid').map((d) => d.target ?? d.key)
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
 * has in an Orca or Bambu Studio project, plus the Prusa keys that have no SlicerX setting and the values left out
 * because SlicerX reads them differently. Filament colors come back as `filament_colour`.
 */
export function prusaProjectSettings(text: string): { values: Record<string, unknown>; unmapped: string[]; notApplied: Dropped[] } {
  const raw = readPrusaConfig(text)
  const m = mapPrusaValues(projectWidths(raw))
  const values: Record<string, unknown> = { ...m.values }
  const colors = raw['extruder_colour'] ?? raw['filament_colour']
  if (colors !== undefined) {
    const list = splitStrings(colors).map((c) => c.trim()).filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c))
    if (list.length) values['filament_colour'] = list
  }
  return { values, unmapped: m.unmapped, notApplied: m.notApplied }
}

/**
 * What a PrusaSlicer project's settings set when it opens (`prusaProjectSettings` through `takesProjectValue`): the
 * print and filament values a project may set, in the Orca-format values project_settings.config has. The printer's own
 * settings, G-code and text stay the current printer's. The app's project open, the MCP server's `readProjectFile` and
 * the engine (`sx project-settings`, `sx slice <project.3mf>`) give the same config; fixtures/prusa-project-settings.json
 * holds the cases all of them run. `left` lists the mapped keys a project may not set; `colors` are the filament colors.
 */
export function prusaProjectConfig(text: string): { config: Record<string, unknown>; unmapped: string[]; notApplied: Dropped[]; left: string[]; colors: string[] } {
  const m = prusaProjectSettings(text)
  const config: Record<string, unknown> = {}
  const left: string[] = []
  for (const [k, v] of Object.entries(m.values)) {
    if (takesProjectValue(k, v)) config[k] = v
    else left.push(k)
  }
  const colors = Array.isArray(m.values['filament_colour']) ? (m.values['filament_colour'] as string[]) : []
  return { config, unmapped: m.unmapped, notApplied: m.notApplied, left: left.sort(), colors }
}

/**
 * One object's Prusa settings as `prusaOverrides` gives them, plus each width percent that the object's own layer height
 * decides, in mm: one the object sets, and the project's own when the object has its own `layer_height`. Both are of the
 * object's layer height (the project's when it sets none), and the support XY spacing of the object's outer wall width.
 * The first layer width stays the project's. `projectText` is the text of `Metadata/Slic3r_PE.config`.
 */
export function prusaObjectOverrides(meta: Readonly<Record<string, string>>, projectText?: string): Record<string, string> {
  const out = prusaOverrides(meta)
  const raw: Raw = { ...(projectText === undefined ? {} : readPrusaConfig(projectText)), ...meta }
  const ownHeight = 'layer_height' in meta
  for (const key of Object.keys(MAP.widthPercentOf).sort()) {
    if (key === 'first_layer_extrusion_width' || !(ownHeight || key in meta)) continue
    const v = raw[key]
    const p = v === undefined ? undefined : percent(v)
    const mm = p === undefined ? undefined : widthMm(key, p, raw)
    if (mm !== undefined) out[MAP.rename[key] ?? key] = String(mm)
  }
  return out
}

/** One object's or volume's Prusa settings (`Slic3r_PE_model.config` metadata) as Orca-format strings. */
export function prusaOverrides(meta: Readonly<Record<string, string>>): Record<string, string> {
  const m = mapPrusaValues({ ...meta })
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m.values)) out[k] = Array.isArray(v) ? v.join(',') : String(v)
  return out
}
