// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// SlicerX's own printer, filament and process profiles. Printers come from profiles/printers.json (one per
// model in @slicerx/printer-catalog, from the makers' published specs), filaments from the cited knowledge
// base (knowledge/filaments) and process presets from the Easy mode goals. Key names match Orca's for
// compatibility; the values are ours. src/profiles.rs does the same.
import type { EasyGoal, EasySettings, PrintConfig, SettingValue } from '@slicerx/contracts/settings'
import curaJson from '@slicerx/profiles/cura/ultimaker.json'
import gcodeJson from '@slicerx/profiles/gcode.json'
import machineJson from '@slicerx/profiles/machine.json'
import speedsJson from '@slicerx/profiles/process-speeds.json'
import printersJson from '../profiles/printers.json'
import { applyEasy } from './easy'
import { importFlat } from './import'
import { K } from './knowledge'
import { derive, shapeFor } from './plan'
import { settingDef } from './schema'
import { LAYER_STEP } from './smartlayer'

export interface PrinterProfile {
  /** The printer catalog's model id, such as `bambu-x1-carbon`. */
  id: string
  brand: string
  vendor: string
  model: string
  kinematics: string
  enclosed: boolean
  buildVolume: { shape: 'rectangular'; x: number; y: number; z: number } | { shape: 'circular'; diameter: number; z: number }
  nozzles: number[]
  defaultNozzle: number
  nozzleCount: number
  flavor: string
  directDrive?: boolean
  limits: { maxSpeed?: number; maxAccel?: number; hotendMaxTemp?: number; bedMaxTemp?: number }
  /** The maker's pages the profile follows. */
  sources: string[]
}

/** The machine settings a printer model carries, in Orca's value format, and the version they were checked against. */
export interface MachineEntry {
  /** The Orca profile the values were checked against; absent for a printer Orca has no profile for. */
  orca?: { vendor: string; profile: string; checked: string }
  /** The Cura definition and print cores the values were resolved from (the UltiMaker S series). */
  cura?: { definition: string; printCores: string[] }
  machine: Record<string, unknown>
  /** Other nozzles: the keys that differ from the default nozzle's settings. */
  nozzles: Record<string, { orcaProfile: string; differs: Record<string, unknown> }>
  noGcodeInOrca: string[]
}
/** The UltiMaker S series from Cura's definitions (cura/ultimaker.json, LGPL-3.0-or-later), in the shapes of the files below. */
const CURA = curaJson as unknown as {
  models: Record<string, MachineEntry>
  presets: Record<string, Record<string, unknown>>
  speeds: Record<string, Record<string, string>>
  families: Record<string, GcodeFamily>
  gcodeModels: Record<string, string>
}
const MACHINES = { ...CURA.models, ...(machineJson as unknown as { models: Record<string, MachineEntry>; orcaCommit: string }).models }
export const MACHINE_CHECKED_COMMIT: string = (machineJson as unknown as { orcaCommit: string }).orcaCommit
/** Models with machine settings from the maker's profile; the rest use the catalog values alone. */
export function machineEntry(id: string): MachineEntry | undefined {
  return MACHINES[id]
}

interface GcodeFamily {
  start: string
  end: string
  beforeLayerChange: string
  layerChange: string
  changeFilament: string
  pause?: string
  timeLapse?: string
  templateCustom?: string
  toolchange?: string
  wrappingDetection?: string
  fileStart?: string
  extruderStart?: string
}
const GCODE_FIELDS: [keyof GcodeFamily, string][] = [
  ['start', 'machine_start_gcode'], ['end', 'machine_end_gcode'], ['beforeLayerChange', 'before_layer_change_gcode'], ['layerChange', 'layer_change_gcode'], ['changeFilament', 'change_filament_gcode'],
  ['pause', 'machine_pause_gcode'], ['extruderStart', 'extruder_start_gcode'], ['timeLapse', 'time_lapse_gcode'], ['templateCustom', 'template_custom_gcode'], ['toolchange', 'toolchange_gcode'], ['wrappingDetection', 'wrapping_detection_gcode'], ['fileStart', 'file_start_gcode'],
]
const GCODE_FILE = gcodeJson as unknown as { families: Record<string, GcodeFamily>; models: Record<string, string>; pending: string[] }
const GCODE = { ...GCODE_FILE, families: { ...CURA.families, ...GCODE_FILE.families }, models: { ...CURA.gcodeModels, ...GCODE_FILE.models } }
/** How a model's start, end, layer change and filament change G-code stands: written for SlicerX, or not yet. */
export function gcodeStatus(id: string): 'written' | 'pending' | undefined {
  return GCODE.models[id] ? 'written' : GCODE.pending.includes(id) ? 'pending' : undefined
}

const PRINTERS = (printersJson as unknown as { printers: PrinterProfile[] }).printers
const snap = (v: number): number => Math.round(v * 1e9) / 1e9

export function listPrinterProfiles(): PrinterProfile[] {
  return PRINTERS.map((p) => ({ ...p }))
}

export function printerProfile(id: string): PrinterProfile | undefined {
  return PRINTERS.find((p) => p.id === id)
}

/** The printer's settings for a nozzle: bed shape and height, flavor, extruder type, machine limits, layer height limits. */
export function printerConfig(id: string, nozzle?: number): PrintConfig | undefined {
  const p = printerProfile(id)
  if (!p) return undefined
  const n = nozzle ?? p.defaultNozzle
  const v = p.buildVolume
  const area: [number, number][] = v.shape === 'rectangular'
    ? [[0, 0], [v.x, 0], [v.x, v.y], [0, v.y]]
    : Array.from({ length: 24 }, (_, i) => {
        const a = (2 * Math.PI * i) / 24
        const r = v.diameter / 2
        return [snap(r + r * Math.cos(a)), snap(r + r * Math.sin(a))] as [number, number]
      })
  const out: Record<string, SettingValue> = {
    printer_model: p.model.toLowerCase().startsWith((p.vendor.split(' ')[0] ?? '').toLowerCase()) ? p.model : `${p.vendor} ${p.model}`,
    printable_area: area,
    printable_height: v.z,
    nozzle_diameter: [n],
    gcode_flavor: p.flavor,
    min_layer_height: [snap(Math.ceil(snap((0.2 * n) / LAYER_STEP) - 1e-9) * LAYER_STEP)],
    max_layer_height: [snap(Math.floor(snap((0.75 * n) / LAYER_STEP) + 1e-9) * LAYER_STEP)],
  }
  const entry = MACHINES[id]
  if (p.directDrive !== undefined) out['extruder_type'] = [p.directDrive ? 'Direct Drive' : 'Bowden']
  if (p.limits.maxSpeed) for (const k of ['machine_max_speed_x', 'machine_max_speed_y']) out[k] = [p.limits.maxSpeed, p.limits.maxSpeed]
  if (p.limits.maxAccel) for (const k of ['machine_max_acceleration_extruding', 'machine_max_acceleration_x', 'machine_max_acceleration_y']) out[k] = [p.limits.maxAccel, p.limits.maxAccel]
  if (entry) {
    // The maker's settings win. A nozzle with no profile of its own keeps our nozzle and layer height limits.
    const ov = entry.nozzles[String(n)]
    const raw: Record<string, unknown> = { ...entry.machine, ...(ov?.differs ?? {}) }
    if (n !== p.defaultNozzle && !ov) for (const k of ['nozzle_diameter', 'min_layer_height', 'max_layer_height']) delete raw[k]
    Object.assign(out, importFlat(raw).config)
  }
  const family = GCODE.families[GCODE.models[id] ?? '']
  if (family) {
    for (const [field, key] of GCODE_FIELDS) {
      const text = family[field]
      if (text !== undefined) out[key] = text
    }
  }
  return out as unknown as PrintConfig
}

export interface FilamentProfile {
  /** The knowledge material id, such as `petg`. */
  id: string
  name: string
  category?: string
}

export function listFilamentProfiles(): FilamentProfile[] {
  return Object.entries(K.materials).map(([id, m]) => ({ id, name: m.name, ...(m.category ? { category: m.category } : {}) }))
}

/** A material's filament settings from the knowledge base: temperatures, cooling, flow, retraction and the rest. */
export function filamentConfig(id: string, opts: { hotend?: 'standard' | 'high_flow' } = {}): PrintConfig | undefined {
  if (!K.materials[id]) return undefined
  const out: Record<string, SettingValue> = {}
  for (const [key, d] of derive({ printer: '', nozzleDiameter: 0.4, filament: id, ...(opts.hotend ? { hotend: opts.hotend } : {}) })) {
    out[key] = d.shaped ?? shapeFor(settingDef(key), d.value, undefined)
  }
  return out as unknown as PrintConfig
}

/** The sources a filament profile cites, for showing where its numbers come from. */
export function filamentSources(id: string): string[] {
  const out = new Set<string>()
  for (const d of derive({ printer: '', nozzleDiameter: 0.4, filament: id }).values()) for (const s of d.src) out.add(s)
  return [...out].sort()
}

export interface ProcessPreset {
  id: string
  /** For example `0.20 mm Standard`. */
  label: string
  layerHeight: number
}

const TIERS: { id: string; name: string; easy: EasySettings }[] = [
  { id: 'draft', name: 'Draft', easy: { detail: 0, strength: 10, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: false } },
  { id: 'standard', name: 'Standard', easy: { detail: 40, strength: 20, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true } },
  { id: 'fine', name: 'Fine', easy: { detail: 80, strength: 30, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true } },
  { id: 'extra_fine', name: 'Extra fine', easy: { detail: 100, strength: 30, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true } },
  { id: 'strong', name: 'Strong', easy: { detail: 40, strength: 85, speed: 'balanced', supports: 'auto', brim: true, varyLayerHeight: true } },
]

/** The plain process every preset starts from: line widths and speeds that suit a nozzle, before the tier scales them. */
function processBase(nozzle: number): Record<string, SettingValue> {
  const w = String(snap(Math.round(nozzle * 1.05 * 100) / 100))
  return {
    nozzle_diameter: [nozzle],
    layer_height: snap(Math.round((0.5 * nozzle) / LAYER_STEP) * LAYER_STEP),
    line_width: w,
    outer_wall_line_width: w,
    inner_wall_line_width: w,
    sparse_infill_line_width: w,
    internal_solid_infill_line_width: w,
    top_surface_line_width: w,
    outer_wall_speed: [60],
    inner_wall_speed: [100],
    sparse_infill_speed: [120],
    internal_solid_infill_speed: [100],
    top_surface_speed: [60],
    gap_infill_speed: [60],
    initial_layer_speed: [30],
    travel_speed: [200],
    default_acceleration: [3000],
    outer_wall_acceleration: [2000],
    top_surface_acceleration: [1500],
    initial_layer_acceleration: [500],
  }
}

/** The makers' own speed, acceleration and jerk values per printer and quality tier, in Orca's value format. */
interface SpeedFile { orcaCommit: string; bambuStudioCommit: string; presets: Record<string, Record<string, unknown>>; models: Record<string, Record<string, string>> }
const SPEEDS_FILE = speedsJson as unknown as SpeedFile
const SPEEDS: SpeedFile = { ...SPEEDS_FILE, presets: { ...CURA.presets, ...SPEEDS_FILE.presets }, models: { ...CURA.speeds, ...SPEEDS_FILE.models } }
export const PROCESS_SPEED_SOURCES = { orcaSlicer: SPEEDS.orcaCommit, bambuStudio: SPEEDS.bambuStudioCommit }

/** The maker preset a printer's tier takes its speeds from. The Strong tier uses the Standard preset when the maker has no strength preset. */
export function processSpeedSource(printer: string, tier: string): string | undefined {
  const m = SPEEDS.models[printer]
  return m?.[tier] ?? (tier === 'strong' ? m?.['standard'] : undefined)
}

/** Printers whose Fine tier carries the tuned quality values (from the shared P2S and H2C profiles). */
const FINE_FAMILY = new Set(['bambu-p2s', 'bambu-h2c', 'bambu-h2d', 'bambu-h2s', 'bambu-x2d'])

/**
 * The quality values the Fine tier adds on the P2S and H2C family, between Bambu's High Quality preset and the
 * shared profiles: outer wall 50 on the standard hotend, moderate overhang speeds, a smoother support underside.
 * The overhang speeds and the support gaps and angle still need a test print.
 */
function fineFamily(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  const variants = Array.isArray(raw['print_extruder_variant']) ? (raw['print_extruder_variant'] as string[]) : []
  const wall = raw['outer_wall_speed']
  if (Array.isArray(wall)) out['outer_wall_speed'] = wall.map((v, i) => (variants[i] === 'Direct Drive Standard' ? '50' : v))
  for (const [k, v] of [['overhang_1_4_speed', '60'], ['overhang_2_4_speed', '40'], ['overhang_3_4_speed', '30'], ['overhang_4_4_speed', '30'], ['overhang_totally_speed', '10']] as const) {
    const cur = raw[k]
    out[k] = Array.isArray(cur) ? cur.map(() => v) : Array.isArray(wall) ? wall.map(() => v) : v
  }
  Object.assign(out, {
    top_shell_layers: '5', top_shell_thickness: '0.6', sparse_infill_density: '15%', seam_position: 'aligned', skirt_loops: '1', enable_arc_fitting: '1',
    support_interface_top_layers: '3', support_interface_spacing: '0', support_top_z_distance: '0.16', support_bottom_z_distance: '0.16', support_object_xy_distance: '0.4', support_threshold_angle: '25',
  })
  return out
}

/**
 * A process preset for a nozzle: the tier's Easy mode controls applied to the plain process. With a printer (and
 * the 0.4 mm nozzle) the speeds, accelerations and jerk are the maker's own for that printer and tier.
 */
export function processConfig(id: string, nozzle = 0.4, printer?: string): PrintConfig | undefined {
  const t = TIERS.find((x) => x.id === id)
  if (!t) return undefined
  const base = applyEasy(t.easy, processBase(nozzle) as unknown as PrintConfig) as unknown as Record<string, SettingValue>
  const src = printer && nozzle === 0.4 ? processSpeedSource(printer, id) : undefined
  if (!printer || !src) return base as unknown as PrintConfig
  let raw: Record<string, unknown> = { ...(SPEEDS.presets[src] ?? {}) }
  if (id === 'fine' && FINE_FAMILY.has(printer)) raw = fineFamily(raw)
  return { ...base, ...importFlat(raw).config } as unknown as PrintConfig
}

/** The quality tiers for a nozzle, thinnest layers last. Labels carry the layer height the tier lands on. */
export function listProcessPresets(nozzle = 0.4, printer?: string): ProcessPreset[] {
  return TIERS.map((t) => {
    const lh = Number(processConfig(t.id, nozzle, printer)?.['layer_height'])
    return { id: t.id, label: `${lh.toFixed(2)} mm ${t.name}`, layerHeight: lh }
  })
}

/** Preset ids for the Easy goals, for callers that already speak goals. */
export const PROCESS_PRESET_FOR_GOAL: Record<EasyGoal, string> = { draft: 'draft', standard: 'standard', fine: 'fine', strong: 'strong' }

/** Printer, filament and process merged into one config, later parts winning: process, then filament, then printer. */
export function profileConfig(sel: { printer: string; nozzle?: number; filament?: string; process?: string }): PrintConfig | undefined {
  const p = printerProfile(sel.printer)
  if (!p) return undefined
  const nozzle = sel.nozzle ?? p.defaultNozzle
  const parts: (PrintConfig | undefined)[] = [processConfig(sel.process ?? 'standard', nozzle, sel.printer), sel.filament ? filamentConfig(sel.filament) : undefined, printerConfig(sel.printer, nozzle)]
  const out: Record<string, SettingValue> = {}
  for (const part of parts) Object.assign(out, part ?? {})
  return out as PrintConfig
}
