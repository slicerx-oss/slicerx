// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which filament and process presets a printer offers. Follows OrcaSlicer 2.4.2's `is_compatible_with_printer` and
// `is_compatible_with_print` (libslic3r/Preset.cpp) and `update_library_profile_excluded_from`:
//  - a preset with a `compatible_printers` list is compatible with exactly the printers named in it (or, for a printer
//    the person made from a system one, the system printer it inherits from);
//  - with an empty list, `compatible_printers_condition` is evaluated against the printer's settings, plus
//    `printer_preset` (its name) and `num_extruders`; an expression that fails to parse or evaluate counts as compatible;
//  - with neither, every printer is compatible;
//  - a shared-library filament without a list is excluded from every printer that a maker's preset of the same product
//    names, so the maker's tuned preset wins;
//  - a process is checked the same way by `compatible_prints` and `compatible_prints_condition` against the active process.
import type { PrintConfig } from '@slicerx/contracts/settings'
import { evaluateCondition } from './conditions'
import { type FilamentPreset, type VendorFile, resolveFilamentPreset } from './filaments'
import { machineEntry, printerConfig, printerProfile } from './profiles'

/** The shared filament library's vendor folder: its presets are the ones a maker's own preset can exclude. */
export const FILAMENT_LIBRARY_VENDOR = 'OrcaFilamentLibrary'

export interface PrinterContext {
  /** The printer preset's name, such as `Bambu Lab P1S 0.4 nozzle`. Empty means no printer is selected and everything is compatible. */
  name: string
  /** The system preset a user printer was made from. */
  inherits?: string
  /** True for a maker's preset, false for one the person made. */
  isSystem: boolean
  /** The printer's settings (`printer_notes`, `nozzle_diameter`, `printer_model` and so on). */
  config: PrintConfig | Record<string, unknown>
}

export interface CompatPreset {
  compatiblePrinters: string[]
  compatiblePrintersCondition?: string
  compatiblePrints?: string[]
  compatiblePrintsCondition?: string
}

function printerExtras(printer: PrinterContext): Record<string, unknown> {
  const nozzles = (printer.config as Record<string, unknown>)['nozzle_diameter']
  const extra: Record<string, unknown> = { printer_preset: printer.name }
  if (Array.isArray(nozzles)) extra['num_extruders'] = nozzles.length
  return extra
}

/** Orca's rule for a preset against the active printer. `excludedFrom` is the library preset's exclusion set, when it has one. */
export function isCompatibleWithPrinter(preset: CompatPreset, printer: PrinterContext, excludedFrom?: ReadonlySet<string>): boolean {
  if (excludedFrom && (excludedFrom.has(printer.name) || (printer.inherits !== undefined && excludedFrom.has(printer.inherits)))) return false
  const list = preset.compatiblePrinters
  const condition = preset.compatiblePrintersCondition ?? ''
  if (list.length === 0 && condition !== '') {
    try {
      return evaluateCondition(condition, printer.config, printerExtras(printer))
    } catch {
      return true
    }
  }
  return printer.name === '' || list.length === 0 || list.includes(printer.name) || (!printer.isSystem && printer.inherits !== undefined && list.includes(printer.inherits))
}

/** Orca's rule for a preset against the active process preset (`config` holds the process settings). */
export function isCompatibleWithPrint(preset: CompatPreset, print: { name: string; config: PrintConfig | Record<string, unknown> }): boolean {
  const list = preset.compatiblePrints ?? []
  const condition = preset.compatiblePrintsCondition ?? ''
  if (list.length === 0 && condition !== '') {
    try {
      return evaluateCondition(condition, print.config)
    } catch {
      return true
    }
  }
  return print.name === '' || list.length === 0 || list.includes(print.name)
}

/**
 * The shared library's exclusions: for each product of the library that lists no printers, the printers (and models) a
 * maker's preset of the same product names. Keyed by product name (Orca's alias, the preset name before ` @`).
 */
export function libraryExclusions(files: readonly VendorFile[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const library = files.find((f) => f.vendor === FILAMENT_LIBRARY_VENDOR)
  if (!library) return out
  for (const [family, fam] of Object.entries(library.families)) {
    for (const variant of Object.keys(fam.variants)) {
      const p = resolveFilamentPreset(library, family, variant)
      if (p && p.compatiblePrinters.length === 0) out.set(family, new Set())
    }
  }
  for (const file of files) {
    if (file.vendor === FILAMENT_LIBRARY_VENDOR) continue
    for (const [family, fam] of Object.entries(file.families)) {
      const set = out.get(family)
      if (!set) continue
      for (const variant of Object.keys(fam.variants)) {
        const p = resolveFilamentPreset(file, family, variant)
        if (p) for (const n of p.compatiblePrinters) set.add(n)
      }
    }
  }
  return out
}

export interface OfferedFilament {
  vendor: string
  family: string
  variant: string
  /** The profile name, such as `Bambu PLA Basic @BBL X1C`. */
  name: string
  preset: FilamentPreset
}

/**
 * Every filament preset the printer offers from the given vendor files: compatible with the printer by Orca's rule and,
 * when a process is given, with that process too. Sorted by name.
 */
export function filamentsForPrinter(files: readonly VendorFile[], printer: PrinterContext, process?: { name: string; config: PrintConfig | Record<string, unknown> }): OfferedFilament[] {
  const exclusions = libraryExclusions(files)
  const out: OfferedFilament[] = []
  for (const file of files) {
    for (const [family, fam] of Object.entries(file.families)) {
      for (const variant of Object.keys(fam.variants)) {
        const preset = resolveFilamentPreset(file, family, variant)
        if (!preset) continue
        const excluded = file.vendor === FILAMENT_LIBRARY_VENDOR ? exclusions.get(family) : undefined
        if (!isCompatibleWithPrinter(preset, printer, excluded)) continue
        if (process && !isCompatibleWithPrint(preset, process)) continue
        out.push({ vendor: file.vendor, family, variant, name: preset.name, preset })
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

/**
 * The printer context for a catalog model and nozzle size, from the maker's preset name and the shipped machine settings.
 * `printer_notes` is not a setting we ship, so a condition that reads it sees the empty default unless `notes` is given.
 */
export function printerContext(modelId: string, nozzle?: number, notes?: string): PrinterContext | undefined {
  const p = printerProfile(modelId)
  const config = printerConfig(modelId, nozzle)
  if (!p || !config) return undefined
  const entry = machineEntry(modelId)
  const n = nozzle ?? p.defaultNozzle
  const name = n === p.defaultNozzle ? entry?.orca?.profile : entry?.nozzles[String(n)]?.orcaProfile
  const cfg: Record<string, unknown> = { ...(config as Record<string, unknown>) }
  if (notes !== undefined) cfg['printer_notes'] = notes
  return { name: name ?? '', isSystem: true, config: cfg }
}
