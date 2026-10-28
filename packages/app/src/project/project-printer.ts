// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio or Orca project opens as its own printer, the way Bambu Studio opens one (PresetBundle::
// load_config_model): the file's printer and nozzle, matched to our profiles, become a printer of their own that
// exports G-code and slices with the project's machine G-code. Switching to one of the person's printers takes that
// printer's G-code wholesale and keeps the settings that suit it, so no project G-code reaches another machine.
import type { PrinterInfo, SettingValue } from '@slicerx/contracts'
import { GCODE_TEXT_KEYS, SLICERX_KEEPS, carryOver, importFlat, matchProjectPrinter, printerProfile, projectPrinterChanges, reviewProjectGcode, settingDef, type ProjectPrinterMatch } from '@slicerx/settings'
import { resolveConfig } from '../adapters/config'
import { appName } from '../edition'
import { slotConfig } from '../filament/slot-config'
import { profileReady } from '../state/profile-sync'
import { isExportOnly } from '../lib/hand-printers'
import { gcodeValues } from '../state/project-gcode'
import { recognizedScript } from './script-review'
import { appStore, get, set, setWorkspace, toast, type AppState, type ProjectPrinter, type ToastAction } from '../state/store'
import { profileIdFor } from '../workspaces/prepare/printer-base'

export const PROJECT_PRINTER_ID = 'project-printer'

// The printer a project was made for, matched to our profiles, and how settings carry over to another printer, are
// shared with the MCP server's project slices.
export { carryOver, matchProjectPrinter, nozzleBound, type ProjectPrinterMatch } from '@slicerx/settings'

const first = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)
const sameMm = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6
const mm = (n: number): string => `${Number(n.toFixed(2))} mm`
const labels = (keys: readonly string[]): string => keys.map((k) => (settingDef(k)?.label ?? k).toLowerCase()).join(', ')

// The engine choices kept on open and the project's list of changed keys live in @slicerx/settings, shared with the
// MCP server's project_settings.
export { SLICERX_KEEPS, changedKeys } from '@slicerx/settings'

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
  const current = resolveConfig(s.easy, s.overrides)
  const changes = projectPrinterChanges(settings, match, current, s.profile?.nozzle)
  const { all, dropped } = changes
  if (match?.kind !== 'match') {
    const fileNozzle = match?.nozzle ?? Number(first(settings['nozzle_diameter']))
    const { keeps, values: kept } = changes
    set((st) => ({ overrides: { ...st.overrides, ...kept }, ...(Object.keys(kept).length ? { goal: 'custom' as const } : {}) }))
    const here = s.printerModel ? `the ${s.printerModel.model}` : 'the generic bed'
    const left = dropped.length ? ` Left out, made for a ${mm(fileNozzle)} nozzle: ${labels(dropped)}.` : ''
    const keptNote = keeps.filter((k) => k in all).map((k) => ` ${SLICERX_KEEPS[k]!}`).join('')
    const note = match ? `${source} is for a ${match.name}, which ${appName()} has no profile for, so it opened on ${here}.${left}${keptNote}` : `Applied ${Object.keys(kept).length} settings from ${source}.${left}${keptNote}`
    return { keys: Object.keys(kept), note }
  }
  const keeps = new Set(changes.keeps)
  const applied = changes.values
  const keptNote = changes.listed && !match.asked ? Object.keys(all).filter((k) => keeps.has(k)).map((k) => SLICERX_KEEPS[k]!).join(' ') : ''
  if (match.own) {
    // One of the person's printers: its own G-code, as on any switch to it.
    const kept = Object.fromEntries(Object.entries(applied).filter(([k]) => !GCODE_TEXT_KEYS.includes(k)))
    set((st) => ({ overrides: { ...st.overrides, ...kept }, goal: 'custom' as const }))
    return { keys: Object.keys(kept), note: `Opened on ${match.own.name}, a ${match.model} ${mm(match.nozzle)} like the project's.${keptNote ? ` ${keptNote}` : ''}` }
  }
  // Its machine G-code, on its own printer. Text with lines the checker never allows stays the profile's.
  const project = importFlat(Object.fromEntries(Object.entries(settings).filter(([k]) => GCODE_TEXT_KEYS.includes(k)))).config as Record<string, unknown>
  const review = reviewProjectGcode({ project, profile: { ...resolveConfig(s.easy, s.overrides), ...slotConfig(s) }, model: s.profile?.printerId, limits: s.profile?.limits })
  const recognized = new Set(Object.entries(project).filter(([key, value]) => recognizedScript(key, value, s.profile?.printerId, { ...s.overrides, ...applied }, s.projectScriptReviews?.records ?? [])).map(([key]) => key))
  const gcode = gcodeValues(review.changes.filter((c) => c.approvable || recognized.has(c.key)))
  const vouched = gcodeValues(review.changes.filter((c) => c.approvable && !recognized.has(c.key)))
  const blocked = review.changes.filter((c) => !c.approvable && !recognized.has(c.key))
  set((st) => ({
    overrides: { ...st.overrides, ...applied, ...gcode },
    vouchedGcode: { ...st.vouchedGcode, ...vouched },
    projectGcode: null,
    projectPrinter: st.projectPrinter ? { ...st.projectPrinter, gcodeKeys: Object.keys(gcode), recognizedGcodeKeys: [...recognized] } : null,
    goal: 'custom' as const,
  }))
  let note = match.asked
    ? `Opened as ${match.model} with its ${mm(match.nozzle)} nozzle. The project is set up for a ${mm(match.asked)} nozzle, which ${appName()} has no ${match.model} profile for.`
    : `Opened as ${match.model} ${mm(match.nozzle)} from the project.`
  if (blocked.length) note += ` Its ${blocked.map((c) => c.label).join(', ')} has lines ${appName()} never sends, so the ${match.model} profile's is used.`
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
  const gcode = Object.fromEntries(Object.entries(parked).filter(([k]) => pp.gcodeKeys.includes(k) && !pp.recognizedGcodeKeys?.includes(k)))
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
