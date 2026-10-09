// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio or Orca project opens as its own printer, the way Bambu Studio opens one (PresetBundle::
// load_config_model): the file's printer and nozzle, matched to our profiles, become a printer of their own that
// exports G-code and slices with the project's machine G-code. Switching to one of the person's printers takes that
// printer's G-code wholesale and keeps the settings that suit it, so no project G-code reaches another machine.
import type { PrinterInfo, SettingValue } from '@slicerx/contracts'
import { GCODE_TEXT_KEYS, LEGACY_KEYS, importFlat, listPrinterProfiles, machineEntry, printerProfile, reviewProjectGcode, settingDef } from '@slicerx/settings'
import { resolveConfig } from '../adapters/config'
import { projectSettingChanges } from '../export/project-settings'
import { slotConfig } from '../filament/slots'
import { profileReady } from '../state/profile-sync'
import { isExportOnly } from '../lib/hand-printers'
import { gcodeValues } from '../state/project-gcode'
import { appStore, get, set, setWorkspace, toast, type AppState, type ProjectPrinter, type ToastAction } from '../state/store'
import { profileIdFor } from '../workspaces/prepare/printer-base'

export const PROJECT_PRINTER_ID = 'project-printer'

export type ProjectPrinterMatch =
  | { kind: 'match'; profileId: string; vendor: string; model: string; nozzle: number; name: string; asked?: number; own?: { id: string; name: string } }
  | { kind: 'unknown'; name: string; nozzle?: number }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const first = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)
const sameMm = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6
const mm = (n: number): string => `${Number(n.toFixed(2))} mm`
const labels = (keys: readonly string[]): string => keys.map((k) => (settingDef(k)?.label ?? k).toLowerCase()).join(', ')

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

/**
 * The keys a project lists as changed from its system presets (`different_settings_to_system`: the process, then each
 * filament, then the printer), in our key names. Undefined when the file does not say, so every key counts.
 */
export function changedKeys(settings: Record<string, unknown>): Set<string> | undefined {
  const v = settings['different_settings_to_system']
  if (!Array.isArray(v)) return undefined
  const out = new Set<string>()
  for (const entry of v) {
    if (typeof entry !== 'string') continue
    for (const k of entry.split(';').map((x) => x.trim()).filter(Boolean)) out.add(LEGACY_KEYS[k] ?? k)
  }
  return out
}

/**
 * Engine choices of SlicerX that stay when a project opens, unless the person changed them in the project (its
 * different_settings_to_system lists the key): every other value the project inherited from its presets comes from the
 * file. Each says, in the open's note, what it kept when the project's inherited value differs.
 */
export const SLICERX_KEEPS: Readonly<Record<string, string>> = {
  // aegis: wall widths fitted to the part, so thin features print solid with fewer width changes than Arachne or
  // Bambu Studio's classic walls (adapters/config.ts SLICERX_PRESET_DEFAULTS sets it over every maker preset).
  wall_generator: "Kept SlicerX's aegis walls; the project used Bambu's default.",
  // The outer wall spaced from the inner walls so that the outline, not the wall's center, lands on the model's size.
  precise_outer_wall: "Kept SlicerX's precise outer wall; the project used Bambu's default.",
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

/** The note's button: the printer list, to pick another. */
export const CHANGE_PRINTER: ToastAction = {
  label: 'Change printer',
  run: () => {
    setWorkspace('prepare')
    set({ printerChooserOpen: true })
  },
}

/**
 * The first step of opening a project on an empty plate, before its objects are placed on a bed: when we have a
 * profile for its printer, the plate switches to one of the person's `printers` of that model and nozzle (one that
 * takes jobs first), else to the project's own printer. Returns the match for applyProjectSettings.
 */
export async function switchToProjectPrinter(source: string, settings: Record<string, unknown>, printers: readonly PrinterInfo[] = []): Promise<ProjectPrinterMatch | null> {
  const found = matchProjectPrinter(settings)
  if (found?.kind !== 'match') {
    await profileReady()
    return found
  }
  const s0 = get()
  const fits = printers.filter((p) => p.id !== PROJECT_PRINTER_ID && profileIdFor(p) === found.profileId && sameMm(nozzleOf(s0, p) ?? -1, found.nozzle))
  const own = fits.find((p) => !isExportOnly(p)) ?? fits[0]
  if (own) {
    set({ printerId: own.id, printerModel: { id: own.id, vendor: own.vendor, model: own.model } })
    await profileReady()
    return { ...found, own: { id: own.id, name: own.name } }
  }
  const previousPrinterId = s0.printerId === PROJECT_PRINTER_ID ? (s0.projectPrinter?.previousPrinterId ?? null) : s0.printerId
  const printer: ProjectPrinter = { id: PROJECT_PRINTER_ID, name: `${found.model} ${found.nozzle}`, vendor: found.vendor, model: found.model, profileId: found.profileId, nozzle: found.nozzle, source, previousPrinterId, gcodeKeys: [], parked: null }
  set((s) => ({ projectPrinter: printer, printerId: PROJECT_PRINTER_ID, printerModel: { id: PROJECT_PRINTER_ID, vendor: found.vendor, model: found.model }, printerNozzles: { ...s.printerNozzles, [PROJECT_PRINTER_ID]: found.nozzle } }))
  await profileReady()
  return found
}

/**
 * The second step: the project's settings on top of the printer's profile. On its own printer that is the file's whole
 * process, what it changed from its filament and printer presets, and its machine G-code. On the current printer (no profile
 * for the file's) it is the settings that suit it, and no G-code. Returns the keys applied and the note to show.
 */
export function applyProjectSettings(source: string, settings: Record<string, unknown>, match: ProjectPrinterMatch | null): { keys: string[]; note: string } {
  const s = get()
  const { values } = projectSettingChanges(settings, resolveConfig(s.easy, s.overrides))
  if (match?.kind !== 'match') {
    const fileNozzle = match?.nozzle ?? Number(first(settings['nozzle_diameter']))
    const sameNozzle = !Number.isFinite(fileNozzle) || !s.profile || sameMm(fileNozzle, s.profile.nozzle)
    const { kept, dropped } = carryOver(Object.fromEntries(Object.entries(values).filter(([k]) => !GCODE_TEXT_KEYS.includes(k))), [], sameNozzle)
    set((st) => ({ overrides: { ...st.overrides, ...kept }, ...(Object.keys(kept).length ? { goal: 'custom' as const } : {}) }))
    const here = s.printerModel ? `the ${s.printerModel.model}` : 'the generic bed'
    const left = dropped.length ? ` Left out, made for a ${mm(fileNozzle)} nozzle: ${labels(dropped)}.` : ''
    const note = match ? `${source} is for a ${match.name}, which SlicerX has no profile for, so it opened on ${here}.${left}` : `Applied ${Object.keys(kept).length} settings from ${source}.${left}`
    return { keys: Object.keys(kept), note }
  }
  const only = changedKeys(settings)
  // The process and the filaments are taken whole: the file holds what it was sliced with, the system presets its
  // presets came from (inherits_group) with the person's changes on top, and Bambu Studio opens it as it is. Our
  // profile starts from its own standard process and its own filament, so taking only the listed changes left every
  // value of other presets behind (a "0.12mm Fine" project sliced at 0.20 mm; a Generic PLA project at Bambu PLA
  // Basic's flow). The printer keeps to what the file lists, since its profile is that printer's system preset. A
  // project made for another nozzle keeps to its list too.
  // A few engine choices of ours stay unless the person changed them in the project (SLICERX_KEEPS); the note says so.
  const whole = (k: string) => {
    const section = settingDef(k)?.section
    return !match.asked && (section === 'process' || section === 'filament') && !(k in SLICERX_KEEPS)
  }
  const applied = only ? Object.fromEntries(Object.entries(values).filter(([k]) => only.has(k) || whole(k))) : values
  const keptNote = only && !match.asked ? Object.keys(values).filter((k) => k in SLICERX_KEEPS && !only.has(k)).map((k) => SLICERX_KEEPS[k]!).join(' ') : ''
  if (match.own) {
    // One of the person's printers: its own G-code, as on any switch to it.
    const kept = Object.fromEntries(Object.entries(applied).filter(([k]) => !GCODE_TEXT_KEYS.includes(k)))
    set((st) => ({ overrides: { ...st.overrides, ...kept }, goal: 'custom' as const }))
    return { keys: Object.keys(kept), note: `Opened on ${match.own.name}, a ${match.model} ${mm(match.nozzle)} like the project's.${keptNote ? ` ${keptNote}` : ''}` }
  }
  // Its machine G-code, on its own printer. Text with lines the checker never allows stays the profile's.
  const project = importFlat(Object.fromEntries(Object.entries(settings).filter(([k]) => GCODE_TEXT_KEYS.includes(k)))).config as Record<string, unknown>
  const review = reviewProjectGcode({ project, profile: { ...resolveConfig(s.easy, s.overrides), ...slotConfig(s) }, model: s.profile?.printerId, limits: s.profile?.limits })
  const gcode = gcodeValues(review.changes.filter((c) => c.approvable))
  const blocked = review.changes.filter((c) => !c.approvable)
  set((st) => ({
    overrides: { ...st.overrides, ...applied, ...gcode },
    vouchedGcode: { ...st.vouchedGcode, ...gcode },
    projectGcode: null,
    projectPrinter: st.projectPrinter ? { ...st.projectPrinter, gcodeKeys: Object.keys(gcode) } : null,
    goal: 'custom' as const,
  }))
  let note = match.asked
    ? `Opened as ${match.model} with its ${mm(match.nozzle)} nozzle. The project is set up for a ${mm(match.asked)} nozzle, which SlicerX has no ${match.model} profile for.`
    : `Opened as ${match.model} ${mm(match.nozzle)} from the project.`
  if (blocked.length) note += ` Its ${blocked.map((c) => c.label).join(', ')} has lines SlicerX never sends, so the ${match.model} profile's is used.`
  if (keptNote) note += ` ${keptNote}`
  return { keys: [...Object.keys(applied), ...Object.keys(gcode)], note }
}

/** The nozzle a printer slices with: what it reports, else what was chosen for it, else its model's default. */
function nozzleOf(s: AppState, model: { id?: string; vendor: string; model: string }): number | undefined {
  const own = model.id ? (s.nozzleReported[model.id] ?? s.printerNozzles[model.id]) : undefined
  if (own) return own
  const pid = profileIdFor(model)
  return pid ? printerProfile(pid)?.defaultNozzle : undefined
}

/**
 * The plate moves off the project printer onto `to` (another printer, or none): the project's machine G-code and the
 * settings made for its nozzle stay with the project printer, and a note says what did not come along.
 */
export function leaveProjectPrinter(to: AppState['printerModel']): void {
  const s = get()
  const pp = s.projectPrinter
  if (!pp || pp.parked) return
  const toNozzle = to ? nozzleOf(s, to) : undefined
  const { kept, parked, dropped } = carryOver(s.overrides, pp.gcodeKeys, toNozzle !== undefined && sameMm(toNozzle, pp.nozzle))
  const vouched = Object.fromEntries(Object.entries(s.vouchedGcode).filter(([k]) => !pp.gcodeKeys.includes(k)))
  set({ overrides: kept, vouchedGcode: vouched, projectPrinter: { ...pp, parked } })
  if (!to) return
  const reported = to.id ? s.nozzleReported[to.id] : undefined
  let note = `Slicing for the ${to.model} with its own G-code.`
  if (dropped.length) note += ` Not carried over, made for the project's ${mm(pp.nozzle)} nozzle: ${labels(dropped)}.`
  if (reported !== undefined && !sameMm(reported, pp.nozzle)) note += ` Your ${to.model} reports a ${mm(reported)} nozzle; the project is set up for ${mm(pp.nozzle)}.`
  toast(note, dropped.length || (reported !== undefined && !sameMm(reported, pp.nozzle)) ? 'warn' : 'info')
}

/** The plate is back on the project printer: what stayed with it returns. */
export function returnToProjectPrinter(): void {
  const pp = get().projectPrinter
  if (!pp?.parked) return
  const parked = pp.parked
  const gcode = Object.fromEntries(Object.entries(parked).filter(([k]) => pp.gcodeKeys.includes(k)))
  set((s) => ({ overrides: { ...s.overrides, ...parked }, vouchedGcode: { ...s.vouchedGcode, ...gcode }, projectPrinter: { ...pp, parked: null } }))
}

let started = false

/** Follows the printer the plate slices for, off the project printer and back. */
export function startProjectPrinterSync(): void {
  if (started) return
  started = true
  appStore.subscribe((s, prev) => {
    if (s.printerModel === prev.printerModel) return
    const was = prev.printerModel?.id === PROJECT_PRINTER_ID
    const is = s.printerModel?.id === PROJECT_PRINTER_ID
    if (was && !is) leaveProjectPrinter(s.printerModel)
    else if (is && !was) returnToProjectPrinter()
  })
}
