// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// OrcaSlicer and Bambu Studio user presets, one file or a zipped bundle, into SlicerX presets with an import report.
// Bundles: Orca's printer config bundle (.orca_printer, .orca_bundle) and filament bundle (.orca_filament), Bambu
// Studio's printer preset bundle (.bbscfg) and filament preset bundle (.bbsflmt), and a plain zip of preset files.
// A bundle is a zip with `bundle_structure.json` naming the preset files: `printer/`, `filament/` and `process/` in a
// printer bundle, `<vendor>/` in a filament bundle. Unzipping is the caller's job; this reads the entries. Each preset
// resolves its `inherits` chain against the other presets of the import first, then against the maker profiles
// SlicerX ships (vendorparent.ts). src/bundle.rs reads bundles the same way.
import type { PrintConfig, SettingSection, SettingValue } from '@slicerx/contracts/settings'
import { profileConfig } from './profiles'
import { buildReport, countDefaulted, importLayers, type ImportLayer, type ImportReport } from './report'
import { settingDef } from './schema'
import { printerForPresetName, printerName, vendorParent } from './vendorparent'

/** Largest preset file inside a bundle, in bytes. Real presets are a few kilobytes; a full one with G-code is under 100 KB. */
export const MAX_PRESET_BYTES = 2 * 1024 * 1024
/** Most presets read from one bundle. */
export const MAX_BUNDLE_PRESETS = 500
const MAX_DEPTH = 32

export interface PresetFile {
  /** Where it was: the path inside the bundle, or the file name. */
  path: string
  kind: SettingSection
  json: Record<string, unknown>
}

export interface PresetBundle {
  type: 'printer' | 'filament' | 'presets'
  /** A printer bundle's printer preset, which its filament and process presets belong to. */
  printer?: string
  files: PresetFile[]
  /** Entries that were named but could not be read, with why. */
  skipped: { path: string; why: string }[]
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleError'
  }
}

const asObject = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The kind of an Orca or Bambu preset: its `type`, else the settings id it carries (user presets have no `type`). */
export function presetKind(o: Record<string, unknown>): SettingSection | undefined {
  const t = o['type']
  if (t === 'machine' || t === 'printer') return 'printer'
  if (t === 'filament') return 'filament'
  if (t === 'process' || t === 'print') return 'process'
  if ('printer_settings_id' in o) return 'printer'
  if ('print_settings_id' in o) return 'process'
  if ('filament_settings_id' in o) return 'filament'
  return undefined
}

const FOLDER_KIND: Record<string, SettingSection> = { printer: 'printer', machine: 'printer', filament: 'filament', process: 'process', print: 'process' }

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..')
}

/** Read the preset files of an unzipped bundle. Throws BundleError when the archive holds no presets. */
export function readPresetBundle(entries: ReadonlyMap<string, Uint8Array>): PresetBundle {
  const dec = new TextDecoder()
  const skipped: { path: string; why: string }[] = []
  const read = (path: string, kind: SettingSection | undefined): PresetFile | undefined => {
    if (!safePath(path)) {
      skipped.push({ path, why: 'The path is not safe.' })
      return undefined
    }
    const bytes = entries.get(path)
    if (!bytes) {
      skipped.push({ path, why: 'The bundle names this file but does not have it.' })
      return undefined
    }
    if (bytes.length > MAX_PRESET_BYTES) {
      skipped.push({ path, why: 'The file is too large to be a preset.' })
      return undefined
    }
    let json: Record<string, unknown> | undefined
    try {
      json = asObject(JSON.parse(dec.decode(bytes)))
    } catch {
      json = undefined
    }
    if (!json) {
      skipped.push({ path, why: 'The file is not a preset.' })
      return undefined
    }
    const own = presetKind(json)
    const k = kind ?? own
    if (!k || (own && own !== k)) {
      skipped.push({ path, why: own ? 'The file is a different kind of preset than the bundle says.' : 'The file is not a preset.' })
      return undefined
    }
    return { path, kind: k, json }
  }
  let manifest: Record<string, unknown> | undefined
  const m = entries.get('bundle_structure.json')
  if (m) {
    try {
      manifest = asObject(JSON.parse(dec.decode(m)))
    } catch {
      throw new BundleError('The bundle description in this file is damaged.')
    }
  }
  const files: PresetFile[] = []
  const add = (f: PresetFile | undefined) => {
    if (!f) return
    if (files.length >= MAX_BUNDLE_PRESETS) throw new BundleError('The bundle has too many presets.')
    files.push(f)
  }
  let type: PresetBundle['type'] = 'presets'
  let printer: string | undefined
  const bundleType = manifest?.['bundle_type']
  if (manifest && bundleType === 'printer config bundle') {
    type = 'printer'
    const name = manifest['printer_preset_name']
    for (const p of strings(manifest['printer_config'])) add(read(p, 'printer'))
    for (const p of strings(manifest['filament_config'])) add(read(p, 'filament'))
    for (const p of strings(manifest['process_config'])) add(read(p, 'process'))
    const printers = files.filter((f) => f.kind === 'printer')
    // Orca's newer export names the bundle `export` and may hold several printers; then no single printer owns the rest.
    printer = typeof name === 'string' && printers.some((f) => f.json['name'] === name) ? name : printers.length === 1 ? String(printers[0]!.json['name'] ?? '') || undefined : undefined
  } else if (manifest && bundleType === 'filament config bundle') {
    type = 'filament'
    // Orca lists the files per printer vendor, Bambu Studio per filament vendor.
    const groups = [...(Array.isArray(manifest['printer_vendor']) ? manifest['printer_vendor'] : []), ...(Array.isArray(manifest['filament_vendor']) ? manifest['filament_vendor'] : [])]
    for (const g of groups) for (const p of strings(asObject(g)?.['filament_path'])) add(read(p, 'filament'))
  } else {
    // A plain zip of preset files (Orca's "Printer presets.zip"), or a bundle of a type this does not know.
    for (const path of [...entries.keys()].sort()) {
      if (!/\.json$/i.test(path) || path === 'bundle_structure.json') continue
      const folder = path.split('/')[0] ?? ''
      add(read(path, path.includes('/') ? FOLDER_KIND[folder.toLowerCase()] : undefined))
    }
  }
  if (files.length === 0) throw new BundleError(skipped.length ? `No preset in the bundle could be read. ${skipped[0]!.why}` : 'The bundle has no presets in it.')
  return { type, ...(printer ? { printer } : {}), files, skipped }
}

export interface ImportedPreset {
  kind: SettingSection
  name: string
  /** The settings of its kind: its own values over those of the profiles it inherits from. */
  values: Record<string, SettingValue>
  /** The profile it inherits from, by the name the old app used. */
  inherits?: string
  /** The printer preset it belongs to, by name. */
  printer?: string
  report: ImportReport
}

export interface ImportOptions {
  /** The printer model to take missing values from when a preset does not point at one. */
  printerId?: string
  /** The printer preset presets without one of their own belong to (a printer bundle's printer). */
  printer?: string
}

function ofKind(config: PrintConfig, kind: SettingSection): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(config as unknown as Record<string, SettingValue>)) if (settingDef(k)?.section === kind) out[k] = v
  return out
}

/**
 * Import Orca or Bambu Studio presets: every file of one bundle, or files picked together. A preset's parents are
 * looked up among the others first (Bambu Studio's own filaments inherit from a user base preset), then among the
 * maker profiles SlicerX ships. A preset whose parent is in neither keeps its own values.
 */
export async function importPresetFiles(files: readonly PresetFile[], opts: ImportOptions = {}): Promise<ImportedPreset[]> {
  const local = new Map<string, PresetFile>()
  for (const f of files) {
    const n = f.json['name']
    if (typeof n === 'string' && !local.has(`${f.kind}:${n}`)) local.set(`${f.kind}:${n}`, f)
  }
  // The printer of the import: the bundle's printer preset resolved to a model, for values a preset does not set.
  let bundlePrinterId = opts.printerId
  const printerFile = opts.printer ? local.get(`printer:${opts.printer}`) : undefined
  if (printerFile) {
    let cur: Record<string, unknown> | undefined = printerFile.json
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      const inh = cur['inherits']
      if (typeof inh !== 'string' || inh === '') break
      const next = local.get(`printer:${inh}`)
      if (next) cur = next.json
      else {
        bundlePrinterId = (await vendorParent('printer', inh))?.printerId ?? bundlePrinterId
        break
      }
    }
  }
  const out: ImportedPreset[] = []
  for (const f of files) {
    const name = typeof f.json['name'] === 'string' && f.json['name'] !== '' ? (f.json['name'] as string) : f.path.replace(/^.*[\\/]/, '').replace(/\.json$/i, '')
    const layers: ImportLayer[] = [{ name, raw: f.json }]
    const seen = new Set([name])
    let cur = f.json
    let localParent: string | undefined
    let vendorName: string | undefined
    for (let i = 0; i < MAX_DEPTH; i++) {
      const inh = cur['inherits']
      if (typeof inh !== 'string' || inh === '' || seen.has(inh)) break
      seen.add(inh)
      const next = local.get(`${f.kind}:${inh}`)
      if (!next) {
        vendorName = inh
        break
      }
      localParent ??= inh
      layers.push({ name: inh, raw: next.json })
      cur = next.json
    }
    const vendor = vendorName ? await vendorParent(f.kind, vendorName) : undefined
    if (vendor) layers.push({ name: vendorName as string, config: vendor.config })
    const { config, origin, dropped } = importLayers(layers)
    const compat = strings(f.json['compatible_printers'])
    const printerPreset = f.kind === 'printer' ? undefined : (opts.printer ?? compat[0])
    const printerId = vendor?.printerId ?? (f.kind === 'printer' ? undefined : bundlePrinterId) ?? printerForPresetName(name) ?? (vendorName ? printerForPresetName(vendorName) : undefined) ?? opts.printerId
    const printerCfg = printerId ? profileConfig({ printer: printerId }) : undefined
    // With the maker profile found, every setting the old app had is accounted for; otherwise the rest are defaults.
    const defaulted = vendor ? 0 : countDefaulted(f.kind, config)
    // The direct parent: one that came in with it, else the maker profile.
    const parent = localParent ? { name: localParent, found: true, bundled: true } : vendorName ? { name: vendorName, found: vendor !== undefined } : undefined
    const report = buildReport({
      name,
      section: f.kind,
      family: 'orca',
      dropped,
      config,
      origin,
      ...(printerCfg && printerId ? { printer: { name: printerName(printerId), config: printerCfg } } : {}),
      ...(parent ? { parent } : {}),
      defaulted,
    })
    out.push({ kind: f.kind, name, values: ofKind(config, f.kind), ...(vendorName ? { inherits: vendorName } : {}), ...(printerPreset ? { printer: printerPreset } : {}), report })
  }
  return out
}
