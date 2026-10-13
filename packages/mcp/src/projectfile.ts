// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a 3MF or .sx3mf project without its geometry: the plates, the presets it was set up with, its filament
// slots and its print settings, so a file can be sliced the way it was saved.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { SettingValue } from '@slicerx/contracts'
import { changedKeys, importProject, keptEngineChoices, LEGACY_GROUPS, LEGACY_KEYS, parseXml, selectVariants, SLICERX_KEEP_VALUES } from '@slicerx/settings'
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
  /** True when the file carries print settings (a Bambu Studio, OrcaSlicer or SlicerX project); false for a plain 3MF. */
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
}

/**
 * Which wall generator a slice runs, where it came from, and the sentence that says so: `kept` (SlicerX's choice
 * over the one the project inherited, as engine-choices.ts keeps it), `project` (the project's own, listed as
 * changed), `request` (the call's overrides) or `profile` (the printer profile).
 */
export interface WallsNote {
  generator: string
  source: 'kept' | 'project' | 'request' | 'profile'
  text: string
}

/** A setting value as one string: `"classic"`, `["classic"]`. */
const oneText = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)

/** The walls a project slices with, by the rule that keeps SlicerX's engine choices. */
export function projectWalls(raw: Record<string, unknown>, source: string | undefined): WallsNote | undefined {
  const own = oneText(raw['wall_generator'])
  const ours = String(SLICERX_KEEP_VALUES['wall_generator'] ?? 'aegis')
  const changed = changedKeys(raw)
  if (changed && !changed.has('wall_generator')) {
    const maker = source?.startsWith('OrcaSlicer') ? "OrcaSlicer's" : source?.startsWith('BambuStudio') ? "Bambu's" : "its preset's"
    const text = own === undefined ? `${ours} walls, kept by ${productName()}; the project names none` : own === ours ? `${ours} walls, as the project has them` : `${ours} walls, kept by ${productName()}; the project used ${maker} default ${own}`
    return { generator: ours, source: 'kept', text }
  }
  return own === undefined ? undefined : { generator: own, source: 'project', text: `${own} walls, the project's own choice` }
}

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

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v !== '' ? v.split(';') : [])

export function readProjectFile(path: string): ProjectRead {
  const name = basename(path)
  const zip = readZip(readFileSync(path), name)
  if (!zip.names().some((n) => n.toLowerCase().endsWith('.model'))) throw new ToolInputError(`${name} has no 3D model part, so it is not a 3MF project`, 'invalid_model')
  const settingsText = zip.text('Metadata/project_settings.config')
  const modelSettings = zip.text('Metadata/model_settings.config')
  let raw: Record<string, unknown> = {}
  if (settingsText !== undefined) {
    try {
      raw = JSON.parse(settingsText) as Record<string, unknown>
    } catch {
      throw new ToolInputError(`${name}: Metadata/project_settings.config is not JSON`, 'invalid_model')
    }
  }
  const dropped = Object.keys(raw).filter(isNeverImported).sort()
  // Bambu Studio 2 writes some values once per hotend variant: the ones that slice, as the app takes them.
  const kept = selectVariants(Object.fromEntries(Object.entries(raw).filter(([k]) => !isNeverImported(k))))
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
  if (plates.length === 0) plates.push({ index: 1, objects: imported.objects.length })

  const types = listOf(raw['filament_type'])
  const colors = listOf(raw['filament_colour'])
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
  // sx slice <project.3mf> does, rather than whatever a lower settings layer holds.
  for (const k of keptEngineChoices(raw)) {
    const ours = SLICERX_KEEP_VALUES[k]
    if (ours === undefined) delete config[k]
    else config[k] = ours
  }

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
  const modelPath = zip.names().find((n) => n.toLowerCase() === '3d/3dmodel.model')
  // A project's main model only places its objects, so it is small; a plain 3MF's can be large and has no settings.
  const source = settingsText !== undefined && modelPath ? sourceApp(zip.text(modelPath)?.slice(0, 4096)) : undefined
  const importReport: ImportReport = {
    ...(source ? { source } : {}),
    unknown: imported.unknownKeys.map((k) => ({ key: k, value: raw[k] })),
    retired: imported.ignoredKeys.filter((k) => !LEGACY_GROUPS.foreign.has(k)),
    other_slicer: imported.ignoredKeys.filter((k) => LEGACY_GROUPS.foreign.has(k)),
    renamed,
    invalid: imported.invalidKeys.map((k) => ({ key: k, value: raw[k] ?? raw[fromOf.get(k) ?? ''] })),
  }
  const walls = settingsText !== undefined ? projectWalls(raw, source) : undefined
  if (walls) importReport.walls = walls

  return {
    summary: {
      file: path,
      has_settings: settingsText !== undefined,
      plates,
      presets: { ...(imported.names.printer ? { printer: imported.names.printer } : {}), ...(imported.names.process ? { process: imported.names.process } : {}), filaments: presets },
      filaments,
      unknown_keys: [...imported.unknownKeys, ...imported.invalidKeys].sort(),
      dropped_keys: dropped,
      support,
      import_report: importReport,
    },
    config,
  }
}
