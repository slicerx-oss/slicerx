// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What opening a 3MF project puts over the printer's settings, as the app opens one: a PrusaSlicer project's print and
// filament values on the current printer, and a Bambu Studio or Orca project's settings on its own printer or the
// current one. The app's project open and the MCP server's project slices call these, so one project on one printer
// slices the same in both.
import type { PrintConfig, SettingValue } from '@slicerx/contracts/settings'
import { projectBedType } from './bed-type'
import { changedKeys, keptEngineChoices, projectDefaults, sameChoice, SLICERX_KEEP_VALUES } from './engine-choices'
import { GCODE_TEXT_KEYS } from './gcode-review'
import { importFlat } from './import'
import { machineEntry, listPrinterProfiles } from './profiles'
import { isProjectUnread, takesProjectValue } from './prusa'
import { sameValue } from './diff'
import { settingDef } from './schema'
import { selectVariants } from './variants'
import { FILAMENT_OVERRIDE_KEYS } from './stock-layer'
import { coerce, NIL } from './value'

/** The key a project names its plate type in, which the slice keeps although no preset section holds it. */
const PLATE_TYPE_KEY = 'curr_bed_type'

export interface ProjectSettings {
  /** Changes against the current settings, in our keys. */
  values: Record<string, SettingValue>
  /** Every value the project gives that slicing takes, in our keys, the ones equal to the current settings too. */
  taken: Record<string, SettingValue>
  /** Keys left out on purpose: text, scripts, credentials, printer settings. */
  left: string[]
}

/**
 * A filament override list with a `nil` entry, one entry per filament ("0.6,nil" or ["nil", "Ramp Lift"]): each `nil` is
 * that filament on the printer's value, as the engine reads it, so it stays `nil` here instead of taking the entry
 * before it, and a list that starts with `nil` still brings the other filaments' own values. Undefined for any other
 * key or value, which the usual import reads.
 */
export function filamentOverrideList(key: string, raw: unknown): SettingValue | undefined {
  const def = settingDef(key)
  if (!def || !FILAMENT_OVERRIDE_KEYS.has(key)) return undefined
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.includes(',') ? raw.split(',') : undefined
  const entries = list?.map((x) => (typeof x === 'string' ? x.trim() : x))
  if (!entries?.includes(NIL) || entries.every((x) => x === NIL)) return undefined
  const out: (string | number | boolean)[] = []
  for (const x of entries) {
    if (x === NIL) {
      out.push(NIL)
      continue
    }
    const c = coerce(def, [x])
    if (c.ok !== true || !Array.isArray(c.value)) return undefined
    out.push(c.value[0] as string | number | boolean)
  }
  return out as SettingValue
}

/** A filament override key whose value overrides nothing: an empty list, or one of `nil` entries only. */
function leavesItToFilament(key: string, value: SettingValue): boolean {
  if (!FILAMENT_OVERRIDE_KEYS.has(key)) return false
  const entries: unknown[] = Array.isArray(value) ? value : [value]
  return entries.every((x) => x === NIL || x === '' || x === null || x === undefined)
}

// Bambu Studio prints a project's own values for wall_filament, sparse_infill_filament and solid_infill_filament on
// nothing ("1", the stock value, and every other alike), so the rule leaves a project's out (`unread`); an object's, a
// part's or a modifier's own still count (`modifierSettings`).
export function projectSettingChanges(raw: Record<string, unknown>, current: PrintConfig): ProjectSettings {
  const read = Object.fromEntries(Object.entries(raw).filter(([k]) => !isProjectUnread(k)))
  const variants = selectVariants(read)
  const imported = importFlat(variants).config as Record<string, SettingValue>
  for (const [key, value] of Object.entries(variants)) {
    const list = filamentOverrideList(key, value)
    if (list) imported[key] = list
  }
  const now = current as unknown as Record<string, SettingValue | undefined>
  const values: Record<string, SettingValue> = {}
  const taken: Record<string, SettingValue> = {}
  const left: string[] = []
  for (const [key, value] of Object.entries(imported)) {
    // An empty or all-nil filament override list leaves the value to the filament: like an unset value, it is no
    // project value, so it never counts as a change and is never pinned over the loaded filament's own.
    if (leavesItToFilament(key, value) || !takesProjectValue(key, value)) {
      left.push(key)
      continue
    }
    taken[key] = value
    if (!sameValue(value, now[key])) values[key] = value
  }
  // The plate type is no preset setting, but it picks the bed temperatures, so the slice keeps the project's.
  const plate = projectBedType(read)
  if (plate !== undefined) {
    taken[PLATE_TYPE_KEY] = plate
    if (!sameValue(plate, now[PLATE_TYPE_KEY])) values[PLATE_TYPE_KEY] = plate
  }
  return { values, taken, left }
}

export type ProjectPrinterMatch =
  | { kind: 'match'; profileId: string; vendor: string; model: string; nozzle: number; name: string; asked?: number; own?: { id: string; name: string } }
  | { kind: 'unknown'; name: string; nozzle?: number }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const first = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)
const sameMm = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

/**
 * The printer a project was made for, in our profiles: its `printer_settings_id` against each model's Orca profile
 * names (nozzle variants included), as Bambu Studio matches by name, else `printer_model` with `nozzle_diameter`.
 * `asked` is the project's nozzle when our profile has no such variant and the model's default stands in.
 * Null when the file names no printer.
 */
export function matchProjectPrinter(settings: Record<string, unknown>): ProjectPrinterMatch | null {
  const name = first(settings['printer_settings_id'])?.trim()
  const model = first(settings['printer_model'])?.trim()
  if (!name && !model) return null
  const label = name || model || ''
  const n = Number(first(settings['nozzle_diameter']) ?? first(settings['printer_variant']))
  const want = Number.isFinite(n) && n > 0 ? n : undefined
  const profiles = listPrinterProfiles()
  const hit = (p: (typeof profiles)[number], nozzle: number): ProjectPrinterMatch => ({ kind: 'match', profileId: p.id, vendor: p.vendor, model: p.model, nozzle, name: label })
  if (name) {
    for (const p of profiles) {
      const m = machineEntry(p.id)
      if (m?.orca?.profile === name) return hit(p, p.defaultNozzle)
      for (const [size, v] of Object.entries(m?.nozzles ?? {})) if (v.orcaProfile === name) return hit(p, Number(size))
    }
  }
  const key = norm(model ?? '')
  const p = key ? (profiles.find((x) => norm(`${x.vendor} ${x.model}`) === key || norm(x.model) === key) ?? prusaModel(profiles, key)) : undefined
  if (!p) return { kind: 'unknown', name: label, ...(want ? { nozzle: want } : {}) }
  if (want === undefined || p.nozzles.some((x) => sameMm(x, want))) return hit(p, want ?? p.defaultNozzle)
  return { ...hit(p, p.defaultNozzle), asked: want } as ProjectPrinterMatch
}

/**
 * PrusaSlicer's own model codes for a Prusa printer (`printer_model`): MK4IS, MINIIS and XLIS are the MK4, MINI and XL
 * on their input shaper firmware, the same machines as our profiles; XL5IS is the XL with five toolheads. Only Prusa's
 * profiles are looked at, so a code like these never matches another maker's printer.
 */
const PRUSA_CODES: Record<string, string> = { xl2: '', xl3: '', xl4: '', xl5: 'prusa-xl-5-toolhead' }
function prusaModel<P extends { id: string; vendor: string; model: string }>(profiles: readonly P[], key: string): P | undefined {
  const code = key.endsWith('is') ? key.slice(0, -2) : key
  const prusa = profiles.filter((x) => norm(x.vendor).startsWith('prusa'))
  if (code in PRUSA_CODES) return prusa.find((x) => x.id === PRUSA_CODES[code])
  return prusa.find((x) => norm(x.model) === code)
}

/** What an opened project's printer means for the printer the plate is on (`current`, its profile and nozzle). */
export type ProjectPrinterOffer =
  /** The plate is already on the project's printer and nozzle. */
  | { kind: 'same'; match: Extract<ProjectPrinterMatch, { kind: 'match' }> }
  /** Another printer we have a profile for: the person may switch to it, and the plate stays where it is until they do. */
  | { kind: 'offer'; match: Extract<ProjectPrinterMatch, { kind: 'match' }> }
  /** A printer we have no profile for: nothing to switch to, so the settings stay on the current printer. */
  | { kind: 'unknown'; name: string; nozzle?: number }

/**
 * Whether a project opened on `current` (its profile id and nozzle; no profile id for the generic bed) is for another
 * printer, and whether that printer can be offered. Null when the file names no printer. The app's open note and the
 * MCP server's project reads both answer with this, so a client hears what a person sees.
 */
export function projectPrinterOffer(match: ProjectPrinterMatch | null, current: { profileId?: string | null; nozzle?: number }): ProjectPrinterOffer | null {
  if (!match) return null
  if (match.kind === 'unknown') return { kind: 'unknown', name: match.name, ...(match.nozzle !== undefined ? { nozzle: match.nozzle } : {}) }
  const same = current.profileId === match.profileId && (current.nozzle === undefined || sameMm(current.nozzle, match.nozzle))
  return { kind: same ? 'same' : 'offer', match }
}

/** Settings made for one nozzle size: layer heights and line widths. */
export function nozzleBound(key: string): boolean {
  return key === 'layer_height' || key === 'initial_layer_print_height' || key.endsWith('line_width')
}

/** The overrides split for another printer: what carries over, and what stays with the project printer (`dropped` names the settings, not the G-code). */
export function carryOver(overrides: Record<string, SettingValue>, gcodeKeys: readonly string[], sameNozzle: boolean): { kept: Record<string, SettingValue>; parked: Record<string, SettingValue>; dropped: string[] } {
  const kept: Record<string, SettingValue> = {}
  const parked: Record<string, SettingValue> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(overrides)) {
    if (gcodeKeys.includes(k)) parked[k] = v
    else if (!sameNozzle && nozzleBound(k)) {
      parked[k] = v
      dropped.push(k)
    } else kept[k] = v
  }
  return { kept, parked, dropped }
}

/** Printer setting types a project's file carries over: numbers, switches and choices, as for its print settings. */
const PLAIN_TYPES: ReadonlySet<string> = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent', 'floatsOrPercents', 'bools', 'enums'])
/** Printer setting groups that stay the profile's: how SlicerX reaches the printer (host, credentials, upload). */
const HELD_GROUPS: ReadonlySet<string> = new Set(['network'])
/** The printer's identity: its model, variant, structure and presets. Its notes are free text and stay the profile's. */
const IDENTITY_GROUP = 'profile'
const IDENTITY_TEXT_HELD: ReadonlySet<string> = new Set(['printer_notes'])
/** One line of plain text of at most 200 characters, or a list of such: a name, not a script. */
const plainName = (v: SettingValue): boolean => (Array.isArray(v) ? v : [v]).every((x) => typeof x === 'string' && x.length <= 200 && ![...x].some((c) => c.charCodeAt(0) < 32))
/**
 * Printer settings of other types whose value the file brings when it fits: the extruder colors (`#RRGGBB`, with an
 * optional alpha) and the spot arrange starts from (two fractions of the bed).
 */
const TAKEN_WHEN: Readonly<Record<string, (v: SettingValue) => boolean>> = {
  extruder_colour: (v) => Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c)),
  best_object_pos: (v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1),
}
/**
 * Printer settings that stay the profile's on the project's own printer, since a check reads them as what the machine
 * is or allows: its bed height, its nozzle, the nozzle's hardness and height (the travel collision check reads the
 * height), the clearances a print by object is checked with, the firmware the G-code review checks against, how many
 * tool heads it has and its printed mass limit.
 * `sx project-settings` prints the file's value for them; the app keeps the profile's.
 */
const HELD_KEYS: ReadonlySet<string> = new Set([
  'printable_height',
  'extruder_printable_height',
  'nozzle_diameter',
  'nozzle_type',
  'nozzle_hrc',
  'nozzle_height',
  'extruder_type',
  'extruder_clearance_radius',
  'extruder_clearance_max_radius',
  'extruder_clearance_height_to_rod',
  'extruder_clearance_height_to_lid',
  'extruder_clearance_dist_to_rod',
  'extruder_height_gap',
  'machine_max_printed_mass',
  'gcode_flavor',
  'extruder_max_nozzle_count',
  'master_extruder_id',
  'physical_extruder_map',
  'parallel_printheads_count',
  'support_parallel_printheads',
])

/**
 * The printer settings of another slicer's 3MF project that go over its own printer's profile: every number, switch
 * and choice of the printer the file holds, listed as changed or not, its identity (model, variant, structure,
 * presets), its extruder colors and its arrange spot, as `sx project-settings` reads them. Its G-code goes through the
 * G-code review instead, and free text, areas and the settings above (`HELD_KEYS`, `HELD_GROUPS`) stay the profile's,
 * so no check reads a looser machine than ours. Its machine limits are held to `profile`'s (`clampMachineLimits`).
 */
export function projectOwnPrinterSettings(settings: Record<string, unknown>, profile: Readonly<Record<string, SettingValue | undefined>>): Record<string, SettingValue> {
  const imported = importFlat(selectVariants(settings)).config as Record<string, SettingValue>
  const out: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(imported)) {
    const def = settingDef(key)
    if (!def || def.section !== 'printer' || HELD_GROUPS.has(def.group) || HELD_KEYS.has(key) || GCODE_TEXT_KEYS.includes(key)) continue
    const identityText = def.group === IDENTITY_GROUP && (def.type === 'string' || def.type === 'strings')
    if (identityText && (IDENTITY_TEXT_HELD.has(key) || !plainName(value))) continue
    const fits = TAKEN_WHEN[key]
    if (!identityText && (fits ? !fits(value) : !PLAIN_TYPES.has(def.type))) continue
    if (value === NIL || (Array.isArray(value) && (value as unknown[]).includes(NIL))) continue
    out[key] = value
  }
  return clampMachineLimits(out, profile)
}

/** The printer's machine limits: the most its axes and extruder may move, accelerate and jerk, in every mode. */
export const isMachineLimit = (key: string): boolean => key.startsWith('machine_max_')

/**
 * `values` with every machine limit (`isMachineLimit`) held to the printer's own (`profile`, the settings of the
 * printer the project opens on), entry by entry, so normal and silent modes and each extruder's entry alike: a project
 * file may lower a limit, never raise it, since the firmware gets these limits and the checks read the machine from
 * them. An entry at or below 0, or not a number, takes the profile's. An entry past the end of the profile's list takes
 * the profile's lowest. A limit the profile has no number for is left out, so the printer's own stands.
 */
export function clampMachineLimits(values: Record<string, SettingValue>, profile: Readonly<Record<string, SettingValue | undefined>>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!isMachineLimit(key)) {
      out[key] = value
      continue
    }
    const own = profile[key]
    const limits = (Array.isArray(own) ? own : own === undefined ? [] : [own]).map(Number)
    if (!limits.length || !limits.every(Number.isFinite)) continue
    const lowest = Math.min(...limits)
    const held = (v: unknown, i: number): number => {
      const limit = i < limits.length ? limits[i]! : lowest
      const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
      return Number.isFinite(n) && n > 0 ? Math.min(n, limit) : limit
    }
    out[key] = Array.isArray(value) ? (value as unknown[]).map(held) : held(value, 0)
  }
  return out
}

/** What a Bambu Studio or Orca project's open puts over the printer's settings, before its G-code (`applyProjectSettings` in the app). */
export interface ProjectPrinterChanges {
  /** The project's settings that apply, in our keys: what goes over the printer's settings. */
  values: Record<string, SettingValue>
  /** Every change the project's settings make against the current settings, before the printer route picks from them. */
  all: Record<string, SettingValue>
  /** With no profile for the file's printer: the settings left out because they were made for another nozzle size. */
  dropped: string[]
  /** The engine choices of ours the project did not change, which stay ours. */
  keeps: string[]
  /** On the project's own printer: whether the file lists what it changed from its presets. */
  listed: boolean
  /** The printer settings of the file in `values` (`projectOwnPrinterSettings`), which stay with the project's printer. */
  printerKeys: string[]
}

/**
 * The settings a Bambu Studio or Orca project's open applies over `current`, the settings of the printer it opens on.
 * With a profile for the file's printer (`match`), that is the file's whole process and filament settings and its
 * printer settings (`projectOwnPrinterSettings`); else the settings that suit the current printer (`nozzle` is its nozzle, undefined without
 * a printer). The project's own G-code is not in `values`: on its own printer it goes through the G-code review.
 * `profile` is the printer's own settings, without the plate's changes (`current` when it has none): every route holds
 * the file's machine limits to it (`clampMachineLimits`), so neither the file nor a limit raised by hand before the
 * open lifts them.
 */
export function projectPrinterChanges(settings: Record<string, unknown>, match: ProjectPrinterMatch | null, current: PrintConfig, nozzle: number | undefined, profile: PrintConfig = current): ProjectPrinterChanges {
  const ceiling = profile as unknown as Record<string, SettingValue | undefined>
  const held = (out: ProjectPrinterChanges): ProjectPrinterChanges => ({ ...out, values: clampMachineLimits(out.values, ceiling) })
  // SlicerX's defaults for the keys the project does not set at all (precise outer wall); a value it sets is its own.
  const { values, taken } = projectSettingChanges({ ...projectDefaults(settings), ...settings }, current)
  const now = current as unknown as Record<string, SettingValue | undefined>
  // The overrides come from every value the project holds (`taken`), also one equal to `current`: the plate then starts
  // from the goal nearest the project's layer height, or moves to another printer, whose own values would otherwise
  // replace it (a 0.2 mm support gap became a Fine goal's 0.12 mm). `values` stays the real changes, for the note.
  if (match?.kind !== 'match') {
    const fileNozzle = match?.nozzle ?? Number(first(settings['nozzle_diameter']))
    const sameNozzle = !Number.isFinite(fileNozzle) || nozzle === undefined || sameMm(fileNozzle, nozzle)
    // The engine choices the project did not change print with SlicerX's values here too, as on its own printer and as
    // sx slice <project.3mf> and the MCP read give them, so the same file slices the same everywhere.
    const keeps = keptEngineChoices(settings)
    const own = Object.fromEntries(Object.entries(taken).filter(([k]) => !GCODE_TEXT_KEYS.includes(k) && !keeps.includes(k)))
    const ours = Object.fromEntries(keeps.filter((k) => !sameChoice(now[k], SLICERX_KEEP_VALUES[k])).map((k) => [k, SLICERX_KEEP_VALUES[k] as SettingValue]))
    const { kept, dropped } = carryOver({ ...own, ...ours }, [], sameNozzle)
    // Left out names only real changes: a value equal to the current one loses nothing.
    return held({ values: kept, all: values, dropped: dropped.filter((k) => k in values), keeps, listed: false, printerKeys: [] })
  }
  // The process and the filaments are taken whole: the file holds what it was sliced with, the system presets its
  // presets came from (inherits_group) with the person's changes on top, and Bambu Studio opens it as it is. Our
  // profile starts from its own standard process and its own filament, so taking only the listed changes left every
  // value of other presets behind (a "0.12mm Fine" project sliced at 0.20 mm; a Generic PLA project at Bambu PLA
  // Basic's flow). The printer's settings are the file's too (projectOwnPrinterSettings, below), as `sx project-settings`
  // reads them. A project made for another nozzle keeps to its list.
  // A few engine choices of ours stay unless the person changed them in the project (SLICERX_KEEPS), or the value it
  // inherited is one the keep leaves alone (arachne walls); the note says so.
  const keeps = new Set(keptEngineChoices(settings))
  const whole = (k: string) => {
    const section = settingDef(k)?.section
    return k === PLATE_TYPE_KEY || (!match.asked && (section === 'process' || section === 'filament') && !keeps.has(k))
  }
  const only = changedKeys(settings)
  // A file that does not list its changes counts every key as its own.
  const applied = Object.fromEntries(Object.entries(taken).filter(([k]) => !only || only.has(k) || whole(k)))
  // One of the person's printers keeps its own G-code, as on any switch to it; the project printer's goes through the review.
  const settingsOnly = Object.fromEntries(Object.entries(applied).filter(([k]) => !GCODE_TEXT_KEYS.includes(k)))
  // The file's printer settings, listed or not, on the printer it was made for; a project for another nozzle keeps to
  // what the file lists, as before.
  const printer = match.asked ? {} : projectOwnPrinterSettings(settings, ceiling)
  return held({ values: { ...printer, ...settingsOnly }, all: values, dropped: [], keeps: [...keeps], listed: only !== undefined, printerKeys: Object.keys(printer) })
}
