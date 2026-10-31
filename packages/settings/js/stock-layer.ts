// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selected printer, filament and process presets as one layer under the Easy choices: the maker's printer
// (bed, speeds, accelerations, machine limits, retraction), the filament in each slot and the quality tier's
// process, resolved the way OrcaSlicer 2.4.2 resolves them (packages/profiles/resolved), plus the G-code
// written for SlicerX. The app builds its printer layer from it, and the MCP server builds the same layer under a
// project's settings, so one project on one printer slices the same in both.
import type { EasyGoal, SettingValue } from '@slicerx/contracts/settings'
import { isCompatibleWithPrinter, type PrinterContext } from './compat'
import { settingDefault } from './defaults'
import { listFilamentFamilies, loadVendorFile, resolveFilamentPreset, type VendorFile } from './filaments'
import { filamentConfig, gcodeStatus, listFilamentProfiles, printerConfig, printerProfile, processConfig } from './profiles'
import { resolvedProfile } from './resolved'

export interface SlotFilament {
  /** Material type: PLA, PETG, TPU. */
  type: string
  /** A shipped filament product the slot was matched to, when there is one. */
  vendor?: string
  family?: string
  /** The printer variant of the product, such as `BBL X1C` or `System`. Picked from the printer when absent. */
  variant?: string
}

export interface StockLayerInput {
  /** A printer profile id, such as `prusa-mk4`. */
  printerId: string
  tier: EasyGoal
  slots: readonly SlotFilament[]
  /** The nozzle size in mm. The printer's default when absent. */
  nozzle?: number | undefined
  /** Each extruder's nozzle on a printer with more than one, in the slicer's extruder order (left first on an H2D). */
  extruders?: readonly { mm: number; type?: string }[] | undefined
}

export interface StockLayer {
  printerId: string
  nozzle: number
  nozzles: number[]
  tier: EasyGoal
  /** Where the settings come from: Orca's resolved system presets, or our own profile for models Orca has no preset for. */
  source: 'orca' | 'slicerx'
  values: Record<string, SettingValue>
  limits: { nozzleMaxC?: number; bedMaxC?: number }
  /** The custom G-code in this layer is the shipped text for the model, so the engine may trust it. */
  shippedGcode: boolean
  /** Keys that carry G-code text, so a user override of one can withdraw the trust. */
  gcodeKeys: string[]
  /** Each slot's filament preset id (`filament_id`, such as `GFA00`), in slot order; empty where no shipped preset applies. */
  filamentIds: string[]
  /** The material of the maker's default filament for the printer (PLA, PETG), empty without a resolved preset. */
  materialType: string
  /** The layer height and walls each goal's process gives on this printer and nozzle, for the Goal tiles. */
  goalValues: Record<EasyGoal, Record<string, SettingValue>>
}

const ORCA_NOZZLE_TYPE: Record<string, string> = { brass: 'brass', 'hardened-steel': 'hardened_steel', 'stainless-steel': 'stainless_steel', 'tungsten-carbide': 'tungsten_carbide' }

/** Writes each extruder's own nozzle diameter and type over the machine's, where the machine lists one per extruder. */
export function applyExtruders(machine: Record<string, SettingValue>, extruders: readonly { mm: number; type?: string }[] | undefined): void {
  if (!extruders || extruders.length < 2) return
  const d = machine['nozzle_diameter']
  if (Array.isArray(d) && d.length === extruders.length) {
    machine['nozzle_diameter'] = typeof d[0] === 'number' ? extruders.map((e) => e.mm) : extruders.map((e) => String(e.mm))
  }
  // Orca keeps the types as one comma separated text, `hardened_steel,hardened_steel`.
  const t = machine['nozzle_type']
  const text = Array.isArray(t) ? t[0] : t
  if (typeof text === 'string' && text.split(',').length === extruders.length) {
    const prev = text.split(',')
    const joined = extruders.map((e, i) => (e.type && ORCA_NOZZLE_TYPE[e.type]) || prev[i]).join(',')
    machine['nozzle_type'] = Array.isArray(t) ? [joined] : joined
  }
}

/** Keys whose value is G-code text. */
export const GCODE_KEYS = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode', 'filament_start_gcode', 'filament_end_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'time_lapse_gcode', 'toolchange_gcode', 'wrapping_detection_gcode', 'file_start_gcode'] as const

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

/** Filament keys that override the printer's extruder value only when set. */
const FILAMENT_OVERRIDE_KEYS: ReadonlySet<string> = new Set(['filament_retraction_length', 'filament_z_hop', 'filament_z_hop_types', 'filament_retract_lift_above', 'filament_retract_lift_below', 'filament_retract_lift_enforce', 'filament_retraction_speed', 'filament_deretraction_speed', 'filament_retract_restart_extra', 'filament_retraction_minimum_travel', 'filament_wipe_distance', 'filament_retract_when_changing_layer', 'filament_wipe', 'filament_retract_before_wipe', 'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut'])

/** One value per slot for every key a slot's filament sets, so a three-color print has three entries. */
export function perSlot(parts: readonly Record<string, SettingValue>[]): Record<string, SettingValue> {
  if (parts.length === 1) return { ...parts[0]! }
  const out: Record<string, SettingValue> = {}
  for (const key of new Set(parts.flatMap((p) => Object.keys(p)))) {
    const vectors = parts.some((p) => Array.isArray(p[key]))
    if (!vectors) {
      out[key] = parts.find((p) => key in p)![key]!
      continue
    }
    // A filament override left unset means "use the printer's value", so it never borrows another slot's value.
    if (FILAMENT_OVERRIDE_KEYS.has(key)) {
      out[key] = parts.map((p) => (key in p ? (first(p[key]) ?? 'nil') : 'nil')) as SettingValue
      continue
    }
    const fallback = first(parts.find((p) => key in p)?.[key])
    out[key] = parts.map((p) => (key in p ? first(p[key]) : fallback)) as SettingValue
  }
  return out
}

/**
 * The variant of a filament product that suits a printer: the one named for the printer model and nozzle, else one whose
 * compatible printers list the printer's preset, else the shared `System` one, else the first.
 */
export function pickVariant(file: VendorFile, family: string, machineName: string | undefined, printer?: PrinterContext): string | undefined {
  const fam = file.families[family]
  if (!fam) return undefined
  const names = Object.keys(fam.variants).sort()
  // Orca's rule (compatible printers list or condition), so a printer is only offered presets written for it.
  const ctx: PrinterContext = printer ?? { name: machineName ?? '', isSystem: true, config: {} }
  const compat = (v: string): boolean => {
    const p = resolveFilamentPreset(file, family, v)
    return p ? isCompatibleWithPrinter(p, ctx) : true
  }
  const model = machineName?.replace(/^(Bambu Lab|Prusa|Creality|Elegoo|Qidi|Snapmaker|Sovol|Voron)\s+/i, '').replace(/\s*\(?\d+(\.\d+)? nozzle\)?$/i, '').trim()
  const named = model ? names.find((v) => v.toLowerCase().endsWith(model.toLowerCase()) || v.toLowerCase().includes(`${model.toLowerCase()} `)) : undefined
  if (named && compat(named)) return named
  return names.find(compat) ?? names.find((v) => v === 'System') ?? names[0]
}

/**
 * A preset written for several extruder variants (Direct Drive Standard and High Flow) keeps one entry per variant in each
 * of its lists. Orca keeps the entry of the variant the printer has; so does this.
 */
export function pickExtruderVariant(cfg: Record<string, SettingValue>, variants: readonly string[], variant: string): Record<string, SettingValue> {
  if (variants.length < 2) return cfg
  const i = Math.max(0, variants.indexOf(variant))
  const out: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(cfg)) out[k] = Array.isArray(v) && v.length === variants.length ? ([v[i]] as SettingValue) : v
  if (Array.isArray(out['filament_extruder_variant'])) out['filament_extruder_variant'] = [variant] as SettingValue
  return out
}

/** A shipped filament preset, resolved: the product's common values, its own, and the printer variant's. */
async function shippedFilament(vendor: string, family: string, variant: string | undefined, machineName: string | undefined): Promise<{ config: Record<string, SettingValue>; id: string } | undefined> {
  const file = await loadVendorFile(vendor)
  if (!file) return undefined
  const v = variant ?? pickVariant(file, family, machineName)
  const preset = v === undefined ? undefined : resolveFilamentPreset(file, family, v)
  return preset ? { config: { ...preset.config } as Record<string, SettingValue>, id: preset.filamentId } : undefined
}

/** The extruder variants a printer's presets are written for, from its own list (`Direct Drive Standard,Direct Drive High Flow`). */
function variantList(machine: Record<string, SettingValue>): string[] {
  const v = machine['extruder_variant_list']
  const text = Array.isArray(v) ? v.join(',') : String(v ?? '')
  return text.split(',').map((x) => x.trim()).filter(Boolean)
}

/** The extruder variant the printer has: the first its own preset names, else the standard direct drive one. */
function printerVariant(machine: Record<string, SettingValue>): string {
  const v = machine['printer_extruder_variant']
  return String((Array.isArray(v) ? v[0] : v) ?? 'Direct Drive Standard')
}

/** The generic preset of a material (`Generic PETG`): the printer vendor's own, else the shared library's. */
async function genericFilament(type: string, vendorFolder: string | undefined, machineName: string | undefined): Promise<{ config: Record<string, SettingValue>; id: string } | undefined> {
  const name = `Generic ${type.toUpperCase()}`
  for (const vendor of [vendorFolder, 'OrcaFilamentLibrary']) {
    if (!vendor) continue
    const has = listFilamentFamilies({ vendor }).some((f) => f.family === name)
    if (has) {
      const cfg = await shippedFilament(vendor, name, undefined, machineName)
      if (cfg) return cfg
    }
  }
  return undefined
}

function materialId(type: string): string {
  const id = type.toLowerCase()
  return listFilamentProfiles().some((m) => m.id === id) ? id : 'pla'
}

/** The goals, in the order the Goal tiles show them. */
const GOALS: readonly EasyGoal[] = ['draft', 'standard', 'fine', 'strong']

/** The layer for a printer, tier and slot filaments. Null when the printer matches none of our profiles. */
export async function stockLayer(input: StockLayerInput): Promise<StockLayer | null> {
  const printerId = input.printerId
  const profile = printerProfile(printerId)
  if (!profile) return null
  const nozzle = layerNozzle(profile, input.extruders?.[0]?.mm ?? input.nozzle)
  const { exact, resolved, base, machine } = await layerMachine(printerId, input.tier, nozzle)
  const process = await tierProcess(printerId, input.tier, nozzle, exact)
  applyExtruders(machine, input.extruders)
  // Filament: the maker's default for the printer where the slot's material matches it, else the slot's own product or the generic one of its type.
  // The filament type is stored only when it is not the schema default (PLA).
  const defaultType = resolved ? String(first(resolved.filament['filament_type']) ?? 'PLA') : ''
  const slots = input.slots.length ? input.slots : [{ type: defaultType || 'PLA' }]
  const { filaments, filamentIds } = await slotFilaments(slots, resolved, defaultType, machine)
  // The G-code is the text written for SlicerX for this model, not the maker's.
  const gcode = shippedGcode(printerId, base)
  const values: Record<string, SettingValue> = { ...process, ...perSlot(filaments), ...machine, ...gcode }
  // What every goal gives on this printer and nozzle, for the Goal tiles: the tier in use from its own process.
  const goalValues = {} as Record<EasyGoal, Record<string, SettingValue>>
  for (const g of GOALS) {
    const p = g === input.tier ? process : await tierProcess(printerId, g, nozzle)
    goalValues[g] = Object.fromEntries(GOAL_KEYS.map((k) => [k, p[k] ?? settingDefault(k)!]))
  }
  return {
    printerId,
    nozzle,
    nozzles: [...profile.nozzles],
    tier: input.tier,
    source: exact || (resolved && nozzle === profile.defaultNozzle) ? 'orca' : 'slicerx',
    values,
    limits: { ...(profile.limits.hotendMaxTemp ? { nozzleMaxC: profile.limits.hotendMaxTemp } : {}), ...(profile.limits.bedMaxTemp ? { bedMaxC: profile.limits.bedMaxTemp } : {}) },
    shippedGcode: gcodeStatus(printerId) === 'written',
    gcodeKeys: Object.keys(gcode),
    filamentIds,
    materialType: defaultType,
    goalValues,
  }
}

export interface StockPrinter {
  /** The nozzle the settings are for: the size asked for when the printer offers it, else its default. */
  nozzle: number
  /** The printer's machine settings, with the G-code SlicerX writes for the model. */
  machine: Record<string, SettingValue>
  /** The filament a fresh plate's slot gets: the maker's default for the printer, else the generic one of its type. */
  filament: Record<string, SettingValue>
  /** That filament's preset id (`filament_id`, such as `GFA00`), empty where no shipped preset applies. */
  filamentId: string
  /** That filament's name: the maker's preset's where the data names it, else `Bambu Lab default PLA` or `Generic PLA`. */
  filamentName: string
}

/**
 * The machine and the default filament of a printer and nozzle, as `stockLayer` puts them in the app's printer layer for
 * a plate whose slots name no filament. Neither depends on the tier. The MCP server builds `machine:<id>`, and the
 * filament of a slice that names none, from it, so a slice through the server starts from the printer the app does.
 * Null for a printer that matches none of our profiles.
 */
export async function stockPrinter(printerId: string, nozzle?: number): Promise<StockPrinter | null> {
  const profile = printerProfile(printerId)
  if (!profile) return null
  const mm = layerNozzle(profile, nozzle)
  const { resolved, base, machine } = await layerMachine(printerId, 'standard', mm)
  const type = resolved ? String(first(resolved.filament['filament_type']) ?? 'PLA') : ''
  const { filaments, filamentIds } = await slotFilaments([{ type: type || 'PLA' }], resolved, type, machine)
  const name = resolved ? resolved.orca?.filament || `${profile.vendor} default ${(type || 'PLA').toUpperCase()}` : 'Generic PLA'
  return { nozzle: mm, machine: { ...machine, ...shippedGcode(printerId, base) }, filament: perSlot(filaments), filamentId: filamentIds[0] ?? '', filamentName: name }
}

/** The nozzle a layer is for: the size asked for when the printer offers it, else the printer's default. */
function layerNozzle(profile: { nozzles: readonly number[]; defaultNozzle: number }, wanted: number | undefined): number {
  return wanted && profile.nozzles.includes(wanted) ? wanted : profile.defaultNozzle
}

type Resolved = Awaited<ReturnType<typeof resolvedProfile>>

/**
 * A printer's machine settings for a nozzle and the resolved presets they come from: the maker's resolved machine where
 * there is one, else our own profile's. The machine is the same for every tier; only `exact`, the tier's preset for the
 * nozzle, depends on it.
 */
async function layerMachine(printerId: string, tier: EasyGoal, nozzle: number): Promise<{ exact: Resolved; resolved: Resolved; base: Record<string, SettingValue>; machine: Record<string, SettingValue> }> {
  const defaultNozzle = printerProfile(printerId)?.defaultNozzle
  // The presets Orca has for this nozzle; a size it has none for keeps the default nozzle's machine with our own process for the size.
  const exact = await resolvedProfile(printerId, tier, nozzle)
  const resolved = exact ?? (nozzle !== defaultNozzle ? await resolvedProfile(printerId, tier) : undefined)
  const base = printerConfig(printerId, nozzle) as Record<string, SettingValue>
  // Orca's Bambu Lab presets leave out Bambu Studio's clearance keys (extruder_clearance_max_radius and
  // extruder_clearance_dist_to_rod: 73 and 56.5 mm on the A1); heimdall needs them, so they come from the maker's own
  // machine settings where the preset has none.
  const clearance = Object.fromEntries(Object.entries(base).filter(([k]) => k.startsWith('extruder_clearance_')))
  const machine = (resolved ? { ...clearance, ...resolved.machine } : { ...base }) as Record<string, SettingValue>
  if (resolved && !exact) {
    for (const k of ['nozzle_diameter', 'min_layer_height', 'max_layer_height'] as const) if (base[k] !== undefined) machine[k] = base[k]!
  }
  return { exact, resolved, base, machine }
}

/** Each slot's filament settings and preset id, in slot order. */
async function slotFilaments(slots: readonly SlotFilament[], resolved: Resolved, defaultType: string, machine: Record<string, SettingValue>): Promise<{ filaments: Record<string, SettingValue>[]; filamentIds: string[] }> {
  const filaments: Record<string, SettingValue>[] = []
  // Orca writes each filament preset's `filament_id` into the project (`filament_ids`); empty where there is none.
  const filamentIds: string[] = []
  const machineName = resolved?.orca?.profile
  const vendorFolder = resolved?.orca?.vendor
  for (const s of slots) {
    // 1. The product the slot was matched to or the person picked, 2. the maker's default for this printer when the
    // material is the same, 3. the generic preset of the material, 4. only then the knowledge base.
    const picked = s.vendor && s.family ? await shippedFilament(s.vendor, s.family, s.variant, machineName) : undefined
    if (picked) {
      filaments.push(pickExtruderVariant(picked.config, variantList(machine), printerVariant(machine)))
      filamentIds.push(picked.id)
    } else if (resolved && s.type.toUpperCase() === defaultType.toUpperCase()) {
      // The resolved maker default carries the id Orca resolved for its preset (GFA00 and the like).
      filaments.push({ ...(resolved.filament as Record<string, SettingValue>) })
      filamentIds.push(resolved.orca?.filamentId ?? '')
    } else {
      const generic = await genericFilament(s.type, vendorFolder, machineName)
      filaments.push(generic ? pickExtruderVariant(generic.config, variantList(machine), printerVariant(machine)) : ({ ...(filamentConfig(materialId(s.type)) as Record<string, SettingValue>) }))
      filamentIds.push(generic?.id ?? '')
    }
  }
  return { filaments, filamentIds }
}

/** The G-code text written for SlicerX for the model, by key, once it is written (gcodeStatus); else none. */
function shippedGcode(printerId: string, base: Record<string, SettingValue>): Record<string, SettingValue> {
  if (gcodeStatus(printerId) !== 'written') return {}
  return Object.fromEntries(GCODE_KEYS.flatMap((k) => (typeof base[k] === 'string' ? [[k, base[k]!] as const] : [])))
}

/**
 * The process a printer prints a goal with, as the app's printer layer (stockLayer) takes it: the maker's own preset for
 * the tier and nozzle where there is one, else SlicerX's tier for the printer. The MCP server builds `process:<tier>` on
 * a printer from it, so a slice through the server and one in the app start from the same process.
 */
export function stockProcess(printerId: string, tier: EasyGoal, nozzle: number): Promise<Record<string, SettingValue>> {
  return tierProcess(printerId, tier, nozzle)
}

/** The settings the Goal tiles read from each goal's process. */
const GOAL_KEYS = ['layer_height', 'wall_loops'] as const

/** SlicerX's layer heights on a 0.4 mm nozzle, for a printer whose own 0.4 mm presets leave a tier out. */
const LADDER_04: Record<'draft' | 'standard' | 'fine', number> = { draft: 0.28, standard: 0.2, fine: 0.12 }

// One key's default: defaultConfig() copies the whole table, and tierProcess reads this for every tier it builds.
const layerOf = (p: Record<string, SettingValue>): number => Number(first(p['layer_height'] ?? settingDefault('layer_height')))

/**
 * A tier's process preset: the maker's own for this nozzle when it has one, else ours for the size. Draft and Fine with
 * no preset of their own (Orca falls back to Standard, or the preset is no thicker or thinner than Standard) are that
 * nozzle's Standard with the layer height scaled by the 0.4 mm ladder's ratio, kept within 25 to 75 percent of the nozzle.
 */
async function tierProcess(printerId: string, tier: EasyGoal, nozzle: number, exact?: Awaited<ReturnType<typeof resolvedProfile>>): Promise<Record<string, SettingValue>> {
  const shipped = exact ?? (await resolvedProfile(printerId, tier, nozzle))
  if (!shipped) return { ...(processConfig(tier, nozzle, printerId) as Record<string, SettingValue>) }
  const own = { ...shipped.process } as Record<string, SettingValue>
  if (tier !== 'draft' && tier !== 'fine') return own
  const standard = { ...(await resolvedProfile(printerId, 'standard', nozzle))!.process } as Record<string, SettingValue>
  const std = layerOf(standard)
  const ordered = (h: number) => (tier === 'draft' ? h > std + 1e-9 : h < std - 1e-9)
  if (shipped.tier === tier && ordered(layerOf(own))) return own
  const ratio = await ladderRatio(printerId, tier)
  const h = Math.round(Math.min(Math.max(std * ratio, 0.25 * nozzle), 0.75 * nozzle) * 100) / 100
  return { ...standard, layer_height: Array.isArray(standard['layer_height']) ? [h] : h }
}

/** Draft or Fine over Standard on the printer's own 0.4 mm presets, else on SlicerX's. */
async function ladderRatio(printerId: string, tier: 'draft' | 'fine'): Promise<number> {
  const [own, std] = await Promise.all([resolvedProfile(printerId, tier, 0.4), resolvedProfile(printerId, 'standard', 0.4)])
  const fallback = LADDER_04[tier] / LADDER_04.standard
  if (!own || !std || own.tier !== tier) return fallback
  const r = layerOf(own.process as Record<string, SettingValue>) / layerOf(std.process as Record<string, SettingValue>)
  return Number.isFinite(r) && (tier === 'draft' ? r > 1 : r < 1) ? r : fallback
}
