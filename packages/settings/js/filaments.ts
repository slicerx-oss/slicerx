// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Filament presets per brand: the values of OrcaSlicer 2.4.2's filament profiles, as facts. A preset 2.4.2 does not have
// keeps its values from OrcaSlicer main (or Bambu Studio for Bambu Lab) and is listed in its vendor file under `fallback`. `packages/profiles/filaments/<vendor>.json` holds one file per vendor folder:
// the vendor's common values, each product family's own values and each printer variant's differences.
// Values are Orca-format strings; `resolveFilamentPreset` merges them and `importFlat` types them.
// src/filaments.rs does the same.
import type { PrintConfig } from '@slicerx/contracts/settings'
import index from '@slicerx/profiles/filaments/index.json'
import { importFlat } from './import'

export interface FilamentFamilyInfo {
  /** The vendor folder the presets live in (`BBL`, `OrcaFilamentLibrary`, `Prusa`, ...). */
  vendor: string
  /** The product, such as `Bambu PLA Basic` or `Polymaker PolyTerra PLA`. */
  family: string
  /** The brand as the profile names it, such as `Bambu Lab` or `Polymaker`. */
  brand: string
  /** The material, such as `PLA`, `PETG` or `TPU`. */
  type: string
  /** The printer variants the product has presets for, such as `BBL X1C` or `System`. */
  variants: string[]
}

export interface VendorFile {
  source: string
  commit: string
  vendor: string
  /** Presets OrcaSlicer 2.4.2 does not have, by profile name, with the source their values come from (`OrcaSlicer main 97700c5a`). */
  fallback?: Record<string, string>
  common: Record<string, unknown>
  families: Record<string, { base: Record<string, unknown>; variants: Record<string, Record<string, unknown> | undefined> }>
}

export interface FilamentPreset {
  vendor: string
  family: string
  variant: string
  /** The profile name, such as `Bambu PLA Basic @BBL X1C`. */
  name: string
  brand: string
  type: string
  /** Settings the schema knows, typed. */
  config: PrintConfig
  /** The maker's material id (the AMS id for Bambu Lab). */
  filamentId: string
  /** Keys only some slicers define, in the profile's own value format. */
  extras: Record<string, unknown>
  compatiblePrinters: string[]
  /** `compatible_printers_condition`, used only when `compatiblePrinters` is empty. */
  compatiblePrintersCondition: string
  /** Process presets (by name) the preset is limited to, and the condition that is used when the list is empty. */
  compatiblePrints: string[]
  compatiblePrintsCondition: string
  /** Which app's profile the values come from, and its commit. */
  source: { app: string; commit: string }
}

const INDEX = index as unknown as { orcaCommit: string; orcaMainCommit: string; bambuStudioCommit: string; presets: number; families: FilamentFamilyInfo[] }
/** The commits the presets come from: OrcaSlicer 2.4.2, plus OrcaSlicer main and Bambu Studio for presets 2.4.2 lacks. */
export const FILAMENT_SOURCES = { orcaSlicer: INDEX.orcaCommit, orcaMain: INDEX.orcaMainCommit, bambuStudio: INDEX.bambuStudioCommit }

export function listFilamentFamilies(filter: { vendor?: string; brand?: string; type?: string } = {}): FilamentFamilyInfo[] {
  return INDEX.families
    .filter((f) => (!filter.vendor || f.vendor === filter.vendor) && (!filter.brand || f.brand === filter.brand) && (!filter.type || f.type === filter.type))
    .map((f) => ({ ...f, variants: [...f.variants] }))
}

/** Every brand that has presets, sorted. */
export function filamentBrands(): string[] {
  return [...new Set(INDEX.families.map((f) => f.brand))].sort((a, b) => a.localeCompare(b, 'en'))
}

export function filamentPresetCount(): number {
  return INDEX.presets
}

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  BBL: () => import('@slicerx/profiles/filaments/BBL.json'),
  OrcaFilamentLibrary: () => import('@slicerx/profiles/filaments/OrcaFilamentLibrary.json'),
  Prusa: () => import('@slicerx/profiles/filaments/Prusa.json'),
  Creality: () => import('@slicerx/profiles/filaments/Creality.json'),
  Elegoo: () => import('@slicerx/profiles/filaments/Elegoo.json'),
  Qidi: () => import('@slicerx/profiles/filaments/Qidi.json'),
  Snapmaker: () => import('@slicerx/profiles/filaments/Snapmaker.json'),
  Sovol: () => import('@slicerx/profiles/filaments/Sovol.json'),
  FLSun: () => import('@slicerx/profiles/filaments/FLSun.json'),
}

/** One vendor's preset file, loaded on first use. */
export async function loadVendorFile(vendor: string): Promise<VendorFile | undefined> {
  const load = LOADERS[vendor]
  return load ? ((await load()).default as VendorFile) : undefined
}

/** The merged values of one preset in the profile's own format: common, then the product, then the variant. */
export function resolveFilamentRaw(file: VendorFile, family: string, variant: string): Record<string, unknown> | undefined {
  const fam = file.families[family]
  const diff = fam?.variants[variant]
  if (!fam || diff === undefined) return undefined
  const out: Record<string, unknown> = { ...file.common, ...fam.base }
  for (const [k, v] of Object.entries(diff)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/** A preset from an already loaded vendor file. `variant` defaults to the product's first one. */
export function resolveFilamentPreset(file: VendorFile, family: string, variant?: string): FilamentPreset | undefined {
  const fam = file.families[family]
  if (!fam) return undefined
  const v = variant ?? Object.keys(fam.variants).sort()[0] ?? ''
  const raw = resolveFilamentRaw(file, family, v)
  if (!raw) return undefined
  const imported = importFlat(raw)
  const extras: Record<string, unknown> = {}
  for (const k of [...imported.unknownKeys, ...imported.ignoredKeys, ...imported.invalidKeys]) if (k in raw) extras[k] = raw[k]
  const first = (x: unknown): string => (Array.isArray(x) ? String(x[0] ?? '') : typeof x === 'string' ? x : '')
  return {
    vendor: file.vendor,
    family,
    variant: v,
    name: v ? `${family} @${v}` : family,
    brand: first(raw['filament_vendor']),
    type: first(raw['filament_type']),
    filamentId: first(raw['filament_id']),
    config: imported.config,
    extras,
    compatiblePrinters: Array.isArray(raw['compatible_printers']) ? (raw['compatible_printers'] as string[]) : [],
    compatiblePrintersCondition: typeof raw['compatible_printers_condition'] === 'string' ? raw['compatible_printers_condition'] : '',
    compatiblePrints: Array.isArray(raw['compatible_prints']) ? (raw['compatible_prints'] as string[]) : [],
    compatiblePrintsCondition: typeof raw['compatible_prints_condition'] === 'string' ? raw['compatible_prints_condition'] : '',
    source: sourceOf(file, v ? `${family} @${v}` : family),
  }
}

function sourceOf(file: VendorFile, name: string): { app: string; commit: string } {
  const fb = file.fallback?.[name]
  if (!fb) return { app: file.source, commit: file.commit }
  const cut = fb.lastIndexOf(' ')
  return { app: fb.slice(0, cut), commit: fb.slice(cut + 1) }
}

export async function loadFilamentPreset(vendor: string, family: string, variant?: string): Promise<FilamentPreset | undefined> {
  const file = await loadVendorFile(vendor)
  return file ? resolveFilamentPreset(file, family, variant) : undefined
}
