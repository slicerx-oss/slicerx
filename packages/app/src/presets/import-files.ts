// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preset files from other slicers into SlicerX presets, each with a report of what did not carry over. One path for
// setup step 2 and Settings > Presets: our own JSON, OrcaSlicer and Bambu Studio preset JSON, their zipped bundles
// (.orca_printer, .orca_filament, .orca_bundle, .bbscfg, .bbsflmt, or a plain .zip of presets) and PrusaSlicer .ini
// files. Files picked together import together, so a preset finds a parent that came with it. Bundles are untrusted
// zips: entry count, entry size and the inflated total are capped, and paths that climb out are refused.
import { get } from '../state/store'
import { ProjectReadError, unzipEntries, type ZipLimits } from '../export/import3mf'
import type { ImportResult } from './import-result'
import type { PresetKind } from './store'
import { appName } from '../edition'

export { importSummary, PRESET_FILE_TYPES, type ImportResult } from './import-result'

const BUNDLE_RE = /\.(orca_printer|orca_filament|orca_bundle|bbscfg|bbsflmt|zip)$/i
/** Largest bundle file read at all. Real bundles are tens of kilobytes. */
export const MAX_BUNDLE_FILE = 16 * 1024 * 1024
/** Caps on a bundle once open: a preset is a few kilobytes, so anything near these is not a preset bundle. */
export const BUNDLE_LIMITS: ZipLimits = { entries: 1000, entry: 2 * 1024 * 1024, total: 32 * 1024 * 1024, what: 'a preset bundle' }

export interface PresetSource {
  /** The file name, which says what the file is. */
  name: string
  bytes: Uint8Array
  /** The kind, when the place it came from says (an installed slicer's folder). */
  kind?: PresetKind
}

const isZip = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)
const fail = (name: string, e: unknown): ImportResult => ({ name, ok: false, skipped: 0, message: e instanceof Error ? e.message : String(e) })

/**
 * Import preset files. Never throws; each result says what happened to one preset, or why a file was skipped.
 * Imported presets are saved but not switched to.
 */
export async function importPresetSources(sources: readonly PresetSource[]): Promise<ImportResult[]> {
  const settings = await import('@slicerx/settings')
  const presets = await import('./presets')
  const printerId = get().profile?.printerId
  const out: ImportResult[] = []
  const save = async (list: readonly import('@slicerx/settings').ImportedPreset[]): Promise<void> => {
    // Printers first, so the links of the others can follow a printer renamed to keep its name unique.
    const renamed = new Map<string, string>()
    const order = [...list].sort((a, b) => (a.kind === 'printer' ? 0 : 1) - (b.kind === 'printer' ? 0 : 1))
    for (const p of order) {
      try {
        const printer = p.printer ? (renamed.get(p.printer) ?? p.printer) : undefined
        const saved = await presets.savePreset(p.kind, p.name, { values: p.values, ...(p.inherits ? { inherits: p.inherits } : {}), ...(printer ? { printer } : {}) }, { activate: false })
        if (p.kind === 'printer') renamed.set(p.name, saved.name)
        out.push({ name: saved.name, ok: true, kind: p.kind, skipped: p.report.items.length, report: { ...p.report, name: saved.name } })
      } catch (e) {
        out.push(fail(p.name, e))
      }
    }
  }
  const orca: import('@slicerx/settings').PresetFile[] = []
  const dec = new TextDecoder()
  for (const src of sources) {
    try {
      if (BUNDLE_RE.test(src.name) || isZip(src.bytes)) {
        if (src.bytes.length > MAX_BUNDLE_FILE) throw new Error('That file is too large to be a preset bundle.')
        let entries: Map<string, Uint8Array>
        try {
          entries = await unzipEntries(src.bytes, BUNDLE_LIMITS)
        } catch (e) {
          throw e instanceof ProjectReadError ? new Error(e.message) : e
        }
        const bundle = settings.readPresetBundle(entries)
        await save(await settings.importPresetFiles(bundle.files, { ...(printerId ? { printerId } : {}), ...(bundle.printer ? { printer: bundle.printer } : {}) }))
        for (const s of bundle.skipped) out.push({ name: `${src.name}: ${s.path}`, ok: false, skipped: 0, message: s.why })
      } else if (/\.ini$/i.test(src.name)) {
        await importIni(src, dec.decode(src.bytes), printerId, out)
      } else {
        const text = dec.decode(src.bytes)
        if (src.bytes.length > settings.MAX_PRESET_BYTES) throw new Error('That file is too large to be a preset.')
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error('That file is not valid JSON.')
        }
        const o = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null
        if (!o) throw new Error('That file is not a preset.')
        if (o['slicerx'] === 'preset') {
          const { preset, skipped } = await presets.importPresetText(text)
          out.push({ name: preset.name, ok: true, kind: preset.kind, skipped: skipped.length })
          continue
        }
        const kind = settings.presetKind(o) ?? src.kind
        if (!kind) throw new Error(`That file is not a ${appName()}, OrcaSlicer, Bambu Studio or PrusaSlicer preset.`)
        orca.push({ path: src.name, kind, json: o })
      }
    } catch (e) {
      out.push(fail(src.name, e))
    }
  }
  // Loose Orca and Bambu Studio files import together, so a filament finds the base filament it was made from.
  if (orca.length) {
    try {
      await save(await settings.importPresetFiles(orca, printerId ? { printerId } : {}))
    } catch (e) {
      out.push(fail(orca[0]!.path, e))
    }
  }
  return out
}

async function importIni(src: PresetSource, text: string, printerId: string | undefined, out: ImportResult[]): Promise<void> {
  const settings = await import('@slicerx/settings')
  const presets = await import('./presets')
  const found = settings.importPrusaIni(text, src.name)
  if (found.length === 0) {
    out.push({ name: src.name, ok: false, skipped: 0, message: 'The file has no settings in it.' })
    return
  }
  const printerCfg = printerId ? settings.profileConfig({ printer: printerId }) : undefined
  for (const f of found) {
    const report = settings.buildReport({
      name: f.name,
      section: f.section,
      family: 'prusa',
      dropped: f.dropped,
      config: f.config,
      origin: {},
      ...(printerCfg && printerId ? { printer: { name: settings.printerName(printerId), config: printerCfg } } : {}),
      defaulted: settings.countDefaulted(f.section, f.config),
    })
    const values: Record<string, import('@slicerx/contracts').SettingValue> = {}
    for (const [k, v] of Object.entries(f.config as unknown as Record<string, import('@slicerx/contracts').SettingValue>)) if (settings.settingDef(k)?.section === f.section) values[k] = v
    const compat = (f.config as unknown as Record<string, unknown>)['compatible_printers']
    const printer = f.section !== 'printer' && Array.isArray(compat) && typeof compat[0] === 'string' && compat[0] !== '' ? compat[0] : undefined
    const p = await presets.savePreset(f.section, f.name, { values, ...(printer ? { printer } : {}) }, { activate: false })
    out.push({ name: p.name, ok: true, kind: f.section, skipped: report.items.length, report: { ...report, name: p.name } })
  }
}

/** The reports of an import as plain text, for saving. Keys only in developer mode. */
export async function importReportText(results: readonly ImportResult[], keys: boolean): Promise<string> {
  const { reportText } = await import('@slicerx/settings')
  const reports = results.flatMap((r) => (r.report ? [r.report] : []))
  const failed = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.message ?? 'not imported'}`)
  return reportText(reports, { keys }) + (failed.length ? `\nNot imported:\n${failed.map((f) => `  ${f}`).join('\n')}\n` : '')
}
