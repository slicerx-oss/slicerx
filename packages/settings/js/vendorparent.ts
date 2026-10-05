// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The maker profile an OrcaSlicer or Bambu Studio user preset inherits from, found by its name in the profiles SlicerX
// ships: printers by their Orca machine profile name, process presets by the maker's quality preset name, filaments by
// `<product> @<variant>` in the filament library. Used when a user preset comes in without its parents.
import type { PrintConfig, SettingSection } from '@slicerx/contracts/settings'
import machineJson from '@slicerx/profiles/machine.json'
import speedsJson from '@slicerx/profiles/process-speeds.json'
import { listFilamentFamilies, loadVendorFile, resolveFilamentRaw } from './filaments'
import { importFlat } from './import'
import { listPrinterProfiles, printerConfig, printerProfile, processConfig } from './profiles'
import { hasResolved, resolvedProfile } from './resolved'

export interface VendorParent {
  /** The profile's name, as the preset names it. */
  name: string
  config: PrintConfig
  /** The printer model the profile is for, when it names one. */
  printerId?: string
  nozzle?: number
}

interface MachineFile { models: Record<string, { orca?: { profile: string }; nozzles: Record<string, { orcaProfile: string }> }> }
const MACHINES = (machineJson as unknown as MachineFile).models
const SPEED_MODELS = (speedsJson as unknown as { models: Record<string, Record<string, string>> }).models

const tail = (src: string): string => src.slice(src.lastIndexOf('/') + 1)

/** The printer model and nozzle a machine profile name stands for, such as `Bambu Lab A1 0.4 nozzle`. */
export function printerForProfile(name: string): { printerId: string; nozzle: number } | undefined {
  for (const p of listPrinterProfiles()) {
    const m = MACHINES[p.id]
    if (!m) continue
    if (m.orca?.profile === name) return { printerId: p.id, nozzle: p.defaultNozzle }
    for (const [n, v] of Object.entries(m.nozzles)) if (v.orcaProfile === name) return { printerId: p.id, nozzle: Number(n) }
  }
  return undefined
}

/** The printer model and quality tier a maker process preset name stands for, such as `0.20mm Standard @BBL A1M`. */
export function processForProfile(name: string): { printerId: string; tier: string; nozzle?: number } | undefined {
  for (const [printerId, tiers] of Object.entries(SPEED_MODELS)) {
    for (const [tier, src] of Object.entries(tiers)) if (tail(src) === name) return { printerId, tier }
  }
  // A nozzle other than 0.4 mm: `<preset> 0.6 nozzle`, from the printer's other nozzle presets.
  const m = /^(.*) (\d+(?:\.\d+)?) nozzle$/.exec(name)
  if (m) {
    const base = processForProfile(m[1] as string)
    if (base) return { ...base, nozzle: Number(m[2]) }
  }
  return undefined
}

/** The printer model a preset name points at through its `@` suffix (`Bambu PLA Basic @BBL A1M`), when one matches. */
export function printerForPresetName(name: string): string | undefined {
  const at = name.lastIndexOf('@')
  if (at < 0) return undefined
  const suffix = name.slice(at + 1).trim()
  for (const [printerId, tiers] of Object.entries(SPEED_MODELS)) {
    for (const src of Object.values(tiers)) {
      const t = tail(src)
      const i = t.lastIndexOf('@')
      if (i >= 0 && t.slice(i + 1).trim() === suffix) return printerId
    }
  }
  return printerForProfile(suffix)?.printerId
}

async function filamentParent(name: string): Promise<VendorParent | undefined> {
  const at = name.lastIndexOf(' @')
  if (at < 0) return undefined
  const family = name.slice(0, at)
  const variant = name.slice(at + 2)
  for (const f of listFilamentFamilies()) {
    if (f.family !== family || !f.variants.includes(variant)) continue
    const file = await loadVendorFile(f.vendor)
    const raw = file ? resolveFilamentRaw(file, family, variant) : undefined
    if (!raw) continue
    const printerId = printerForPresetName(name)
    return { name, config: importFlat(raw).config, ...(printerId ? { printerId } : {}) }
  }
  return undefined
}

/** The maker profile of a kind by name, or undefined when SlicerX does not ship it. */
export async function vendorParent(kind: SettingSection, name: string): Promise<VendorParent | undefined> {
  if (kind === 'printer') {
    const at = printerForProfile(name)
    const config = at ? printerConfig(at.printerId, at.nozzle) : undefined
    return at && config ? { name, config, printerId: at.printerId, nozzle: at.nozzle } : undefined
  }
  if (kind === 'process') {
    const at = processForProfile(name)
    if (!at) return undefined
    const resolved = hasResolved(at.printerId) ? await resolvedProfile(at.printerId, at.tier, at.nozzle) : undefined
    const config = resolved?.process ?? processConfig(at.tier, at.nozzle ?? 0.4, at.printerId)
    return config ? { name, config, printerId: at.printerId, ...(at.nozzle ? { nozzle: at.nozzle } : {}) } : undefined
  }
  return filamentParent(name)
}

/** A printer model's name as people say it: `Bambu Lab A1 mini`. */
export function printerName(printerId: string): string {
  const p = printerProfile(printerId)
  if (!p) return printerId
  return p.model.toLowerCase().startsWith((p.vendor.split(' ')[0] ?? '').toLowerCase()) ? p.model : `${p.vendor} ${p.model}`
}
