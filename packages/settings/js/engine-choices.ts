// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened project's settings come from the file, except a few engine choices of SlicerX, which stay ours unless the
// person changed them in the project. The app's project open and the MCP server's project_settings both use this, so a
// project slices the same either way.
import { productName } from '@slicerx/contracts/brand'
import engineChoicesJson from '../engine-choices.json'
import { LEGACY_KEYS } from './import'

export { appMissingKeys } from './app-defaults'

// The list lives in engine-choices.json, so sx-core (sx slice <project.3mf>) keeps the same ones:
// aegis walls (wall widths fitted to the part, so thin features print solid with fewer width changes than Arachne or
// Bambu Studio's classic walls) and the outer wall spaced from the inner ones so the outline lands on the model's size.
const ENGINE_CHOICES = engineChoicesJson as {
  keeps: Record<string, { value: string | boolean | number; over?: (string | boolean | number)[]; exceptPrinters?: string[]; note: string }>
  defaults?: Record<string, { value: string | boolean | number }>
}

/**
 * Engine choices of SlicerX that stay when a project opens, unless the person changed them in the project (its
 * different_settings_to_system lists the key): every other value the project inherited from its presets comes from the
 * file. Each says, in the open's note, what it kept when the project's inherited value differs.
 */
// The notes name the product as the edition does (white label): engine-choices.json says SlicerX, read when asked.
export const SLICERX_KEEPS: Readonly<Record<string, string>> = Object.defineProperties(
  {},
  Object.fromEntries(Object.entries(ENGINE_CHOICES.keeps).map(([k, v]) => [k, { enumerable: true, get: () => v.note.replaceAll('SlicerX', productName()) }])),
)

/** The value SlicerX prints each kept engine choice with. */
export const SLICERX_KEEP_VALUES: Readonly<Record<string, string | boolean | number>> = Object.fromEntries(Object.entries(ENGINE_CHOICES.keeps).map(([k, v]) => [k, v.value]))

/**
 * SlicerX's values for keys a project does not set at all (engine-choices.json `defaults`): a value the project sets is
 * its own, whether or not it lists the key as changed.
 */
export const SLICERX_DEFAULTS: Readonly<Record<string, string | boolean | number>> = Object.fromEntries(Object.entries(ENGINE_CHOICES.defaults ?? {}).map(([k, v]) => [k, v.value]))

/**
 * Whether SlicerX's kept choice for `key` goes over `inherited`, the value a project took from its presets: a keep that
 * names the values it goes over (engine-choices.json `over`, for walls only Bambu's classic) leaves any other value as
 * the project has it, so a project's inherited arachne walls stay arachne. A project that does not set the key gets the
 * keep.
 */
export function keepsOver(key: string, inherited: unknown): boolean {
  const keep = ENGINE_CHOICES.keeps[key]
  if (!keep) return false
  if (!keep.over || inherited === undefined) return true
  return keep.over.some((v) => sameChoice(inherited, v))
}

/**
 * Whether SlicerX's kept choice for `key` leaves a project alone because of its printer: the project's `printer_model`
 * starts with one of the keep's `exceptPrinters` (for walls "Bambu Lab", so a stock Bambu Lab project keeps the classic
 * walls it inherited).
 */
export function keepLeavesPrinter(key: string, settings: Record<string, unknown>): boolean {
  const model = oneText(settings['printer_model'])
  return model !== undefined && (ENGINE_CHOICES.keeps[key]?.exceptPrinters ?? []).some((p) => model.startsWith(p))
}

/** SlicerX's defaults for the keys a project's settings leave out (none when the project sets them all). */
export function projectDefaults(settings: Record<string, unknown>): Record<string, string | boolean | number> {
  return Object.fromEntries(Object.entries(SLICERX_DEFAULTS).filter(([k]) => settings[k] === undefined))
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
 * The engine choices a project leaves to SlicerX: those its file does not list as changed, whose inherited value the
 * keep goes over (`keepsOver`), on a printer the keep does not leave alone (`keepLeavesPrinter`). None when it does
 * not say.
 */
export function keptEngineChoices(settings: Record<string, unknown>): string[] {
  const changed = changedKeys(settings)
  return changed ? Object.keys(SLICERX_KEEPS).filter((k) => !changed.has(k) && keepsOver(k, settings[k]) && !keepLeavesPrinter(k, settings)) : []
}

/**
 * Which wall generator a project slices with, where that comes from, and the sentence that says so: `kept` (SlicerX's
 * choice over the one the project inherited), `project` (the project's own, listed as changed), `request` (a call's
 * overrides) or `profile` (the printer profile).
 */
export interface WallsNote {
  generator: string
  source: 'kept' | 'project' | 'request' | 'profile'
  text: string
}

/** A setting value as one string: `"classic"`, `["classic"]`. */
const oneText = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)

/**
 * The walls a project's settings give, by the rule above: SlicerX's where the project inherited a generator the keep goes
 * over (classic) on a printer it does not leave alone (not a Bambu Lab printer), else the project's own. `source` is the app that wrote the file (`BambuStudio-…`, `OrcaSlicer-…`), when known. Undefined
 * when the project names none and says nothing about what it changed.
 */
export function projectWalls(raw: Record<string, unknown>, source?: string): WallsNote | undefined {
  const own = oneText(raw['wall_generator'])
  const ours = String(SLICERX_KEEP_VALUES['wall_generator'] ?? 'aegis')
  const changed = changedKeys(raw)
  if (changed && !changed.has('wall_generator') && keepsOver('wall_generator', raw['wall_generator']) && !keepLeavesPrinter('wall_generator', raw)) {
    const maker = source?.startsWith('OrcaSlicer') ? "OrcaSlicer's" : source?.startsWith('BambuStudio') ? "Bambu's" : "its preset's"
    const text = own === undefined ? `${ours} walls, kept by ${productName()}; the project names none` : own === ours ? `${ours} walls, as the project has them` : `${ours} walls, kept by ${productName()}; the project used ${maker} default ${own}`
    return { generator: ours, source: 'kept', text }
  }
  if (own === undefined) return undefined
  // Inherited walls the keep does not go over (arachne, or a Bambu Lab printer's classic) are the project's as its
  // presets had them.
  return { generator: own, source: 'project', text: changed && !changed.has('wall_generator') ? `${own} walls, as the project has them` : `${own} walls, the project's own choice` }
}

/** The same setting value written either way: `true` and `"1"`, `"aegis"` and `["aegis"]`. */
export function sameChoice(a: unknown, b: unknown): boolean {
  const t = (v: unknown): string | undefined => {
    const x = Array.isArray(v) && v.length === 1 ? v[0] : v
    if (typeof x === 'boolean') return x ? '1' : '0'
    if (x === 'true') return '1'
    if (x === 'false') return '0'
    return typeof x === 'string' || typeof x === 'number' ? String(x) : undefined
  }
  return t(a) !== undefined && t(a) === t(b)
}
