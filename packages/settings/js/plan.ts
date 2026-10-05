// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Deterministic settings plan for a material, printer or nozzle switch, optionally with the
// user's goals. No model call and no I/O: everything comes from knowledge.json (compiled from
// knowledge/) and the schema. The order follows the knowledge base guide:
//   1. the Orca profile for the target printer, nozzle and filament (or the printer baseline),
//   2. filament pilot_defaults and printer facts, except where a printer specific profile sets the key,
//   3. stored calibration results for this spool, printer and nozzle,
//   4. the merged intent goals,
//   5. clamps to the catalog bounds, the filament ranges and the printer limits, each recorded,
//   6. a diff against the current values: only changed keys, each with reason, sources and origin.
import type {
  CalibrationResult, ChangeOrigin, PilotRule, PlanAdvice, PlanClamp, PlanIntent, PlanRefusal, PrintConfig, SettingChange, SettingDef,
  SettingsPlan, SettingValue, SetupRef,
} from '@slicerx/contracts/settings'
import { numberOf } from './config'
import { formatValue, sameValue } from './diff'
import { mergeIntent, type Scalar } from './intent'
import { K, type MaterialKnowledge, type PrinterKnowledge } from './knowledge'
import { settingDef } from './schema'
import { heatCreepWarning, layerTimeGuard } from './thinlayers'
import { LAYER_STEP, isSmartLayerOn, smartLayerLimits, smartLayerWindow } from './smartlayer'

export type { MaterialKnowledge, PrinterKnowledge } from './knowledge'

export function listMaterials(): { id: string; name: string }[] {
  return Object.entries(K.materials).map(([id, m]) => ({ id, name: m.name }))
}
export function listPrinters(): { id: string; name: string }[] {
  return Object.entries(K.printers).map(([id, p]) => ({ id, name: p.name }))
}
export function materialKnowledge(id: string): MaterialKnowledge | undefined {
  return K.materials[id]
}
export function printerKnowledge(id: string): PrinterKnowledge | undefined {
  return K.printers[id]
}
export function listGoals(): { id: string; label: string; levels: string[] }[] {
  return Object.entries(K.goals).map(([id, g]) => ({ id, label: g.label, levels: Object.keys(g.levels) }))
}

export interface PlanOptions {
  /** The merged Orca profile (printer, filament and process) for the `to` setup. */
  target?: PrintConfig
  /** Keys the target's printer specific profile sets itself; filament defaults do not override them. */
  tuned?: ReadonlySet<string>
  /** Plate overrides to leave alone (intent and calibration still win). */
  keep?: ReadonlySet<string>
  calibrations?: readonly CalibrationResult[]
  intent?: PlanIntent
}

interface Pending {
  value: SettingValue
  origin: ChangeOrigin
  reason: string
  src: string[]
  goal?: string
  priority?: 'core' | 'supporting'
}

export interface Derived {
  /** The exact value to write, when it is not one scalar spread over the list (an elementwise cap). */
  shaped?: SettingValue
  value: number | string
  because: string
  src: string[]
  origin: ChangeOrigin
}

const PLATE_KEY: Record<string, string> = {
  bambu_cool_plate: 'cool_plate_temp',
  bambu_engineering_plate: 'eng_plate_temp',
  bambu_high_temp_plate: 'hot_plate_temp',
  textured_pei: 'textured_plate_temp',
  bambu_supertack_plate: 'supertack_plate_temp',
  bambu_textured_cool_plate: 'textured_cool_plate_temp',
}
const FLAVOR: Record<string, string> = { bambu: 'marlin', prusa: 'marlin2', klipper: 'klipper', vendor_klipper: 'klipper' }
const WIDTH_KEYS = ['line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width', 'top_surface_line_width', 'internal_solid_infill_line_width', 'initial_layer_line_width']
const snap = (v: number): number => Math.round(v * 1e9) / 1e9
/** Code unit order, so both languages sort keys the same way. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `Carbon fiber nylon (PA6-CF, PAHT-CF)` reads as `Carbon fiber nylon` in sentences. */
export const shortName = (name: string): string => name.split(' (')[0] ?? name

/** What the knowledge says the config holds for one setup: material defaults, then printer facts. */
export function derive(setup: SetupRef): Map<string, Derived> {
  const out = new Map<string, Derived>()
  const m = K.materials[setup.filament]
  const p = K.printers[setup.printer]
  if (p) {
    out.set('nozzle_diameter', { value: setup.nozzleDiameter, because: `the ${p.name} is set up with a ${setup.nozzleDiameter} mm nozzle`, src: p.hotend.src, origin: 'nozzle' })
    if (p.build?.x && p.build.y) {
      const { x, y } = p.build
      out.set('printable_area', { value: `0x0,${x}x0,${x}x${y},0x${y}`, because: `the ${p.name} bed is ${x} by ${y} mm`, src: p.build.src, origin: 'printer' })
    }
    const z = p.build?.zDefault ?? p.build?.z
    if (z) out.set('printable_height', { value: z, because: `the ${p.name} prints up to ${z} mm high`, src: p.build?.src ?? [], origin: 'printer' })
    if (p.motion.maxAccel) out.set('machine_max_acceleration_extruding', { value: p.motion.maxAccel, because: `the ${p.name} allows up to ${p.motion.maxAccel} mm/s2`, src: p.motion.src, origin: 'printer' })
    const flavor = p.firmware ? FLAVOR[p.firmware] : undefined
    if (flavor) out.set('gcode_flavor', { value: flavor, because: `the ${p.name} runs ${p.firmware} firmware`, src: [], origin: 'printer' })
  }
  if (!m) return out
  const mat = shortName(m.name)
  const put = (key: string, value: number | string | undefined, because: string, src: string[]): void => {
    if (value !== undefined) out.set(key, { value, because, src, origin: 'filament' })
  }
  const t = m.nozzleTemp
  if (t) {
    put('nozzle_temperature', t.typical, `${mat} runs at ${t.typical} C (range ${t.min} to ${t.max} C)`, t.src)
    put('nozzle_temperature_initial_layer', m.firstLayerTemp?.typical ?? t.typical, `${mat} first layer runs at ${m.firstLayerTemp?.typical ?? t.typical} C`, m.firstLayerTemp?.src ?? t.src)
    put('nozzle_temperature_range_low', t.min, `${mat} works from ${t.min} C`, t.src)
    put('nozzle_temperature_range_high', t.max, `${mat} works up to ${t.max} C`, t.src)
  }
  if (m.bedTemp) {
    const bed = m.bedTemp.typical
    for (const pl of m.plates) {
      const key = PLATE_KEY[pl.plate]
      if (!key || pl.fit === 'avoid') continue
      const t = Math.min(Math.max(bed, pl.min ?? -Infinity), pl.max ?? Infinity)
      put(key, t, `${mat} bed temperature on this plate is ${t} C`, m.bedTemp.src)
      put(key + '_initial_layer', t, `${mat} first layer bed temperature on this plate is ${t} C`, m.bedTemp.src)
    }
  }
  put('chamber_temperature', m.chamberTemp?.typical, `${mat} prints best with a ${m.chamberTemp?.typical} C chamber`, m.chamberTemp?.src ?? [])
  const c = m.cooling
  put('fan_min_speed', c.fanMin, `${mat} needs at least ${c.fanMin}% part cooling`, c.src)
  put('fan_max_speed', c.fanMax, `${mat} tops out at ${c.fanMax}% part cooling`, c.src)
  put('overhang_fan_speed', c.overhangFan, `${mat} uses ${c.overhangFan}% fan on overhangs`, c.src)
  const noFan = c.noFanLayers ?? m.firstLayer?.fanOffLayers
  put('close_fan_the_first_x_layers', noFan, `${mat} keeps the fan off for ${noFan} layers`, c.noFanLayers !== undefined ? c.src : (m.firstLayer?.src ?? c.src))
  put('initial_layer_speed', m.firstLayer?.speed, `${mat} prints its first layer at about ${m.firstLayer?.speed} mm/s`, m.firstLayer?.src ?? [])
  put('slow_down_layer_time', c.minLayerTime, `${mat} needs ${c.minLayerTime} s per layer to cool`, c.src)
  put('filament_flow_ratio', m.flowRatio?.typical, `${mat} extrudes at a ${m.flowRatio?.typical} flow ratio`, m.flowRatio?.src ?? [])
  const hf = setup.hotend === 'high_flow'
  const flow = hf ? (m.maxFlow.highFlow ?? m.maxFlow.standard) : m.maxFlow.standard
  put('filament_max_volumetric_speed', flow, `${mat} melts about ${flow} mm3/s on a ${hf ? 'high flow' : 'standard'} hotend`, m.maxFlow.src)
  const direct = p?.extruder ? p.extruder.includes('direct') : undefined
  if (direct !== false) put('retraction_length', m.retraction.directDrive, `${mat} retracts ${m.retraction.directDrive} mm on a direct drive extruder`, m.retraction.src)
  if (direct !== false) put('retraction_speed', m.retractionSpeed?.typical, `${mat} retracts at about ${m.retractionSpeed?.typical} mm/s`, m.retractionSpeed?.src ?? [])
  const pa = direct === false ? m.pressureAdvance.bowden : m.pressureAdvance.directDrive
  // Bambu printers measure pressure advance per spool (flow dynamics), so no fixed value is planned.
  if (!/bambu/i.test(p?.vendor ?? '')) put('pressure_advance', pa, `${mat} starts at a pressure advance of ${pa} on ${direct === false ? 'a bowden' : 'a direct drive'} extruder`, m.pressureAdvance.src)
  put('filament_density', m.density, `${mat} weighs ${m.density} g/cm3`, [])
  put('filament_type', m.orcaType, `${mat} is type ${m.orcaType} in Orca`, [])
  // mimir's own starting values win over the typical values above.
  for (const [k, v] of Object.entries(m.pilotDefaults ?? {})) {
    const prev = out.get(k)
    out.set(k, { value: v, because: prev?.because ?? `${mat} default for ${settingDef(k)?.label ?? k}`, src: prev?.src ?? [...m.nozzleTemp?.src.slice(0, 2) ?? []], origin: 'filament' })
  }
  return out
}

/** Problems with the new setup that are worth showing but do not stop the plan. */
function setupWarnings(setup: SetupRef): string[] {
  const out: string[] = []
  const m = K.materials[setup.filament]
  const p = K.printers[setup.printer]
  if (!p) out.push(`Unknown printer "${setup.printer}".`)
  if (!m) out.push(`Unknown filament "${setup.filament}".`)
  if (p) {
    if (p.hotend.nozzleDiameters && !p.hotend.nozzleDiameters.includes(setup.nozzleDiameter)) out.push(`${p.name} has no ${setup.nozzleDiameter} mm nozzle option (${p.hotend.nozzleDiameters.join(', ')} mm).`)
    if (m && p.materials.notRecommended?.includes(setup.filament)) out.push(`${p.name} is not recommended for ${shortName(m.name)}.`)
    else if (m && p.materials.unlisted?.includes(setup.filament)) out.push(`${shortName(m.name)} is not listed for the ${p.name}; treat it as untested.`)
  }
  if (m) {
    const t = m.nozzleTemp
    if (p?.hotend.maxTemp !== undefined && t?.min !== undefined && p.hotend.maxTemp < t.min) out.push(`The ${p.name} hotend reaches ${p.hotend.maxTemp} C, below the ${t.min} C ${shortName(m.name)} needs.`)
    if (p?.bed.maxTemp !== undefined && m.bedTemp?.min !== undefined && p.bed.maxTemp < m.bedTemp.min) out.push(`The ${p.name} bed reaches ${p.bed.maxTemp} C, below the ${m.bedTemp.min} C ${shortName(m.name)} needs.`)
    if (m.nozzle.minDiameter !== undefined && setup.nozzleDiameter < m.nozzle.minDiameter) out.push(`${shortName(m.name)} needs a nozzle of at least ${m.nozzle.minDiameter} mm.`)
    if (m.enclosure === 'required' && p?.enclosure.type && p.enclosure.type !== 'enclosed') out.push(`${shortName(m.name)} needs an enclosure and the ${p.name} is ${p.enclosure.type.replaceAll('_', ' ')}.`)
    if (m.dryingNeed === 'required' || m.dryingNeed === 'recommended') out.push(`Dry ${shortName(m.name)} before printing (${m.dryingNeed}).`)
  }
  return out
}

/** An abrasive material on a soft nozzle stops the plan. */
function blockersFor(setup: SetupRef): string[] {
  const m = K.materials[setup.filament]
  const p = K.printers[setup.printer]
  if (!m?.nozzle.hardenedRequired) return []
  const fitted = setup.nozzleMaterial ?? p?.hotend.stockNozzle?.material
  if (fitted === undefined || fitted === 'hardened_steel' || fitted === 'tungsten_carbide') return []
  const options = p?.hotend.nozzleMaterials?.includes('hardened_steel') ? ' A hardened steel nozzle is available for it.' : ''
  return [`${shortName(m.name)} is abrasive and wears a ${fitted.replaceAll('_', ' ')} nozzle quickly; fit a hardened steel nozzle first.${options}`]
}

/** Write a plain number or string in the shape the key uses, following a base list's length. */
export function shapeFor(def: SettingDef | undefined, v: Scalar, base: SettingValue | undefined): SettingValue {
  if (def && (def.type === 'floats' || def.type === 'ints' || def.type === 'strings' || def.type === 'percents' || def.type === 'bools' || def.type === 'enums')) {
    const len = Array.isArray(base) && base.length > 0 ? base.length : Array.isArray(def.default) && def.default.length > 0 ? def.default.length : 1
    const item = def.type === 'ints' && typeof v === 'number' ? Math.round(v) : v
    return Array.from({ length: len }, () => item) as SettingValue
  }
  if (def?.type === 'int' && typeof v === 'number') return Math.round(v)
  if (def?.type === 'points' && typeof v === 'string') return pointsFrom(v)
  if (def?.type === 'point' && typeof v === 'string') return pointsFrom(v)[0] as [number, number]
  return v
}

function pointsFrom(s: string): [number, number][] {
  return s.split(',').map((p) => {
    const [x, y] = p.split('x')
    return [Number(x), Number(y)] as [number, number]
  })
}

function firstScalar(v: SettingValue | undefined): Scalar | undefined {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean' ? x : undefined
}

/** Numbers inside a value, when it is a number or a list of numbers. */
function numbersOf(v: SettingValue): number[] | undefined {
  if (typeof v === 'number') return [v]
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number') ? (v as number[]) : undefined
}

const mapNumbers = (v: SettingValue, f: (n: number) => number): SettingValue => (typeof v === 'number' ? f(v) : (v as number[]).map(f))

/** Layer height and line widths keep their share of the nozzle when the nozzle changes. */
function nozzleScaling(from: SetupRef, to: SetupRef, base: PrintConfig | undefined): Map<string, Derived> {
  const out = new Map<string, Derived>()
  if (!base || from.nozzleDiameter === to.nozzleDiameter || !(from.nozzleDiameter > 0)) return out
  const ratio = to.nozzleDiameter / from.nozzleDiameter
  const because = `keeps the same share of the nozzle (${from.nozzleDiameter} to ${to.nozzleDiameter} mm)`
  const lh = numberOf(base, 'layer_height', false)
  if (lh !== undefined) {
    const v = snap(Math.min(Math.max(snap(Math.round((lh * ratio) / 0.02) * 0.02), 0.2 * to.nozzleDiameter), 0.75 * to.nozzleDiameter))
    out.set('layer_height', { value: v, because: 'layer height ' + because, src: [], origin: 'nozzle' })
    if (numberOf(base, 'initial_layer_print_height', false) !== undefined) out.set('initial_layer_print_height', { value: snap(Math.max(v, 0.5 * to.nozzleDiameter)), because: 'first layer height follows the nozzle and layer height', src: [], origin: 'nozzle' })
  }
  for (const k of ['smart_layer_min_height', 'smart_layer_max_height']) {
    const v = numberOf(base, k, false)
    if (v !== undefined) out.set(k, { value: snap(Math.round((v * ratio) / LAYER_STEP) * LAYER_STEP), because: 'the bound ' + because, src: [], origin: 'nozzle' })
  }
  for (const k of WIDTH_KEYS) {
    const raw = base[k]
    const w = typeof raw === 'string' && !raw.endsWith('%') ? Number(raw) : undefined
    if (w !== undefined && Number.isFinite(w) && w > 0) out.set(k, { value: String(snap(Math.round(w * ratio * 100) / 100)), because: 'line width ' + because, src: [], origin: 'nozzle' })
  }
  return out
}

/** Keeps the sleipnir bounds inside the window the nozzle (and the material's research) allows. */
function smartLayerFit(to: SetupRef, m: MaterialKnowledge | undefined, get: (key: string) => SettingValue | undefined): Map<string, Derived> {
  const out = new Map<string, Derived>()
  const mode = firstScalar(get('smart_layer'))
  if (!isSmartLayerOn(mode)) return out
  const w = smartLayerWindow(to.nozzleDiameter, m, mode)
  const l = smartLayerLimits(m, mode)
  const num = (k: string): number | undefined => {
    const v = firstScalar(get(k))
    return typeof v === 'number' ? v : undefined
  }
  const min = num('smart_layer_min_height')
  const max = num('smart_layer_max_height')
  let nmin = min
  let nmax = max
  if (nmin !== undefined && nmin < w.min) nmin = w.min
  if (nmax !== undefined && nmax > w.max) nmax = w.max
  if (nmin !== undefined && nmax !== undefined && nmax < snap(nmin + LAYER_STEP)) nmax = snap(nmin + LAYER_STEP)
  const research = m?.smartLayer ? `, from the research on ${shortName(m.name)}` : ''
  const because = `sleipnir stays between ${Math.round(l.minRatio * 100)} and ${Math.round(l.maxRatio * 100)} percent of the ${to.nozzleDiameter} mm nozzle${research}`
  const origin: ChangeOrigin = m?.smartLayer ? 'filament' : 'nozzle'
  if (nmin !== undefined && nmin !== min) out.set('smart_layer_min_height', { value: nmin, because, src: l.src, origin })
  if (nmax !== undefined && nmax !== max) out.set('smart_layer_max_height', { value: nmax, because, src: l.src, origin })
  return out
}

const SPEED_CAP_KEYS = ['outer_wall_speed', 'inner_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'gap_infill_speed']
const FIRST_LAYER_SPEED_KEYS = ['initial_layer_speed', 'initial_layer_infill_speed']

/** The most a material lets a speed key reach, when its data sheet or the research says. */
function speedCap(key: string, m: MaterialKnowledge | undefined): number | undefined {
  const s = m?.speeds
  if (!s) return undefined
  if (key === 'outer_wall_speed') return s.outerWallMax ?? s.printMax
  if (FIRST_LAYER_SPEED_KEYS.includes(key)) return s.firstLayerMax
  return SPEED_CAP_KEYS.includes(key) ? s.printMax : undefined
}

/** The thinnest and thickest layer the material's safe band allows on this nozzle, on the layer step grid. */
function layerWindow(to: SetupRef, m: MaterialKnowledge | undefined): [number, number] | undefined {
  const band = m?.layerBand
  if (band?.min === undefined || band.max === undefined) return undefined
  const n = to.nozzleDiameter
  return [snap(Math.ceil(snap((band.min * n) / LAYER_STEP) - 1e-9) * LAYER_STEP), snap(Math.floor(snap((band.max * n) / LAYER_STEP) + 1e-9) * LAYER_STEP)]
}

/** [lowest, highest] a material allows for a key: the layer height band, or a speed ceiling. */
function materialCap(key: string, to: SetupRef, m: MaterialKnowledge | undefined): [number, number] | undefined {
  if (key === 'layer_height') return layerWindow(to, m)
  const cap = speedCap(key, m)
  return cap === undefined ? undefined : [-Infinity, cap]
}

/** Moves layer height and speeds that break the material's band or ceilings, elementwise on per extruder lists. */
function materialLimits(to: SetupRef, m: MaterialKnowledge | undefined, get: (key: string) => SettingValue | undefined): Map<string, Derived> {
  const out = new Map<string, Derived>()
  if (!m) return out
  const mat = shortName(m.name)
  for (const key of ['layer_height', ...SPEED_CAP_KEYS, ...FIRST_LAYER_SPEED_KEYS]) {
    const cap = materialCap(key, to, m)
    const v = get(key)
    const nums = v === undefined ? undefined : numbersOf(v)
    if (!cap || v === undefined || !nums) continue
    const [lo, hi] = cap
    if (!nums.some((n) => n < lo - 1e-9 || n > hi + 1e-9)) continue
    const shaped = mapNumbers(v, (n) => Math.min(Math.max(n, lo), hi))
    const band = m.layerBand
    const because = key === 'layer_height' && band ? `${mat} layers stay between ${Math.round((band.min ?? 0) * 100)} and ${Math.round((band.max ?? 0) * 100)} percent of the ${to.nozzleDiameter} mm nozzle` : `${mat} should not print faster than ${hi} mm/s here`
    const src = key === 'layer_height' ? (band?.src ?? []) : (m.speeds?.src ?? [])
    out.set(key, { value: firstScalar(shaped) as number, shaped, because, src, origin: 'filament' })
  }
  return out
}

/** The printer's hardware limit for a key, when it has one. */
function printerLimit(key: string, def: SettingDef | undefined, p: PrinterKnowledge | undefined): number | undefined {
  if (!p) return undefined
  if (key.includes('plate_temp')) return p.bed.maxTemp
  if (key === 'nozzle_temperature' || key === 'nozzle_temperature_initial_layer' || key === 'nozzle_temperature_range_high') return p.hotend.maxTemp
  if (key === 'filament_max_volumetric_speed') return p.hotend.maxFlow
  if (def?.unit === 'mm/s2') return p.motion.maxAccel
  if (def?.unit === 'mm/s' && def.section === 'process') return p.motion.maxSpeed
  return undefined
}

/** The filament's documented range for a key: [min, max]. */
function filamentRange(key: string, setup: SetupRef, m: MaterialKnowledge | undefined): [number, number] | undefined {
  if (!m) return undefined
  const prefix = key.includes('plate_temp') ? 'bed_temp_c'
    : key === 'nozzle_temperature' ? 'nozzle_temp_c'
    : key === 'nozzle_temperature_initial_layer' ? 'first_layer_nozzle_temp_c'
    : key === 'fan_min_speed' ? 'cooling.fan_min_pct'
    : key === 'fan_max_speed' ? 'cooling.fan_max_pct'
    : key === 'slow_down_layer_time' ? 'cooling.min_layer_time_s'
    : key === 'filament_flow_ratio' ? 'extrusion.flow_ratio'
    : key === 'filament_max_volumetric_speed' ? 'extrusion.max_volumetric_speed_mm3s.' + (setup.hotend === 'high_flow' ? 'high_flow_hotend' : 'standard_hotend')
    : key === 'retraction_length' ? 'extrusion.retraction_mm.direct_drive'
    : key === 'pressure_advance' ? 'extrusion.pressure_advance.direct_drive'
    : undefined
  if (!prefix) return undefined
  const lo = m.paths[prefix + '.min']
  const hi = m.paths[prefix + '.max']
  return lo !== undefined && hi !== undefined ? [lo, hi] : undefined
}

function normalize(v: number | string | boolean, def: SettingDef | undefined): number | string | boolean {
  if (typeof v === 'string' && def && (def.type === 'percent' || def.type === 'percents')) {
    const n = Number(v.replace('%', ''))
    return Number.isFinite(n) ? n : v
  }
  return v
}

/**
 * What to change in a config when the material, printer or nozzle changes, or when goals are
 * given. `base` is the config in use: where it has a value that is the "before"; otherwise the
 * old setup's knowledge value is. Pass `opts.target` (the merged Orca profile for the new setup)
 * to start from it. Synchronous and pure.
 */
export function planSettings(from: SetupRef, to: SetupRef, base?: PrintConfig, opts: PlanOptions = {}): SettingsPlan {
  const t0 = performance.now()
  const m = K.materials[to.filament]
  const p = K.printers[to.printer]
  const keep = opts.keep ?? new Set<string>()
  const tuned = opts.tuned ?? new Set<string>()
  const warnings = setupWarnings(to)
  const questions: string[] = []
  const advice: PlanAdvice[] = []
  const caveats: { text: string; sources: string[] }[] = []
  const tellUser: string[] = []
  const clamps: PlanClamp[] = []
  const refused: PlanRefusal[] = []
  const blockers = blockersFor(to)
  const done = (changes: SettingChange[]): SettingsPlan => ({
    from, to, changes, unresolved: [], warnings, clamps, refused, blockers, questions, caveats, advice, tellUser,
    computedMs: Math.round((performance.now() - t0) * 100) / 100,
  })
  if (m?.dryingNeed === 'required') questions.push(`Has the ${shortName(m.name)} spool been dried in the last day? ${shortName(m.name)} is marked drying required.`)
  if (m && to.filament.startsWith('tpu')) questions.push('Is the TPU fed from an external spool? It should not go through the AMS unless it is a TPU for AMS product.')
  if (blockers.length > 0) {
    if (!to.nozzleMaterial && m?.nozzle.hardenedRequired) questions.push('Is the nozzle hardened steel?')
    return done([])
  }
  if (m?.nozzle.hardenedRequired && !to.nozzleMaterial && !p?.hotend.stockNozzle?.material) questions.push('Is the nozzle hardened steel? Abrasive filament wears brass and stainless nozzles quickly.')

  const fromD = derive(from)
  const cur = (key: string): SettingValue | undefined => {
    const b = base?.[key]
    if (b !== undefined) return b
    const d = fromD.get(key)
    return d ? shapeFor(settingDef(key), d.value, undefined) : undefined
  }
  const pend = new Map<string, Pending>()
  const set = (key: string, value: SettingValue, origin: ChangeOrigin, reason: string, src: string[], extra: { goal?: string; priority?: 'core' | 'supporting' } = {}): void => {
    if (keep.has(key) && origin !== 'intent' && origin !== 'calibration') return
    pend.set(key, { value, origin, reason, src, ...extra })
  }

  // 1. The Orca profile for the target, or the printer's baseline process.
  if (opts.target) {
    for (const [key, v] of Object.entries(opts.target)) {
      const def = settingDef(key)
      if (!def) continue
      const origin: ChangeOrigin = key === 'nozzle_diameter' ? 'nozzle' : def.section === 'filament' ? 'filament' : 'printer'
      set(key, v, origin, `${def.label} comes from the ${p?.name ?? 'target'} profile.`, [])
    }
  } else if (p?.baseline && (from.printer !== to.printer || !base)) {
    for (const [key, raw] of Object.entries(p.baseline.values)) {
      if (from.nozzleDiameter !== to.nozzleDiameter && (key === 'layer_height' || key.endsWith('line_width'))) continue
      const def = settingDef(key)
      const v = normalize(raw, def)
      set(key, shapeFor(def, v, base?.[key]), 'printer', `${def?.label ?? key} comes from the ${p.name} default process (${p.baselineProcess ?? 'baseline'}).`, p.baseline.src)
    }
  }

  // 2. Filament and printer facts, except where a printer specific profile set the key.
  const overlay = (map: Map<string, Derived>): void => {
    for (const [key, d] of map) {
      if (tuned.has(key)) continue
      const def = settingDef(key)
      const shown = d.shaped ?? shapeFor(def, d.value, undefined)
      set(key, d.shaped ?? shapeFor(def, d.value, pend.get(key)?.value ?? base?.[key]), d.origin, `${def?.label ?? key} becomes ${formatValue(def, shown)}: ${d.because}.`, d.src)
    }
  }
  const toD = derive(to)
  overlay(toD)
  overlay(nozzleScaling(from, to, base))
  overlay(smartLayerFit(to, m, (k) => pend.get(k)?.value ?? base?.[k]))
  overlay(materialLimits(to, m, (k) => pend.get(k)?.value ?? base?.[k]))

  // 3. Stored calibration results for this spool, printer and nozzle.
  for (const cal of opts.calibrations ?? []) {
    if (cal.printer !== undefined && cal.printer !== to.printer) continue
    if (cal.filament !== undefined && cal.filament !== to.filament) continue
    if (cal.nozzleDiameter !== undefined && cal.nozzleDiameter !== to.nozzleDiameter) continue
    for (const w of K.calibrations[cal.id] ?? []) {
      const vf = w.valueFrom
      const raw = w.op === 'enable' ? true : w.op === 'disable' ? false : vf?.field !== undefined ? cal.values[vf.field] : w.value
      if (raw === undefined) continue
      const value = typeof raw === 'number' ? snap(raw * (vf?.factor ?? 1)) : raw
      const def = settingDef(w.key)
      set(w.key, shapeFor(def, value, pend.get(w.key)?.value ?? base?.[w.key]), 'calibration', `${w.why ?? 'From the calibration result.'} Stored ${cal.id.replaceAll('_', ' ')} result: ${formatValue(def, shapeFor(def, value, undefined))}.`, [])
    }
  }

  // 4. The merged intent goals.
  if (opts.intent && opts.intent.goals.length > 0) {
    const r = mergeIntent(opts.intent, {
      to,
      material: m,
      calibrations: opts.calibrations ?? [],
      scalar: (key) => firstScalar(pend.get(key)?.value ?? cur(key) ?? settingDef(key)?.default),
    })
    for (const [key, iv] of r.values) {
      const def = settingDef(key)
      set(key, shapeFor(def, iv.value, pend.get(key)?.value ?? base?.[key]), 'intent', iv.reason, iv.src, { goal: iv.goal, priority: iv.priority })
    }
    tellUser.push(...r.tellUser)
    advice.push(...r.advice)
    caveats.push(...r.caveats)
    questions.push(...r.questions)
    warnings.push(...r.warnings)
  }

  // sleipnir notes for this material.
  const smartMode = firstScalar(pend.get('smart_layer')?.value ?? base?.['smart_layer'])
  const notes = m?.smartLayerNotes
  if (notes && isSmartLayerOn(smartMode)) {
    if (smartMode === 'quality' && notes.quality) advice.push({ text: notes.quality, kind: 'material', sources: notes.src })
    if (smartMode === 'strength' && notes.strength) advice.push({ text: notes.strength, kind: 'material', sources: notes.src })
    if (notes.thinLayerCooling) advice.push({ text: notes.thinLayerCooling, kind: 'material', sources: notes.src })
  }

  const mat = m ? shortName(m.name) : ''
  const now = (key: string): SettingValue | undefined => pend.get(key)?.value ?? base?.[key]
  const nowNum = (key: string): number | undefined => {
    const v = firstScalar(now(key))
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const switched = from.filament !== to.filament

  // Thin layers: the minimum layer time guard, and the heat creep warning.
  const guard = smartMode !== undefined && isSmartLayerOn(smartMode) ? layerTimeGuard(m) : undefined
  if (m && guard) {
    const lt = nowNum('slow_down_layer_time')
    if (lt === undefined || lt < guard.minLayerTime) {
      set('slow_down_layer_time', shapeFor(settingDef('slow_down_layer_time'), guard.minLayerTime, now('slow_down_layer_time')), 'filament', `sleipnir prints thin layers, and ${mat} needs at least ${guard.minLayerTime} s per layer to cool them.`, guard.src)
    }
    if (firstScalar(now('slow_down_for_layer_cooling')) === false) {
      set('slow_down_for_layer_cooling', shapeFor(settingDef('slow_down_for_layer_cooling'), true, now('slow_down_for_layer_cooling')), 'filament', 'Thin layers need the cooling slowdown to stay at the minimum layer time.', guard.src)
    }
    if (guard.note) advice.push({ text: guard.note, kind: 'material', sources: guard.src })
    advice.push({ text: 'If many thin layers still fall under the minimum layer time, print more parts at once instead of slowing down further.', kind: 'workflow', sources: guard.src })
  }
  if (firstScalar(now('slow_down_for_layer_cooling')) !== false) {
    const minSpeed = nowNum('slow_down_min_speed')
    const maxFlow = nowNum('filament_max_volumetric_speed')
    const lh = nowNum('layer_height')
    const sMin = isSmartLayerOn(smartMode) ? nowNum('smart_layer_min_height') : undefined
    const heights = [lh, sMin].filter((h): h is number => h !== undefined)
    if (minSpeed !== undefined && maxFlow !== undefined && heights.length > 0) {
      const w = firstScalar(now('outer_wall_line_width'))
      const width = typeof w === 'string' && w.endsWith('%') ? (Number(w.slice(0, -1)) / 100) * to.nozzleDiameter : typeof w === 'number' && w > 0 ? w : typeof w === 'string' && Number(w) > 0 ? Number(w) : to.nozzleDiameter
      const warn = heatCreepWarning({ minSpeed, width, thinnest: Math.min(...heights), maxFlow })
      if (warn) warnings.push(warn)
    }
  }

  // Support pairings: interface materials, the soluble partner, the Z gap and the interface layers.
  const sup = m?.supports
  if (m && sup && firstScalar(now('enable_support')) === true) {
    if (switched) {
      for (const [key, v, why] of [
        ['support_top_z_distance', sup.topZ, `${mat} supports sit ${sup.topZ} mm above the model`],
        ['support_interface_top_layers', sup.interfaceLayers, `${mat} supports use ${sup.interfaceLayers} interface layers`],
      ] as const) {
        const o = pend.get(key)?.origin
        if (v === undefined || tuned.has(key) || o === 'intent' || o === 'calibration') continue
        set(key, shapeFor(settingDef(key), v, now(key)), 'filament', `${why}.`, sup.src)
      }
    }
    const names = sup.interfaceMaterials.map((id) => (K.materials[id] ? shortName(K.materials[id].name) : id))
    if (names.length > 0) advice.push({ text: `For cleaner supports under ${mat}, use ${names.join(', ')} as the interface material.${sup.note ? ' ' + sup.note : ''}`, kind: 'material', sources: sup.src })
    const sol = sup.solubleMaterial
    if (sol) advice.push({ text: `${K.materials[sol] ? shortName(K.materials[sol].name) : sol} is the soluble support for ${mat}${sup.solubleDissolve ? ` (dissolves in ${sup.solubleDissolve})` : ''}.`, kind: 'material', sources: sup.src })
  }

  // First layer and structure hints for the new material.
  if (m && switched) {
    if (m.firstLayer?.squishNote) advice.push({ text: m.firstLayer.squishNote, kind: 'material', sources: m.firstLayer.src })
    if (m.firstLayer?.bedNote) advice.push({ text: m.firstLayer.bedNote, kind: 'material', sources: m.firstLayer.src })
    const st = m.structure
    if (st?.wallsNote) advice.push({ text: st.wallsNote, kind: 'material', sources: st.src })
    if (st?.patternHint || st?.densityNote) advice.push({ text: `${mat} infill: ${st.patternHint ? `${st.patternHint} pattern` : 'any pattern'}${st.densityNote ? '. ' + st.densityNote : ''}`, kind: 'material', sources: st.src })
  }

  // 5 and 6. Diff against the current values, then clamp what remains.
  const changes: SettingChange[] = []
  for (const [key, pd] of [...pend].sort((x, y) => cmp(x[0], y[0]))) {
    const def = settingDef(key)
    const before = cur(key) ?? null
    if (before !== null && sameValue(before, pd.value)) continue
    if (before === null && !base && !fromD.has(key) && pd.origin !== 'intent' && pd.origin !== 'calibration' && !opts.target) continue
    const klass: PilotRule = def?.pilot ?? 'read'
    const label = def?.label ?? key
    let value = pd.value
    let reason = pd.reason
    let approval: 'none' | 'ask' = 'none'
    if (klass === 'read' && (pd.origin === 'intent' || pd.origin === 'calibration')) {
      refused.push({ key, requested: value, reason: `${label} is read only for mimir; change it in the profile.` })
      continue
    }
    const nums = klass === 'read' ? undefined : numbersOf(value)
    if (nums && !(def?.type === 'floatOrPercent')) {
      const clampTo = (limit: number, by: PlanClamp['by'], why: string): void => {
        const applied = mapNumbers(value, (n) => (by === 'printer' || by === 'filament' ? Math.min(n, limit) : n))
        clamps.push({ key, requested: value, applied, by, limit, reason: why })
        value = applied
      }
      // Catalog bounds: hard guardrails on what mimir writes.
      const lo = def?.min
      const hi = def?.max
      if ((lo !== undefined && nums.some((n) => n < lo)) || (hi !== undefined && nums.some((n) => n > hi))) {
        const applied = mapNumbers(value, (n) => Math.min(Math.max(n, lo ?? -Infinity), hi ?? Infinity))
        const limit = lo !== undefined && nums.some((n) => n < lo) ? lo : (hi as number)
        clamps.push({ key, requested: value, applied, by: 'bounds', limit, reason: `${label} is kept within ${lo ?? 'no minimum'} to ${hi ?? 'no maximum'}.` })
        value = applied
      }
      // Printer hardware limit: guarded keys are refused, edit keys are clamped.
      const limit = printerLimit(key, def, p)
      const now = numbersOf(value) ?? []
      if (limit !== undefined && now.some((n) => n > limit)) {
        if (klass === 'guarded') {
          refused.push({ key, requested: value, reason: `${formatValue(def, value)} is past the ${p?.name ?? 'printer'} limit of ${formatValue(def, limit)}.` })
          continue
        }
        clampTo(limit, 'printer', `${label} is capped at the ${p?.name ?? 'printer'} limit of ${formatValue(def, limit)}.`)
      }
      // Filament range: guarded keys need approval outside it, edit keys are clamped into it.
      const range = filamentRange(key, to, m)
      const inNow = numbersOf(value) ?? []
      if (range && inNow.some((n) => n < range[0] || n > range[1])) {
        if (klass === 'guarded') {
          approval = 'ask'
          reason += ` ${formatValue(def, value)} is outside ${shortName(m?.name ?? 'the filament')}'s range of ${range[0]} to ${range[1]}, so it needs approval.`
        } else {
          const applied = mapNumbers(value, (n) => Math.min(Math.max(n, range[0]), range[1]))
          clamps.push({ key, requested: value, applied, by: 'filament', limit: inNow.some((n) => n < range[0]) ? range[0] : range[1], reason: `${label} is kept inside ${shortName(m?.name ?? 'the filament')}'s range of ${range[0]} to ${range[1]}.` })
          value = applied
        }
      }
      // The material's own layer height band and speed ceilings.
      const cap = materialCap(key, to, m)
      const capNow = numbersOf(value) ?? []
      if (cap && capNow.some((n) => n < cap[0] - 1e-9 || n > cap[1] + 1e-9)) {
        const applied = mapNumbers(value, (n) => Math.min(Math.max(n, cap[0]), cap[1]))
        const mat = shortName(m?.name ?? 'the filament')
        clamps.push({
          key,
          requested: value,
          applied,
          by: 'filament',
          limit: capNow.some((n) => n < cap[0]) ? cap[0] : cap[1],
          reason: cap[0] === -Infinity ? `${label} is kept at or below ${formatValue(def, cap[1])} for ${mat}.` : `${label} is kept between ${formatValue(def, cap[0])} and ${formatValue(def, cap[1])} for ${mat}.`,
        })
        value = applied
      }
      if (before !== null && sameValue(before, value)) continue
    }
    const dir = ((): string | undefined => {
      const b = firstScalar(before ?? undefined)
      const a = firstScalar(value)
      return typeof a === 'number' && typeof b === 'number' && a !== b ? (a > b ? def?.effect?.increase : def?.effect?.decrease) : undefined
    })()
    if (dir && pd.origin !== 'intent') reason += ` ${dir}.`
    changes.push({
      key, label, section: def?.section ?? 'process', ...(def?.unit ? { unit: def.unit } : {}),
      before, after: value, reason, sources: [...new Set(pd.src)],
      origin: pd.origin, klass, approval, ...(pd.goal ? { goal: pd.goal } : {}), ...(pd.priority ? { priority: pd.priority } : {}),
    })
  }
  changes.sort((a, b) => cmp(a.section, b.section) || cmp(a.key, b.key))
  const plan = done(changes)
  for (const key of [...fromD.keys()].sort(cmp)) {
    if (!toD.has(key) && m && p) plan.unresolved.push({ key, reason: `No knowledge value for ${shortName(m.name)} on the ${p.name}; keep the current value.` })
  }
  plan.computedMs = Math.round((performance.now() - t0) * 100) / 100
  return plan
}

const FILAMENT_OVERRIDES = ['retraction_length', 'retraction_speed', 'deretraction_speed', 'z_hop']

/**
 * A copy of `config` with the plan's changes applied. `read` keys (machine profile values) are
 * skipped unless `includeRead` is set. Where the config carries a filament override of a printer
 * key (`filament_retraction_length`), that override is set too, since it would otherwise win.
 */
export function applyPlan(config: PrintConfig, plan: SettingsPlan, opts: { includeRead?: boolean } = {}): PrintConfig {
  const next: PrintConfig = { ...config }
  for (const c of plan.changes) {
    if (c.klass === 'read' && !opts.includeRead) continue
    next[c.key] = structuredClone(c.after)
    if (FILAMENT_OVERRIDES.includes(c.key) && next['filament_' + c.key] !== undefined) next['filament_' + c.key] = structuredClone(c.after)
  }
  return next
}
