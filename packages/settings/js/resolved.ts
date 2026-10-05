// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings OrcaSlicer 2.4.2 resolves for a maker's own printer, filament and process presets (inherits chain and
// extruder variant applied), as shipped data in packages/profiles/resolved/<brand>.json: only the keys that differ from the
// schema defaults, and no G-code text (packages/profiles/gcode.json has ours). scripts/gen-resolved.ts writes the files.
import type { PrintConfig } from '@slicerx/contracts/settings'
import { printerProfile } from './profiles'

interface TierDiff { set: Record<string, unknown>; unset: string[] }
interface ResolvedPart {
  orca: { vendor: string; profile: string; process?: string; filament?: string; filamentId?: string } | null
  /** The tier stored whole; the others are differences from it. */
  base: string
  machine: Record<string, unknown>
  filament: Record<string, unknown>
  process: Record<string, Record<string, unknown> | TierDiff>
}
interface ResolvedEntry extends ResolvedPart {
  /** The other nozzle sizes Orca has presets for, by size in mm (`0.6`). The top level is the printer's default nozzle. */
  nozzles?: Record<string, ResolvedPart>
}
interface ResolvedFile { orcaApp: string; models: Record<string, ResolvedEntry> }

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'bambu-lab': () => import('@slicerx/profiles/resolved/bambu-lab.json'),
  creality: () => import('@slicerx/profiles/resolved/creality.json'),
  elegoo: () => import('@slicerx/profiles/resolved/elegoo.json'),
  prusa: () => import('@slicerx/profiles/resolved/prusa.json'),
  qidi: () => import('@slicerx/profiles/resolved/qidi.json'),
  snapmaker: () => import('@slicerx/profiles/resolved/snapmaker.json'),
  sovol: () => import('@slicerx/profiles/resolved/sovol.json'),
  voron: () => import('@slicerx/profiles/resolved/voron.json'),
}

export interface ResolvedProfile {
  /** Which Orca release the values were resolved by. */
  orcaApp: string
  orca: { vendor: string; profile: string; process?: string; filament?: string; filamentId?: string } | null
  machine: PrintConfig
  /** The maker's default filament for this printer, one extruder. */
  filament: PrintConfig
  /** The process preset of a quality tier (draft, standard, fine, extra_fine, strong). Absent tiers fall back to standard. */
  process: PrintConfig
  tier: string
}

const cache = new Map<string, Promise<ResolvedFile | undefined>>()

function load(brand: string): Promise<ResolvedFile | undefined> {
  const loader = LOADERS[brand]
  if (!loader) return Promise.resolve(undefined)
  if (!cache.has(brand)) cache.set(brand, loader().then((m) => m.default as ResolvedFile))
  return cache.get(brand)!
}

/** True when this printer model has resolved settings. Cheap; loads nothing. */
export function hasResolved(printerId: string): boolean {
  const brand = printerProfile(printerId)?.brand
  return brand !== undefined && brand in LOADERS
}

/** The nozzle sizes (mm) a printer has resolved presets for, the default one first. Loads the brand's file. */
export async function resolvedNozzles(printerId: string): Promise<number[]> {
  const p = printerProfile(printerId)
  const entry = p ? (await load(p.brand))?.models[printerId] : undefined
  if (!p || !entry) return []
  return [p.defaultNozzle, ...Object.keys(entry.nozzles ?? {}).map(Number)].sort((a, b) => (a === p.defaultNozzle ? -1 : b === p.defaultNozzle ? 1 : a - b))
}

/**
 * The shipped settings of a printer model for a quality tier and nozzle size (the printer's default nozzle when omitted),
 * or undefined when Orca has no preset for that combination.
 */
export async function resolvedProfile(printerId: string, tier: string, nozzle?: number): Promise<ResolvedProfile | undefined> {
  const profile = printerProfile(printerId)
  const brand = profile?.brand
  if (!brand) return undefined
  const top = (await load(brand))?.models[printerId]
  if (!top) return undefined
  const entry: ResolvedPart | undefined = nozzle === undefined || nozzle === profile.defaultNozzle ? top : top.nozzles?.[String(nozzle)]
  if (!entry) return undefined
  const whole = entry.process[entry.base] as Record<string, unknown>
  const t = entry.process[tier]
  let process: Record<string, unknown> = whole
  let used = entry.base
  if (tier !== entry.base && t) {
    const d = t as TierDiff
    process = { ...whole, ...d.set }
    for (const k of d.unset) delete process[k]
    used = tier
  }
  return {
    orcaApp: (await load(brand))!.orcaApp,
    orca: entry.orca,
    machine: entry.machine as unknown as PrintConfig,
    filament: entry.filament as unknown as PrintConfig,
    process: process as unknown as PrintConfig,
    tier: used,
  }
}
