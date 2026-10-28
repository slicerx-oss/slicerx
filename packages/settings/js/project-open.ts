// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What opening a 3MF project puts over the printer's settings, as the app opens one: a PrusaSlicer project's print and
// filament values on the current printer, and a Bambu Studio or Orca project's settings on its own printer or the
// current one. The app's project open and the MCP server's project slices call these, so one project on one printer
// slices the same in both.
import type { PrintConfig, SettingValue } from '@slicerx/contracts/settings'
import { changedKeys, keptEngineChoices, projectDefaults, sameChoice, SLICERX_KEEP_VALUES } from './engine-choices'
import { GCODE_TEXT_KEYS } from './gcode-review'
import { importFlat } from './import'
import { machineEntry, listPrinterProfiles } from './profiles'
import { isProjectUnread, takesProjectValue } from './prusa'
import { sameValue } from './diff'
import { settingDef } from './schema'
import { selectVariants } from './variants'

export interface ProjectSettings {
  /** Changes against the current settings, in our keys. */
  values: Record<string, SettingValue>
  /** Keys left out on purpose: text, scripts, credentials, printer settings. */
  left: string[]
}

// Bambu Studio prints a project's own values for wall_filament, sparse_infill_filament and solid_infill_filament on
// nothing ("1", the stock value, and every other alike), so the rule leaves a project's out (`unread`); an object's, a
// part's or a modifier's own still count (`modifierSettings`).
export function projectSettingChanges(raw: Record<string, unknown>, current: PrintConfig): ProjectSettings {
  const read = Object.fromEntries(Object.entries(raw).filter(([k]) => !isProjectUnread(k)))
  const imported = importFlat(selectVariants(read)).config as Record<string, SettingValue>
  const now = current as unknown as Record<string, SettingValue | undefined>
  const values: Record<string, SettingValue> = {}
  const left: string[] = []
  for (const [key, value] of Object.entries(imported)) {
    if (!takesProjectValue(key, value)) {
      left.push(key)
      continue
    }
    if (!sameValue(value, now[key])) values[key] = value
  }
  return { values, left }
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
  const p = key ? profiles.find((x) => norm(`${x.vendor} ${x.model}`) === key || norm(x.model) === key) : undefined
  if (!p) return { kind: 'unknown', name: label, ...(want ? { nozzle: want } : {}) }
  if (want === undefined || p.nozzles.some((x) => sameMm(x, want))) return hit(p, want ?? p.defaultNozzle)
  return { ...hit(p, p.defaultNozzle), asked: want } as ProjectPrinterMatch
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
}

/**
 * The settings a Bambu Studio or Orca project's open applies over `current`, the settings of the printer it opens on.
 * With a profile for the file's printer (`match`), that is the file's whole process and filament settings and what it
 * changed of the printer's; else the settings that suit the current printer (`nozzle` is its nozzle, undefined without
 * a printer). The project's own G-code is not in `values`: on its own printer it goes through the G-code review.
 */
export function projectPrinterChanges(settings: Record<string, unknown>, match: ProjectPrinterMatch | null, current: PrintConfig, nozzle: number | undefined): ProjectPrinterChanges {
  // SlicerX's defaults for the keys the project does not set at all (precise outer wall); a value it sets is its own.
  const { values } = projectSettingChanges({ ...projectDefaults(settings), ...settings }, current)
  const now = current as unknown as Record<string, SettingValue | undefined>
  if (match?.kind !== 'match') {
    const fileNozzle = match?.nozzle ?? Number(first(settings['nozzle_diameter']))
    const sameNozzle = !Number.isFinite(fileNozzle) || nozzle === undefined || sameMm(fileNozzle, nozzle)
    // The engine choices the project did not change print with SlicerX's values here too, as on its own printer and as
    // sx slice <project.3mf> and the MCP read give them, so the same file slices the same everywhere.
    const keeps = keptEngineChoices(settings)
    const own = Object.fromEntries(Object.entries(values).filter(([k]) => !GCODE_TEXT_KEYS.includes(k) && !keeps.includes(k)))
    const ours = Object.fromEntries(keeps.filter((k) => !sameChoice(now[k], SLICERX_KEEP_VALUES[k])).map((k) => [k, SLICERX_KEEP_VALUES[k] as SettingValue]))
    const { kept, dropped } = carryOver({ ...own, ...ours }, [], sameNozzle)
    return { values: kept, all: values, dropped, keeps, listed: false }
  }
  const only = changedKeys(settings)
  // The process and the filaments are taken whole: the file holds what it was sliced with, the system presets its
  // presets came from (inherits_group) with the person's changes on top, and Bambu Studio opens it as it is. Our
  // profile starts from its own standard process and its own filament, so taking only the listed changes left every
  // value of other presets behind (a "0.12mm Fine" project sliced at 0.20 mm; a Generic PLA project at Bambu PLA
  // Basic's flow). The printer keeps to what the file lists, since its profile is that printer's system preset. A
  // project made for another nozzle keeps to its list too.
  // A few engine choices of ours stay unless the person changed them in the project (SLICERX_KEEPS), or the value it
  // inherited is one the keep leaves alone (arachne walls); the note says so.
  const keeps = new Set(keptEngineChoices(settings))
  const whole = (k: string) => {
    const section = settingDef(k)?.section
    return !match.asked && (section === 'process' || section === 'filament') && !keeps.has(k)
  }
  const applied = only ? Object.fromEntries(Object.entries(values).filter(([k]) => only.has(k) || whole(k))) : values
  // One of the person's printers keeps its own G-code, as on any switch to it; the project printer's goes through the review.
  const settingsOnly = Object.fromEntries(Object.entries(applied).filter(([k]) => !GCODE_TEXT_KEYS.includes(k)))
  return { values: settingsOnly, all: values, dropped: [], keeps: [...keeps], listed: only !== undefined }
}
