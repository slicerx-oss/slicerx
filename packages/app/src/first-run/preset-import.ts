// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bringing presets over from the slicer the person used before. The desktop app registers a host
// that finds the user presets of an installed OrcaSlicer, Bambu Studio or PrusaSlicer; the browser
// has no such host and reads files the person picks. Both paths end in presets/import-files.ts.
import type { Host, LookId } from '@slicerx/contracts'
import type { PresetSource } from '../presets/import-files'
import { importSummary, PRESET_FILE_TYPES, type ImportResult } from '../presets/import-result'

export type SlicerApp = 'orcaslicer' | 'bambu-studio' | 'prusaslicer'

export const APP_NAMES: Readonly<Record<SlicerApp, string>> = { orcaslicer: 'OrcaSlicer', 'bambu-studio': 'Bambu Studio', prusaslicer: 'PrusaSlicer' }

/** The slicer a look preset stands for; SlicerX stands for none. */
export const APP_FOR_LOOK: Readonly<Partial<Record<LookId, SlicerApp>>> = { 'bambu-studio': 'bambu-studio', prusaslicer: 'prusaslicer', orcaslicer: 'orcaslicer' }

/** A user preset found on disk. Vendor presets are never listed: SlicerX ships its own. */
export interface InstalledPreset {
  app: SlicerApp
  kind: 'printer' | 'filament' | 'process'
  name: string
  /** Where it is, so the person can tell two presets with one name apart. */
  path: string
}

/** What a build with disk access provides. Reads only; nothing is written to the other app. */
export interface PresetImportHost {
  /** The user presets of an installed slicer. Empty when it is not installed or has none. */
  scan(app: SlicerApp): Promise<InstalledPreset[]>
  /** The text of one preset file. */
  read(preset: InstalledPreset): Promise<string>
}

type Factory = (host: Host) => PresetImportHost
let factory: Factory | null = null

/** Called once by an app entry that can read the other slicers' folders (the desktop app). */
export function registerPresetImport(f: Factory | null): void {
  factory = f
}

export function presetImportFor(host: Host): PresetImportHost | null {
  return factory ? factory(host) : null
}

/** Where each slicer keeps user presets, for the desktop host and the hint in the UI. `~` is the home folder, `%APPDATA%` on Windows. */
export const PRESET_FOLDERS: Readonly<Record<SlicerApp, { mac: string; windows: string; linux: string }>> = {
  orcaslicer: { mac: '~/Library/Application Support/OrcaSlicer/user', windows: '%APPDATA%\\OrcaSlicer\\user', linux: '~/.config/OrcaSlicer/user' },
  'bambu-studio': { mac: '~/Library/Application Support/BambuStudio/user', windows: '%APPDATA%\\BambuStudio\\user', linux: '~/.config/BambuStudio/user' },
  prusaslicer: { mac: '~/Library/Application Support/PrusaSlicer', windows: '%APPDATA%\\PrusaSlicer', linux: '~/.config/PrusaSlicer' },
}

/** File types each slicer writes its presets and preset bundles as. */
export function presetExtensions(app: SlicerApp | null): string[] {
  if (app === 'prusaslicer') return ['.ini']
  if (app === 'orcaslicer') return ['.json', '.orca_printer', '.orca_filament', '.orca_bundle', '.zip']
  if (app === 'bambu-studio') return ['.json', '.bbscfg', '.bbsflmt', '.zip']
  return [...PRESET_FILE_TYPES]
}

export type { ImportResult }
export { importSummary }

/**
 * Imports one preset file: a PrusaSlicer `.ini` (single presets, exported configurations and config bundles with their
 * `inherits` chains), an Orca or Bambu Studio preset, or one of their zipped bundles. Never throws; each result says
 * what happened and carries the report of what did not carry over.
 */
export async function importPresetFile(data: string | Uint8Array, fileName: string, kind?: InstalledPreset['kind']): Promise<ImportResult[]> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const { importPresetSources } = await import('../presets/import-files')
  return importPresetSources([{ name: fileName, bytes, ...(kind ? { kind } : {}) }])
}

/** Lets the person pick preset files and imports them together. Empty when the picker was canceled. */
export async function importPickedFiles(host: Host, app: SlicerApp | null): Promise<ImportResult[]> {
  const refs = await host.files.open({ accept: presetExtensions(app), multiple: true })
  const sources: PresetSource[] = []
  for (const ref of refs) sources.push({ name: ref.name, bytes: new Uint8Array(await host.files.read(ref)) })
  if (sources.length === 0) return []
  const { importPresetSources } = await import('../presets/import-files')
  return importPresetSources(sources)
}

/** Imports presets the host found, together, so a preset finds a parent of its own among them. */
export async function importInstalled(imp: PresetImportHost, presets: InstalledPreset[]): Promise<ImportResult[]> {
  const out: ImportResult[] = []
  const sources: PresetSource[] = []
  for (const p of presets) {
    try {
      sources.push({ name: p.path.split(/[\\/]/).pop() ?? p.name, bytes: new TextEncoder().encode(await imp.read(p)), kind: p.kind })
    } catch (e) {
      out.push({ name: p.name, ok: false, skipped: 0, message: e instanceof Error ? e.message : String(e) })
    }
  }
  if (sources.length === 0) return out
  const { importPresetSources } = await import('../presets/import-files')
  return [...out, ...(await importPresetSources(sources))]
}
