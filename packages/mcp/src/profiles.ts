// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Profile catalog: SlicerX's own printer profiles and process presets (packages/settings),
// printer and filament presets from knowledge/, and the Easy intent presets.
import type { EasyGoal, SettingSection, SettingValue } from '@slicerx/contracts'
import { EASY_GOALS } from '@slicerx/contracts'
import { applyEasy, EASY_MAP, goalEasy, hasResolved, listFilamentFamilies, listPrinterProfiles, listProcessPresets, loadVendorFile, printerConfig, printerProfile, processConfig, resolvedNozzles, resolvedProfile, resolveFilamentPreset, type VendorFile } from '@slicerx/settings'
import { normalizeId, type DataStore } from './data'
import { defaultConfig, filamentLayer, layerConfig, printerLayer, sameValue } from './settings'

export type ProfileSource = 'slicerx' | 'knowledge' | 'intent' | 'stock'

export interface ProfileSummary {
  id: string
  name: string
  section: SettingSection
  source: ProfileSource
  vendor?: string
  inherits?: string
}

export interface ProfileDetail extends ProfileSummary {
  /** Keys this profile sets, with its inherits chain resolved, in schema shapes. */
  config: Record<string, SettingValue>
  chain: string[]
  unknown_keys: string[]
}

const STOCK_FILAMENT = 'stock-filament:'

/**
 * A fresh SlicerX plate's process: the Standard preset (0.20 mm) with sleipnir (variable layer height, Quality) and
 * aegis walls. The default when a slice names no process. sx plans sleipnir's layers itself, with the planner the
 * app uses, so a slice through this server gets the app's layers. It sets no supports: the slice takes them from the
 * printer (`ProfileCatalog.defaultSupports`), as the app does.
 */
export const SLICERX_DEFAULT_PROCESS = 'process:slicerx-default'
const DEFAULT_PROCESS_KEYS = { smart_layer: 'quality', wall_generator: 'aegis' } as const

/** The keys the Easy supports control writes. */
export const SUPPORT_KEYS: readonly string[] = [...new Set(EASY_MAP.rules.filter((r) => r.control === 'supports').flatMap((r) => (r.op === 'set' ? [r.key] : r.keys)))]

/** The support keys each maker's own Standard preset sets, by `<printer id>@<nozzle>`. */
async function loadMakerSupports(): Promise<Map<string, Record<string, SettingValue>>> {
  const out = new Map<string, Record<string, SettingValue>>()
  for (const p of listPrinterProfiles()) {
    if (!hasResolved(p.id)) continue
    for (const nozzle of await resolvedNozzles(p.id)) {
      const process = (await resolvedProfile(p.id, 'standard', nozzle))?.process as Record<string, SettingValue> | undefined
      if (process) out.set(`${p.id}@${nozzle}`, Object.fromEntries(SUPPORT_KEYS.filter((k) => process[k] !== undefined).map((k) => [k, process[k] as SettingValue])))
    }
  }
  return out
}

/** `stock-filament:BBL/Bambu PLA Basic @BBL A1` into its vendor folder, product and printer variant. */
function stockParts(id: string): { vendor: string; family: string; variant?: string } | undefined {
  const rest = id.slice(STOCK_FILAMENT.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const name = rest.slice(slash + 1)
  const at = name.lastIndexOf(' @')
  return at < 0 ? { vendor: rest.slice(0, slash), family: name } : { vendor: rest.slice(0, slash), family: name.slice(0, at), variant: name.slice(at + 2) }
}

export class ProfileCatalog {
  private readonly store: DataStore
  private all: ProfileSummary[] | undefined
  /** Stock filament vendor files are megabytes, so they load on first use (`prepare`). */
  private readonly vendors = new Map<string, VendorFile>()
  /** The makers' Standard presets' supports (`loadMakerSupports`), loaded on first use (`prepare`). */
  private makerLoad: Promise<Map<string, Record<string, SettingValue>>> | undefined
  private maker: Map<string, Record<string, SettingValue>> | undefined

  constructor(store: DataStore) {
    this.store = store
  }

  /**
   * Loads what `get` needs for these profiles, the vendor files of stock filament presets, and what `defaultSupports`
   * needs, the makers' process presets. Call before either.
   */
  async prepare(queries: readonly string[]): Promise<void> {
    for (const q of queries) {
      const p = this.find(q)
      const parts = p?.source === 'stock' ? stockParts(p.id) : undefined
      if (parts && !this.vendors.has(parts.vendor)) {
        const file = await loadVendorFile(parts.vendor)
        if (file) this.vendors.set(parts.vendor, file)
      }
    }
    this.makerLoad ??= loadMakerSupports()
    this.maker = await this.makerLoad
  }

  /**
   * The supports for a slice that names no process, as the app sets them on a fresh plate: with the maker's own Standard
   * preset for this printer and nozzle, that preset's (the schema defaults for the keys it leaves out, so off on Bambu
   * Lab's); with no printer, or one the makers ship no preset for, SlicerX's Standard tier's.
   */
  defaultSupports(printer: { printerId: string; nozzle?: number | undefined } | undefined): Record<string, SettingValue> {
    if (!this.maker) throw new Error('ProfileCatalog.prepare must run before defaultSupports')
    const nozzle = printer ? (printer.nozzle ?? printerProfile(printer.printerId)?.defaultNozzle) : undefined
    const own = printer ? this.maker.get(`${printer.printerId}@${nozzle}`) : undefined
    const from = own ? { ...defaultConfig(this.store), ...own } : (processConfig('standard') as unknown as Record<string, SettingValue>)
    return Object.fromEntries(SUPPORT_KEYS.flatMap((k) => (from[k] === undefined ? [] : [[k, from[k] as SettingValue]])))
  }

  /** The printer model a printer profile stands for: `machine:<id>` itself, a knowledge printer by its name. */
  printerModel(query: string): string | undefined {
    const p = this.find(query)
    if (p?.section !== 'printer') return undefined
    if (p.id.startsWith('machine:')) return p.id.slice('machine:'.length)
    return listPrinterProfiles().find((m) => `${m.vendor} ${m.model}` === p.name || m.model === p.name)?.id
  }

  list(): ProfileSummary[] {
    if (this.all) return this.all
    const out: ProfileSummary[] = []
    for (const e of this.store.knowledge()) {
      if (e.kind === 'printer') out.push({ id: `printer:${e.id}`, name: e.name, section: 'printer', source: 'knowledge', ...(typeof e.data['vendor'] === 'string' ? { vendor: e.data['vendor'] } : {}) })
      if (e.kind === 'filament') out.push({ id: `filament:${e.id}`, name: e.name, section: 'filament', source: 'knowledge' })
    }
    out.push({ id: SLICERX_DEFAULT_PROCESS, name: 'SlicerX default (Standard 0.20 mm, sleipnir, aegis walls)', section: 'process', source: 'slicerx' })
    for (const goal of Object.keys(EASY_GOALS) as EasyGoal[]) out.push({ id: `intent:${goal}`, name: `${goal[0]?.toUpperCase() ?? ''}${goal.slice(1)} (Easy goal)`, section: 'process', source: 'intent' })
    for (const p of listPrinterProfiles()) out.push({ id: `machine:${p.id}`, name: `${p.vendor} ${p.model}`, section: 'printer', source: 'slicerx', vendor: p.vendor })
    for (const t of listProcessPresets()) out.push({ id: `process:${t.id}`, name: t.label, section: 'process', source: 'slicerx' })
    // The makers' own filament presets (Bambu Lab, Polymaker and the rest), one per product and printer variant.
    for (const f of listFilamentFamilies()) {
      for (const v of f.variants) {
        const name = v ? `${f.family} @${v}` : f.family
        out.push({ id: `${STOCK_FILAMENT}${f.vendor}/${name}`, name, section: 'filament', source: 'stock', vendor: f.brand || f.vendor })
      }
    }
    this.all = out
    return out
  }

  /** Finds a profile by id (`printer:bambu_x1c`, `machine:bambu-x1-carbon`, `process:standard`), exact name, or a loose name match. */
  find(query: string): ProfileSummary | undefined {
    const all = this.list()
    const q = normalizeId(query)
    return (
      all.find((p) => p.id === query) ??
      all.find((p) => p.name === query) ??
      all.find((p) => normalizeId(p.id.slice(p.id.indexOf(':') + 1)) === q) ??
      all.find((p) => normalizeId(p.name) === q)
    )
  }

  get(query: string): ProfileDetail | undefined {
    const summary = this.find(query)
    if (!summary) return undefined
    const [kind, ...rest] = summary.id.split(':')
    const id = rest.join(':')
    if (kind === 'printer' || kind === 'filament') {
      const entry = this.store.findKnowledge([kind], id)
      if (!entry) return undefined
      const layer = kind === 'printer' ? printerLayer(this.store, entry) : filamentLayer(this.store, entry)
      return { ...summary, config: layerConfig(layer), chain: [summary.name], unknown_keys: [] }
    }
    if (kind === 'intent') {
      const base = defaultConfig(this.store)
      const after = applyEasy(goalEasy(id as EasyGoal), base)
      const config = Object.fromEntries(Object.entries(after).filter(([k, v]) => !sameValue(base[k], v)))
      return { ...summary, config, chain: [summary.name], unknown_keys: [] }
    }
    if (kind === 'machine') {
      const config = printerConfig(id)
      return config && printerProfile(id) ? { ...summary, config: config as unknown as Record<string, SettingValue>, chain: [summary.name], unknown_keys: [] } : undefined
    }
    if (summary.source === 'stock') {
      const parts = stockParts(summary.id)
      const file = parts ? this.vendors.get(parts.vendor) : undefined
      const preset = parts && file ? resolveFilamentPreset(file, parts.family, parts.variant) : undefined
      return preset ? { ...summary, config: preset.config as unknown as Record<string, SettingValue>, chain: [preset.name], unknown_keys: Object.keys(preset.extras).sort() } : undefined
    }
    if (summary.id === SLICERX_DEFAULT_PROCESS) {
      const config = processConfig('standard') as unknown as Record<string, SettingValue> | undefined
      const own = config ? Object.fromEntries(Object.entries(config).filter(([k]) => !SUPPORT_KEYS.includes(k))) : undefined
      return own ? { ...summary, config: { ...own, ...DEFAULT_PROCESS_KEYS }, chain: ['Standard', summary.name], unknown_keys: [] } : undefined
    }
    if (kind === 'process') {
      const config = processConfig(id)
      return config ? { ...summary, config: config as unknown as Record<string, SettingValue>, chain: [summary.name], unknown_keys: [] } : undefined
    }
    return undefined
  }
}
