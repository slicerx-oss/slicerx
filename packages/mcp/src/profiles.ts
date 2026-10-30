// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Profile catalog: SlicerX's own printer profiles and process presets (packages/settings), the machine, default
// filament and process for each tier a printer's maker ships where there are some (as the app takes them), printer and
// filament presets from knowledge/, and the Easy intent presets.
import type { EasyGoal, PrintConfig, SettingSection, SettingValue, SmartLayerMode } from '@slicerx/contracts'
import { EASY_GOALS, productName } from '@slicerx/contracts'
import { applyEasy, EASY_MAP, gcodeStatus, goalEasy, hasResolved, listFilamentFamilies, listPrinterProfiles, listProcessPresets, loadVendorFile, presetDefaults, printerConfig, printerProfile, processConfig, resolvedNozzles, resolveFilamentPreset, stockPrinter, stockProcess, type StockPrinter, type VendorFile } from '@slicerx/settings'
import { normalizeId, type DataStore } from './data'
import { defaultConfig, filamentLayer, layerConfig, printerLayer, printerProfileByName, sameValue } from './settings'

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
  /** Its G-code is the text SlicerX ships for the printer (shippedPrinterGcode), though the profile itself is not SlicerX's. */
  shippedGcode?: boolean
}

/**
 * The G-code SlicerX ships for a knowledge printer: start, end, layer change, filament change and the rest, from its
 * own profile of the printer of that name (printerProfileByName), the text `machine:<id>` gives and the app prints
 * with. Only once SlicerX has written G-code for that model (gcodeStatus). A printer linked to a profile of another
 * model (printerProfileFor) takes only that model's name and clearances, not its G-code, so it gets none here.
 */
export function shippedPrinterGcode(name: string): Record<string, SettingValue> {
  const id = printerProfileByName(name)
  if (!id || gcodeStatus(id) !== 'written') return {}
  const config = (printerConfig(id) ?? {}) as unknown as Record<string, unknown>
  // the G-code settings, as config.ts isGcodeKey names them
  return Object.fromEntries(Object.entries(config).filter((e): e is [string, string] => e[0].endsWith('_gcode') && typeof e[1] === 'string'))
}

const STOCK_FILAMENT = 'stock-filament:'

/**
 * A fresh SlicerX plate's process: the printer's Standard process as the app takes it (the maker's own preset where
 * there is one, else SlicerX's Standard, 0.20 mm), with sleipnir (variable layer height, Quality) and SlicerX's preset
 * defaults (aegis walls; a Bambu Lab printer keeps its process's own walls, as in the app). The default when a slice
 * names no process. sx plans sleipnir's layers itself, with the planner the
 * app uses, so a slice through this server gets the app's layers. It sets no supports: the slice takes them from the
 * printer (`ProfileCatalog.defaultSupports`), as the app does.
 */
export const SLICERX_DEFAULT_PROCESS = 'process:slicerx-default'
const DEFAULT_PROCESS_KEYS = { smart_layer: 'quality' } as const

/** The keys the Easy supports control writes. */
export const SUPPORT_KEYS: readonly string[] = [...new Set(EASY_MAP.rules.filter((r) => r.control === 'supports').flatMap((r) => (r.op === 'set' ? [r.key] : r.keys)))]

const TIER_IDS = Object.keys(EASY_GOALS) as EasyGoal[]

/**
 * Each tier's process on each printer with the makers' presets, by `<printer id>@<nozzle>:<tier>`: the maker's own
 * preset where there is one, as the app's printer layer takes it (stockProcess). A printer or nozzle with none has no
 * entry here and gets SlicerX's tier for the printer (processConfig), which is what the app falls back to as well.
 */
async function loadMakerProcesses(): Promise<Map<string, Record<string, SettingValue>>> {
  const out = new Map<string, Record<string, SettingValue>>()
  for (const p of listPrinterProfiles()) {
    if (!hasResolved(p.id)) continue
    for (const nozzle of await resolvedNozzles(p.id)) {
      for (const tier of TIER_IDS) out.set(`${p.id}@${nozzle}:${tier}`, await stockProcess(p.id, tier, nozzle))
    }
  }
  return out
}

/**
 * Each printer's machine and default filament for each nozzle the app offers for it, by `<printer id>@<nozzle>`, as the
 * app's printer layer takes them (stockPrinter): the maker's resolved machine and default filament where there are
 * some, else SlicerX's printer profile and the generic PLA.
 */
async function loadStockPrinters(): Promise<Map<string, StockPrinter>> {
  const out = new Map<string, StockPrinter>()
  for (const p of listPrinterProfiles()) {
    for (const nozzle of p.nozzles) {
      const stock = await stockPrinter(p.id, nozzle)
      if (stock) out.set(`${p.id}@${nozzle}`, stock)
    }
  }
  return out
}

/** The sleipnir bounds keys, which the app works out over the whole layer. */
const SLEIPNIR_BOUNDS = ['smart_layer_min_height', 'smart_layer_max_height'] as const

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
  /** The makers' process presets by printer, nozzle and tier (`loadMakerProcesses`), loaded on first use (`prepare`). */
  private makerLoad: Promise<Map<string, Record<string, SettingValue>>> | undefined
  private maker: Map<string, Record<string, SettingValue>> | undefined
  /** Each printer's machine and default filament by printer and nozzle (`loadStockPrinters`), loaded on first use (`prepare`). */
  private printersLoad: Promise<Map<string, StockPrinter>> | undefined
  private printers: Map<string, StockPrinter> | undefined

  constructor(store: DataStore) {
    this.store = store
  }

  /**
   * Loads what `get` needs for these profiles, the vendor files of stock filament presets, and what `defaultSupports`
   * and `defaultFilament` need, the makers' process presets and each printer's machine and default filament. Call
   * before any of them.
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
    this.makerLoad ??= loadMakerProcesses()
    this.printersLoad ??= loadStockPrinters()
    this.maker = await this.makerLoad
    this.printers = await this.printersLoad
  }

  /**
   * The filament a slice that names none gets, as the app gives a fresh plate's slot on this printer: the maker's default
   * filament for the printer where there is one, else the generic PLA. None without a printer, or on a nozzle the app
   * does not offer for it, which keep the schema's filament.
   */
  defaultFilament(printer: { printerId: string; nozzle?: number | undefined } | undefined): { name: string; config: Record<string, SettingValue> } | undefined {
    if (!this.printers) throw new Error('ProfileCatalog.prepare must run before defaultFilament')
    const stock = printer ? this.stockPrinter(printer.printerId, printer.nozzle) : undefined
    return stock ? { name: stock.filamentName, config: { ...stock.filament } } : undefined
  }

  /** The app's machine and default filament for a printer on a nozzle it offers (its default when none is given), from `prepare`. */
  private stockPrinter(printerId: string, nozzle: number | undefined): StockPrinter | undefined {
    const mm = nozzle ?? printerProfile(printerId)?.defaultNozzle
    return this.printers?.get(`${printerId}@${mm}`)
  }

  /**
   * The supports for a slice that names no process, as the app sets them on a fresh plate: with the maker's own Standard
   * preset for this printer and nozzle, that preset's (the schema defaults for the keys it leaves out, so off on Bambu
   * Lab's); with no printer, or one the makers ship no preset for, SlicerX's Standard tier's.
   */
  defaultSupports(printer: { printerId: string; nozzle?: number | undefined } | undefined): Record<string, SettingValue> {
    if (!this.maker) throw new Error('ProfileCatalog.prepare must run before defaultSupports')
    const nozzle = printer ? (printer.nozzle ?? printerProfile(printer.printerId)?.defaultNozzle) : undefined
    const own = printer ? this.maker.get(`${printer.printerId}@${nozzle}:standard`) : undefined
    const from = own ? { ...defaultConfig(this.store), ...own } : (processConfig('standard') as unknown as Record<string, SettingValue>)
    return Object.fromEntries(SUPPORT_KEYS.flatMap((k) => (from[k] === undefined ? [] : [[k, from[k] as SettingValue]])))
  }

  /**
   * The printer model a printer profile stands for, whose process and supports a slice of it starts from: `machine:<id>`
   * itself, a knowledge printer by its name. A knowledge printer linked to a profile of another name (printerProfileFor)
   * takes only its model and clearances from it, in its printer layer.
   */
  printerModel(query: string): string | undefined {
    const p = this.find(query)
    if (p?.section !== 'printer') return undefined
    if (p.id.startsWith('machine:')) return p.id.slice('machine:'.length)
    return printerProfileByName(p.name)
  }

  list(): ProfileSummary[] {
    if (this.all) return this.all
    const out: ProfileSummary[] = []
    for (const e of this.store.knowledge()) {
      if (e.kind === 'printer') out.push({ id: `printer:${e.id}`, name: e.name, section: 'printer', source: 'knowledge', ...(typeof e.data['vendor'] === 'string' ? { vendor: e.data['vendor'] } : {}) })
      if (e.kind === 'filament') out.push({ id: `filament:${e.id}`, name: e.name, section: 'filament', source: 'knowledge' })
    }
    out.push({ id: SLICERX_DEFAULT_PROCESS, name: `${productName()} default (Standard 0.20 mm, sleipnir, aegis walls)`, section: 'process', source: 'slicerx' })
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

  /** Process tiers use the slice's printer and nozzle when known; a standalone lookup stays generic. */
  get(query: string, printer?: { printerId: string; nozzle?: number | undefined }): ProfileDetail | undefined {
    const summary = this.find(query)
    if (!summary) return undefined
    const [kind, ...rest] = summary.id.split(':')
    const id = rest.join(':')
    if (kind === 'printer' || kind === 'filament') {
      const entry = this.store.findKnowledge([kind], id)
      if (!entry) return undefined
      const layer = kind === 'printer' ? printerLayer(this.store, entry) : filamentLayer(this.store, entry)
      const gcode = kind === 'printer' ? shippedPrinterGcode(entry.name) : {}
      const shipped = Object.keys(gcode).length > 0
      return { ...summary, config: { ...layerConfig(layer), ...gcode }, chain: [summary.name], unknown_keys: [], ...(shipped ? { shippedGcode: true } : {}) }
    }
    if (kind === 'intent') {
      const base = defaultConfig(this.store)
      const after = applyEasy(goalEasy(id as EasyGoal), base)
      const config = Object.fromEntries(Object.entries(after).filter(([k, v]) => !sameValue(base[k], v)))
      return { ...summary, config, chain: [summary.name], unknown_keys: [] }
    }
    if (kind === 'machine') {
      // The app's machine for the printer and nozzle (the maker's where there is one), from `prepare`. A nozzle the app
      // does not offer has no app answer, so it keeps SlicerX's printer profile, as before.
      const stock = this.stockPrinter(id, printer?.printerId === id ? printer.nozzle : undefined)
      const config = stock?.machine ?? (printerConfig(id) as unknown as Record<string, SettingValue> | undefined)
      return config && printerProfile(id) ? { ...summary, config: { ...config }, chain: [summary.name], unknown_keys: [] } : undefined
    }
    if (summary.source === 'stock') {
      const parts = stockParts(summary.id)
      const file = parts ? this.vendors.get(parts.vendor) : undefined
      const preset = parts && file ? resolveFilamentPreset(file, parts.family, parts.variant) : undefined
      return preset ? { ...summary, config: preset.config as unknown as Record<string, SettingValue>, chain: [preset.name], unknown_keys: Object.keys(preset.extras).sort() } : undefined
    }
    const nozzle = printer?.nozzle ?? (printer ? printerProfile(printer.printerId)?.defaultNozzle : undefined) ?? 0.4
    if (summary.id === SLICERX_DEFAULT_PROCESS) {
      const config = this.tierConfig('standard', nozzle, printer)
      const own = config ? Object.fromEntries(Object.entries(config).filter(([k]) => !SUPPORT_KEYS.includes(k))) : undefined
      // SlicerX's own preset defaults go over the process, as the app's layer puts them (layerConfig): aegis walls, a
      // Bambu Lab printer keeping its process's own (its presets' classic ones).
      const machine = printer ? (printerConfig(printer.printerId, nozzle) as unknown as Record<string, unknown> | undefined) : undefined
      return own ? { ...summary, config: this.onPrinter({ ...own, ...DEFAULT_PROCESS_KEYS, ...presetDefaults(machine ?? {}) }, printer, nozzle), chain: ['Standard', summary.name], unknown_keys: [] } : undefined
    }
    if (kind === 'process') {
      const config = this.tierConfig(id, nozzle, printer)
      if (!config) return undefined
      // On a printer, SlicerX's own preset defaults go over the maker's process, as the app's layer puts them
      // (layerConfig): aegis walls, a Bambu Lab printer's presets keeping their classic ones.
      const machine = printer ? (printerConfig(printer.printerId, nozzle) as unknown as Record<string, unknown> | undefined) : undefined
      return { ...summary, config: printer ? this.onPrinter({ ...config, ...presetDefaults(machine ?? {}) }, printer, nozzle) : config, chain: [summary.name], unknown_keys: [] }
    }
    return undefined
  }

  /**
   * A process under a printer's machine, as the app's layer has it: the machine's own settings stay the machine's (the app
   * puts the machine over the process, so `process:<tier>` named after `machine:<id>` no longer sets a dual nozzle
   * printer's `nozzle_diameter` back to one nozzle), and sleipnir's bounds come from the Easy rule over the whole layer,
   * the printer's nozzle with the process's layer height. Only on a nozzle the app offers for the printer.
   */
  private onPrinter(config: Record<string, SettingValue>, printer: { printerId: string } | undefined, nozzle: number): Record<string, SettingValue> {
    const stock = printer ? this.stockPrinter(printer.printerId, nozzle) : undefined
    if (!stock || stock.nozzle !== nozzle) return config
    const own = Object.fromEntries(Object.entries(config).filter(([k]) => !(k in stock.machine)))
    const defaults = defaultConfig(this.store)
    const mode = [own['smart_layer'] ?? defaults['smart_layer']].flat()[0]
    if (typeof mode !== 'string' || mode === 'off') return own
    // The Easy rule for the bounds in the process's own sleipnir mode (a mode with no Vary switch keeps that mode).
    const { detail, strength, speed, supports, brim } = goalEasy('standard')
    const base = { ...defaults, ...stock.machine, ...own } as unknown as PrintConfig
    const layer = applyEasy({ detail, strength, speed, supports, brim, smartLayer: mode as SmartLayerMode }, base, new Set(['varyLayerHeight'])) as unknown as Record<string, SettingValue>
    for (const k of SLEIPNIR_BOUNDS) if (layer[k] !== undefined) own[k] = layer[k]
    return own
  }

  /**
   * A tier's process: on a printer and a nozzle the app offers for it, the app's (the maker's own preset for the tier
   * and nozzle where it has one, from `prepare`), else SlicerX's tier for the printer and nozzle, or the generic tier
   * without a printer. A nozzle the app does not offer (a printer file's or an override's) has no app answer, so it
   * keeps SlicerX's tier for the size.
   */
  private tierConfig(tier: string, nozzle: number, printer: { printerId: string } | undefined): Record<string, SettingValue> | undefined {
    const offered = printer ? (printerProfile(printer.printerId)?.nozzles ?? []).includes(nozzle) : false
    const own = offered && this.maker?.get(`${printer!.printerId}@${nozzle}:${tier}`)
    if (own) return { ...own }
    return processConfig(tier, nozzle, printer?.printerId) as unknown as Record<string, SettingValue> | undefined
  }
}
