// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The user's own OrcaSlicer and Bambu Studio presets (the JSON files in their user folders), read as settings layers.
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { SettingSection, SettingValue } from '@slicerx/contracts'
import { BundleError, importPresetFiles, MAX_BUNDLE_PRESETS, MAX_PRESET_BYTES, presetKind, readPresetBundle, type PresetFile } from '@slicerx/settings'
import { checkReadable, ToolInputError, type PathPolicy } from './models'
import { isNeverImported } from './projectfile'
import { readZip } from './zip'

/** Preset bundles: Bambu Studio's printer and filament bundles, OrcaSlicer's, and a plain zip of presets. */
export const BUNDLE_EXTENSIONS = ['.bbscfg', '.bbsflmt', '.orca_printer', '.orca_filament', '.orca_bundle', '.zip']
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

const clean = (json: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(json).filter(([k]) => !isNeverImported(k)))

export interface PresetLayer {
  name: string
  section: SettingSection
  values: Record<string, SettingValue>
  /** The maker profile it inherits from, when SlicerX ships it; its values are already in `values`. */
  inherits?: string
  /**
   * The preset brings custom G-code of its own: a G-code setting the file itself sets, or any G-code when it does
   * not inherit from a profile SlicerX ships. G-code inherited from a shipped profile is that profile's own text.
   */
  customGcode: boolean
}

/** Printer presets apply first, then process, then filament, like OrcaSlicer's own merge. */
const ORDER: Record<string, number> = { printer: 0, process: 1, filament: 2 }

export async function readPresetFiles(policy: PathPolicy, paths: readonly string[]): Promise<PresetLayer[]> {
  const files: PresetFile[] = []
  let printer: string | undefined
  for (const p of paths) {
    const real = checkReadable(policy, p)
    const ext = extname(real).toLowerCase()
    if (BUNDLE_EXTENSIONS.includes(ext)) {
      if (statSync(real).size > MAX_BUNDLE_BYTES) throw new ToolInputError(`${basename(real)} is over the ${MAX_BUNDLE_BYTES} byte limit for a preset bundle`, 'invalid_input')
      const zip = readZip(readFileSync(real), basename(real))
      const names = zip.names().filter((n) => /\.json$/i.test(n)).slice(0, MAX_BUNDLE_PRESETS + 1)
      const entries = new Map(names.map((n) => [n, new Uint8Array(zip.read(n, MAX_PRESET_BYTES) ?? Buffer.alloc(0))]))
      try {
        const bundle = readPresetBundle(entries)
        printer ??= bundle.printer
        files.push(...bundle.files.map((f) => ({ ...f, json: clean(f.json) })))
      } catch (e) {
        if (e instanceof BundleError) throw new ToolInputError(`${basename(real)}: ${e.message}`, 'invalid_input')
        throw e
      }
      continue
    }
    if (ext !== '.json') throw new ToolInputError(`${basename(real)}: preset files are OrcaSlicer or Bambu Studio presets (.json) or preset bundles (${BUNDLE_EXTENSIONS.join(', ')})`, 'unsupported_format')
    if (statSync(real).size > MAX_PRESET_BYTES) throw new ToolInputError(`${basename(real)} is over the ${MAX_PRESET_BYTES} byte limit for a preset`, 'invalid_input')
    let json: Record<string, unknown>
    try {
      json = JSON.parse(readFileSync(real, 'utf8')) as Record<string, unknown>
    } catch {
      throw new ToolInputError(`${basename(real)} is not JSON`, 'invalid_input')
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new ToolInputError(`${basename(real)} is not a preset object`, 'invalid_input')
    const kind = presetKind(json)
    if (!kind) throw new ToolInputError(`${basename(real)} is not a printer, process or filament preset (it has no type or settings id)`, 'invalid_input')
    files.push({ path: real, kind, json: clean(json) })
  }
  // Imported together, so a preset that inherits from another one in the set finds it.
  const imported = await importPresetFiles(files, printer ? { printer } : {})
  const own = new Map(files.map((f) => [String(f.json['name'] ?? ''), Object.keys(f.json)]))
  const gcode = (keys: string[]) => keys.some((k) => k.endsWith('_gcode'))
  return imported
    .map((p) => ({ name: p.name, section: p.kind, values: p.values, ...(p.inherits ? { inherits: p.inherits } : {}), customGcode: p.inherits ? gcode(own.get(p.name) ?? Object.keys(p.values)) : gcode(Object.keys(p.values)) }))
    .sort((a, b) => (ORDER[a.section] ?? 9) - (ORDER[b.section] ?? 9))
}
