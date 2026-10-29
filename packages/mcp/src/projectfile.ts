// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a 3MF or .sx3mf project without its geometry: the plates, the presets it was set up with, its filament
// slots and its print settings, so a file can be sliced the way it was saved.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { SettingValue } from '@slicerx/contracts'
import { appMissingKeys, importProject, keptEngineChoices, LEGACY_GROUPS, LEGACY_KEYS, parseXml, projectDefaults, projectWalls, ProjectVariantError, prusaProjectConfig, prusaProjectSettings, readPrusaConfig, selectVariants, SLICERX_KEEP_VALUES, withBambuMissingKeys, type WallsNote } from '@slicerx/settings'
import { productName } from '@slicerx/contracts'
import { ToolInputError } from './models'
import { readZip } from './zip'

export interface ProjectPlate {
  /** 1-based, the number slicing takes as `plate`. */
  index: number
  name?: string
  objects: number
  /** The plate's own print sequence, when the project sets one for it (it wins over the project's). */
  print_sequence?: 'by layer' | 'by object'
}

export interface ProjectSummary {
  file: string
  /** True when the file carries print settings (a Bambu Studio, OrcaSlicer, PrusaSlicer or SlicerX project); false for a plain 3MF. */
  has_settings: boolean
  plates: ProjectPlate[]
  presets: { printer?: string; process?: string; filaments: string[] }
  filaments: { slot: number; type?: string; color?: string; preset?: string }[]
  /** Keys the file set that SlicerX does not know or could not read; the rest are applied. */
  unknown_keys: string[]
  /** Keys a file may never set (scripts and secrets), left out. */
  dropped_keys: string[]
  /**
   * The support settings the project sets (`enable_support`, `enforce_support_layers`, `support_*` and
   * `tree_support_*`), in the shapes slicing takes them; empty when it sets none. Values are the file's own, so
   * `support_filament` is the slot it names even when the print has fewer filaments.
   */
  support: Record<string, SettingValue>
  /** What the file's print settings carry that slicing will not use, by kind (see `ImportReport`). */
  import_report: ImportReport
}

/** A key of the project's support settings, as `ProjectSummary.support` lists them. */
export function isSupportKey(key: string): boolean {
  return key === 'enable_support' || key === 'enforce_support_layers' || key.startsWith('support_') || key.startsWith('tree_support_')
}

/**
 * The print settings a project carries that slicing will not use, by kind. Every key is listed; the text output
 * names the first few of each kind and counts the rest.
 */
export interface ImportReport {
  /** The app that wrote the file (the model's `Application` entry), when it says. */
  source?: string
  /** Keys SlicerX does not know, with the file's values. */
  unknown: { key: string; value: unknown }[]
  /** Keys the slicers retired, left out. */
  retired: string[]
  /** Keys only another slicer reads (a fork's own), left out. */
  other_slicer: string[]
  /** Old names read as their current ones. */
  renamed: { from: string; to: string }[]
  /** Values that could not be read, with the file's values; those settings keep the preset's. */
  invalid: { key: string; value: unknown }[]
  /** Which wall generator the project slices with and why, when it names one or SlicerX keeps its own. */
  walls?: WallsNote
  /**
   * Why the file's `Metadata/project_settings.config` was left out, when it is not a JSON object of settings (INI style
   * lines, a damaged file). The project then opens and slices as one without settings.
   */
  skipped?: string
}

export type { WallsNote } from '@slicerx/settings'

/** A setting value as one string: `"classic"`, `["classic"]`. */
const oneText = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)

/**
 * The walls a slice ran with: `generator` is the resolved config's; the request's overrides win, then the project's
 * note when it is what ran, else the printer profile (or the engine's default when nothing names one).
 */
export function sliceWalls(generator: unknown, overrides: Record<string, unknown> | undefined, project: WallsNote | undefined): WallsNote {
  const g = oneText(generator)
  if (g !== undefined && overrides && 'wall_generator' in overrides) return { generator: g, source: 'request', text: `${g} walls, set by the request's overrides` }
  if (project && (g === undefined || g === project.generator)) return project
  if (g === undefined) return { generator: 'classic', source: 'profile', text: "classic walls, the engine's default (nothing names a wall generator)" }
  return { generator: g, source: 'profile', text: `${g} walls, from the printer profile` }
}

/** How many keys of each kind a text line names before it counts the rest. */
const REPORT_NAMES = 8

/** One line per kind of `report` that has keys, the first few named and the rest counted. */
export function importReportLines(report: ImportReport, withWalls = true): string[] {
  const named = (keys: string[]): string => keys.slice(0, REPORT_NAMES).join(', ') + (keys.length > REPORT_NAMES ? ` and ${keys.length - REPORT_NAMES} more` : '')
  const out: string[] = []
  if (report.skipped) out.push(report.skipped)
  if (report.invalid.length) out.push(`${report.invalid.length} with a value ${productName()} cannot read, kept from the preset: ${named(report.invalid.map((i) => i.key))}`)
  if (report.unknown.length) out.push(`${report.unknown.length} ${productName()} does not know, not used: ${named(report.unknown.map((u) => u.key))}`)
  if (report.other_slicer.length) out.push(`${report.other_slicer.length} only another slicer reads, not used: ${named(report.other_slicer)}`)
  if (report.retired.length) out.push(`${report.retired.length} retired, not used: ${named(report.retired)}`)
  if (report.renamed.length) out.push(`${report.renamed.length} read under a newer name: ${named(report.renamed.map((r) => `${r.from} as ${r.to}`))}`)
  if (withWalls && report.walls) out.push(`Walls: ${report.walls.text}`)
  return out
}

/** The app that wrote a 3MF, from its model's `Application` metadata. */
function sourceApp(model: string | undefined): string | undefined {
  const m = model?.match(/<metadata\s+name="Application"\s*>([^<]*)<\/metadata>/)
  return m?.[1]?.trim() || undefined
}

export interface ProjectRead {
  summary: ProjectSummary
  /** The project's print settings in schema shapes, ready to use as the first settings layer. */
  config: Record<string, SettingValue>
  /**
   * Another slicer's project (a 3MF, not an .sx3mf) with print settings: its settings as the app's project open reads
   * them (`orca` for a Bambu Studio or Orca project, `prusaslicer` for a PrusaSlicer one), for a slice on a printer the
   * way the app opens it (project-open.ts). `slots` is the last filament slot its parts print with, `used` every slot they
   * print with.
   */
  opened?: { from: 'orca' | 'prusaslicer'; settings: Record<string, unknown>; slots: number; used: number[] }
}

/**
 * The filament slots a project's objects and model parts print with (their `extruder`, a part's own else its
 * object's), in Metadata/model_settings.config or Metadata/Slic3r_PE_model.config, in order; [1] when they name none.
 */
function partSlots(text: string | undefined): number[] {
  if (!text) return [1]
  const ext = (node: ReturnType<typeof parseXml>): number | undefined => {
    const v = node.children.find((c) => c.name === 'metadata' && c.attrs['key'] === 'extruder')?.attrs['value']
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const used = new Set<number>()
  for (const o of parseXml(text).children.flatMap((c) => c.children)) {
    if (o.name !== 'object') continue
    const own = ext(o) ?? 1
    used.add(own)
    for (const part of o.children) {
      // Model parts only: modifiers, negative parts and the like print no filament of their own.
      const kind = part.attrs['subtype'] ?? part.children.find((c) => c.name === 'metadata' && c.attrs['key'] === 'volume_type')?.attrs['value']
      if ((part.name === 'part' || part.name === 'volume') && (kind === undefined || kind === 'normal_part' || kind === 'ModelPart')) used.add(ext(part) ?? own)
    }
  }
  return used.size ? [...used].sort((a, b) => a - b) : [1]
}

/**
 * The filaments a project's tool changes print in (Metadata/custom_gcode_per_layer.xml type 2 under the one-filament
 * mode, the only one they apply in), as the app counts them among the plate's filaments (slots.ts toolChangeSlots).
 */
function toolChangeSlots(text: string | undefined): number[] {
  if (!text) return []
  const out: number[] = []
  for (const plate of parseXml(text).children.flatMap((c) => (c.name === 'plate' ? [c] : c.children.filter((p) => p.name === 'plate')))) {
    if (plate.children.find((c) => c.name === 'mode')?.attrs['value']?.trim() !== 'MultiAsSingle') continue
    for (const l of plate.children) {
      const n = Number(l.attrs['extruder'])
      if (l.name === 'layer' && l.attrs['type']?.trim() === '2' && Number.isInteger(n) && n >= 1 && n <= 64) out.push(n)
    }
  }
  return out
}

/** Keys a project or shared preset may never set: post-processing scripts and credentials (sx-core preflight::is_never_imported). */
export function isNeverImported(key: string): boolean {
  const k = key.toLowerCase()
  if (k === 'post_process') return true
  if (k.startsWith('printhost_') && ['user', 'password', 'apikey', 'api_key', 'authorization', 'cafile'].some((s) => k.includes(s))) return true
  return ['password', 'apikey', 'api_key', 'access_code', 'secret', 'token', 'bearer'].some((s) => k.includes(s))
}

/**
 * A project key's value as the file holds it (Bambu Studio and Orca write numbers as strings), when it is one the
 * engine can read: a plain value or a flat list of them. Anything else is left out.
 */
function projectValue(v: unknown): SettingValue | undefined {
  const plain = (x: unknown) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
  if (plain(v)) return v as SettingValue
  if (Array.isArray(v) && v.every(plain)) return v as SettingValue
  return undefined
}

/** Text made only of `key = value` lines, with `;` or `#` comments and `[section]` headers between them. */
function looksLikeIni(text: string): boolean {
  let pairs = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#') || (line.startsWith('[') && line.endsWith(']'))) continue
    const eq = line.indexOf('=')
    if (eq < 0 || !/^[A-Za-z0-9_]+$/.test(line.slice(0, eq).trim())) return false
    pairs++
  }
  return pairs > 0
}

/**
 * `Metadata/project_settings.config` as settings, as sx-core reads it: nothing when the file has none or it is empty or
 * only white space, the JSON object when it is one (a leading byte order mark is allowed), else why it was left out.
 */
export function projectSettingsOf(name: string, text: string | undefined): { raw?: Record<string, unknown>; skipped?: string } {
  const body = text?.replace(/^\uFEFF/, '')
  if (body === undefined || /^[ \t\n\r\f]*$/.test(body)) return {}
  let why: string
  try {
    const j: unknown = JSON.parse(body)
    if (j !== null && typeof j === 'object' && !Array.isArray(j)) return { raw: j as Record<string, unknown> }
    why = 'is JSON but not an object of settings'
  } catch (e) {
    why = looksLikeIni(body) ? 'holds INI style settings (key = value lines), not JSON' : `is not JSON (${e instanceof Error ? e.message : String(e)})`
  }
  return { skipped: `${name}: Metadata/project_settings.config ${why}, so the project's print settings were left out` }
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v !== '' ? v.split(';') : [])

/** The main model part: `3D/3dmodel.model`, or the first model part when a file names it otherwise. */
function mainModel(names: string[]): string {
  return names.find((n) => n.toLowerCase() === '3d/3dmodel.model') ?? names.find((n) => n.toLowerCase().endsWith('.model')) ?? ''
}

/**
 * The printable build items of a 3MF's main model: without plates in model_settings.config the file is one plate of
 * these, as the engine slices it (an item with `printable="0"` stays off it).
 */
function buildItems(model: string): number {
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(model)?.[1] ?? ''
  return [...build.matchAll(/<item\b([^>]*)>/g)].filter((m) => !/\bprintable\s*=\s*"\s*0\s*"/.test(m[1] ?? '')).length
}

/**
 * The objects of a project that set a layer height of their own (object metadata in Metadata/model_settings.config, or
 * Metadata/Slic3r_PE_model.config), named as the file names them; with `plate`, only the objects on that plate.
 */
export function objectLayerHeights(path: string, plate?: number): { name: string; layer_height: number }[] {
  const zip = readZip(readFileSync(path), basename(path))
  const text = zip.text('Metadata/model_settings.config') ?? zip.text('Metadata/Slic3r_PE_model.config')
  if (!text) return []
  const nodes = parseXml(text).children.flatMap((c) => c.children)
  const meta = (node: (typeof nodes)[number]) => Object.fromEntries(node.children.filter((c) => c.name === 'metadata').map((c) => [c.attrs['key'] ?? '', c.attrs['value'] ?? '']))
  let on: Set<string> | null = null
  if (plate !== undefined) {
    const p = nodes.find((n) => n.name === 'plate' && Number.parseInt(meta(n)['plater_id'] ?? '', 10) === plate)
    if (p) on = new Set(p.children.filter((c) => c.name === 'model_instance').map((c) => meta(c)['object_id'] ?? ''))
  }
  const out: { name: string; layer_height: number }[] = []
  for (const node of nodes) {
    if (node.name !== 'object' || (on && !on.has(node.attrs['id'] ?? ''))) continue
    const m = meta(node)
    const h = Number(m['layer_height'])
    if (m['layer_height'] !== undefined && Number.isFinite(h) && h > 0) out.push({ name: m['name'] || `object ${node.attrs['id'] ?? out.length + 1}`, layer_height: h })
  }
  return out
}

export function readProjectFile(path: string): ProjectRead {
  const name = basename(path)
  const zip = readZip(readFileSync(path), name)
  if (!zip.names().some((n) => n.toLowerCase().endsWith('.model'))) throw new ToolInputError(`${name} has no 3D model part, so it is not a 3MF project`, 'invalid_model')
  const read = projectSettingsOf(name, zip.text('Metadata/project_settings.config'))
  // A PrusaSlicer project (no project_settings.config, or a blank one) keeps its settings in Slic3r_PE.config: what it
  // may set, mapped to our keys as the app and sx slice <project.3mf> open it (prusaProjectConfig, prusa-map.json). Its
  // printer settings and G-code stay the printer's the slice names.
  const prusaText = read.raw === undefined && read.skipped === undefined ? zip.text('Metadata/Slic3r_PE.config') : undefined
  const prusa = prusaText === undefined ? undefined : prusaProjectConfig(prusaText)
  const prusaRaw = prusaText === undefined ? {} : readPrusaConfig(prusaText)
  const hasSettings = read.raw !== undefined || prusa !== undefined
  const modelSettings = zip.text('Metadata/model_settings.config')
  const raw: Record<string, unknown> = read.raw ?? prusa?.config ?? {}
  const dropped = Object.keys(raw).filter(isNeverImported).sort()
  // Bambu Studio 2 writes some values once per hotend variant: the ones that slice, as the app takes them.
  let kept: Record<string, unknown>
  try {
    kept = selectVariants(Object.fromEntries(Object.entries(raw).filter(([k]) => !isNeverImported(k))))
  } catch (error) {
    if (error instanceof ProjectVariantError) throw new ToolInputError(error.message, 'invalid_settings')
    throw error
  }
  const modelPath = zip.names().find((n) => n.toLowerCase() === '3d/3dmodel.model')
  // A project's main model only places its objects, so it is small; a plain 3MF's can be large and has no settings.
  const source = hasSettings && modelPath ? sourceApp(zip.text(modelPath)?.slice(0, 4096)) : undefined
  // The app that wrote the file reads some keys its project lacks its own way (engine-choices.json fromApp), as the
  // app's project open and `sx slice <project.3mf>` read them: a Bambu Studio project without them gets the rib
  // tower, 500 mm/s2 first layer travel and internal bridges at the bridge speed.
  // The app opens a PrusaSlicer project's values on the current printer as they are, so none of this applies to one.
  if (!prusa) Object.assign(kept, appMissingKeys(kept, source))
  const imported = importProject({ projectSettings: kept, ...(modelSettings ? { modelSettings } : {}) })

  // Plates and how many objects sit on each, from model_settings.config; a plain 3MF is one plate.
  const plates: ProjectPlate[] = []
  if (modelSettings) {
    for (const node of parseXml(modelSettings).children.flatMap((c) => c.children)) {
      if (node.name !== 'plate') continue
      const meta = Object.fromEntries(node.children.filter((c) => c.name === 'metadata').map((c) => [c.attrs['key'] ?? '', c.attrs['value'] ?? '']))
      const id = Number.parseInt(meta['plater_id'] ?? '', 10)
      const seq = meta['print_sequence']
      plates.push({ index: Number.isFinite(id) ? id : plates.length + 1, ...(meta['plater_name'] ? { name: meta['plater_name'] } : {}), objects: node.children.filter((c) => c.name === 'model_instance').length, ...(seq === 'by layer' || seq === 'by object' ? { print_sequence: seq } : {}) })
    }
  }
  if (plates.length === 0) plates.push({ index: 1, objects: buildItems(zip.text(mainModel(zip.names())) ?? '') })

  const types = listOf(prusa ? prusaRaw['filament_type'] : raw['filament_type'])
  const colors = prusa ? prusa.colors : listOf(raw['filament_colour'])
  const presets = imported.names.filaments
  const slots = Math.max(types.length, colors.length, presets.length)
  const filaments = Array.from({ length: slots }, (_, i) => ({
    slot: i + 1,
    ...(types[i] ? { type: types[i] } : {}),
    ...(colors[i] ? { color: colors[i] } : {}),
    ...(presets[i] ? { preset: presets[i] } : {}),
  }))

  // Project keys (the flush volumes, the filament to nozzle map and its mode, the AMS units, the prime tower's spot,
  // the bed type, the print sequences) are not preset settings, so the import keeps them apart; the engine reads
  // them from the request as the file has them, so they go with the print settings. The file's own values win, as
  // for every other setting of an opened project.
  const projectKeys = Object.fromEntries(
    Object.entries(imported.extras).flatMap(([k, v]) => {
      const value = projectValue(v)
      return value === undefined ? [] : [[k, value]]
    }),
  )

  // The file's values, except SlicerX's engine choices the person left as the presets had them (the app's project
  // open keeps the same ones, engine-choices.ts in @slicerx/settings).
  const config: Record<string, SettingValue> = { ...projectKeys, ...(imported.config as unknown as Record<string, SettingValue>) }
  // SlicerX's engine choices the project did not change print with SlicerX's own values (engine-choices.json), as
  // sx slice <project.3mf> does, rather than whatever a lower settings layer holds. An inherited value the keep does not
  // go over (arachne walls) is not one of them, so it stays as the file has it.
  for (const k of keptEngineChoices(raw)) {
    const ours = SLICERX_KEEP_VALUES[k]
    if (ours === undefined) delete config[k]
    else config[k] = ours
  }
  // SlicerX's defaults for the keys a file with settings does not set at all (precise outer wall); a value the file
  // sets stays. A project without settings slices as a plain model.
  if (hasSettings && !prusa) for (const [k, v] of Object.entries(projectDefaults(raw))) config[k] = v

  // The support settings as the file has them, in schema shapes where the import read them.
  const support: Record<string, SettingValue> = {}
  for (const k of Object.keys(raw).filter(isSupportKey).sort()) {
    if (isNeverImported(k)) continue
    const value = (imported.config as unknown as Record<string, SettingValue>)[k] ?? projectValue(raw[k])
    if (value !== undefined) support[k] = value
  }
  const renamed = Object.keys(kept)
    .filter((k) => LEGACY_KEYS[k] !== undefined && LEGACY_KEYS[k] !== k && !(k in (imported.config as Record<string, unknown>)))
    .sort()
    .map((k) => ({ from: k, to: LEGACY_KEYS[k] as string }))
  const fromOf = new Map(renamed.map((r) => [r.to, r.from]))
  const importReport: ImportReport = {
    ...(source ? { source } : {}),
    ...(read.skipped ? { skipped: read.skipped } : {}),
    unknown: [...imported.unknownKeys.map((k) => ({ key: k, value: raw[k] })), ...(prusa?.unmapped ?? []).map((k) => ({ key: k, value: prusaRaw[k] }))],
    retired: imported.ignoredKeys.filter((k) => !LEGACY_GROUPS.foreign.has(k)),
    other_slicer: imported.ignoredKeys.filter((k) => LEGACY_GROUPS.foreign.has(k)),
    renamed,
    invalid: [...imported.invalidKeys.map((k) => ({ key: k, value: raw[k] ?? raw[fromOf.get(k) ?? ''] })), ...(prusa?.notApplied ?? []).map((d) => ({ key: d.key, value: d.value }))],
  }
  const walls = hasSettings ? projectWalls(raw, source) : undefined
  if (walls) importReport.walls = walls

  // The app reads a PrusaSlicer project's settings mapped to Orca's keys, and another project's with the keys its app
  // reads its own way; our own .sx3mf projects open on the current printer as they are.
  const own = /\.sx3mf$/i.test(name)
  const used = [...new Set([...partSlots(modelSettings ?? zip.text('Metadata/Slic3r_PE_model.config')), ...toolChangeSlots(zip.text('Metadata/custom_gcode_per_layer.xml'))])].sort((a, b) => a - b)
  const top = Math.max(...used)
  const opened = own || !hasSettings ? undefined : prusa ? { from: 'prusaslicer' as const, settings: prusaProjectSettings(prusaText!).values, slots: top, used } : read.raw ? { from: 'orca' as const, settings: withBambuMissingKeys(read.raw, source), slots: top, used } : undefined

  return {
    ...(opened ? { opened } : {}),
    summary: {
      file: path,
      has_settings: hasSettings,
      plates,
      presets: { ...(imported.names.printer ? { printer: imported.names.printer } : {}), ...(imported.names.process ? { process: imported.names.process } : {}), filaments: presets },
      filaments,
      unknown_keys: [...imported.unknownKeys, ...imported.invalidKeys, ...(prusa?.unmapped ?? []), ...(prusa?.notApplied ?? []).map((d) => d.key)].sort(),
      dropped_keys: dropped,
      support,
      import_report: importReport,
    },
    config,
  }
}
