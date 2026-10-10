// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a 3MF or .sx3mf project without its geometry: the plates, the presets it was set up with, its filament
// slots and its print settings, so a file can be sliced the way it was saved.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { SettingValue } from '@slicerx/contracts'
import { importProject, keptEngineChoices, parseXml, selectVariants } from '@slicerx/settings'
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
  for (const k of keptEngineChoices(raw)) delete config[k]

  return {
    summary: {
      file: path,
      has_settings: settingsText !== undefined,
      plates,
      presets: { ...(imported.names.printer ? { printer: imported.names.printer } : {}), ...(imported.names.process ? { process: imported.names.process } : {}), filaments: presets },
      filaments,
      unknown_keys: [...imported.unknownKeys, ...imported.invalidKeys].sort(),
      dropped_keys: dropped,
    },
    config,
  }
}
