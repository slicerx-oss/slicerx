// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

// Flush volumes: how much filament (mm3) a color change purges through the nozzle before the new color
// runs clean. The matrix has one row per filament changed from and one column per filament changed to.
// Auto flush is OrcaSlicer 2.4.2's and Bambu Studio's calculation (src/libslic3r/FlushVolCalc.cpp,
// FlushVolPredictor.cpp, and Plater.cpp get_min_flush_volumes and auto_calc_flushing_volumes_internal):
//   1. A pair of colors that are both within delta E 5 (CIEDE2000) of one of the twelve measured colors takes the
//      measured volume (resources/flush/flush_data_standard.txt).
//   2. Any other pair takes the color model: the hue and saturation distance plus a luminance term, joined at 120
//      degrees, with a floor of 60 mm3. Dual nozzle printers (nozzle_flush_dataset 1 and 2) use their own measured
//      sets, which already include the printer's minimum, and the model with Orca's 1.3 factor for a light filament
//      after a dark one.
//   3. The row's minimum is added: the printer's nozzle_volume less the filament a long retraction when cutting pulls
//      back (pi * 1.75^2 / 4 * the distance), per the filament it changes from.
// The flush multiplier scales the matrix when the slicer plans the tower; it is not baked into the numbers.

import { FLUSH_DEFAULTS, pairKey, type FlushSettings } from './flush-defaults'

export { FLUSH_DEFAULTS, pairKey }
export type { FlushSettings }

export const FLUSH_MAX = 20000
/** Highest value the dialog lets a person type, the same clamp the reference slicer keeps. */
export const FLUSH_LIMIT = FLUSH_MAX
export const FLUSH_DEFAULT = 280

import type { SettingValue } from '@slicerx/contracts'

const first = (v: SettingValue | undefined): unknown => (Array.isArray(v) ? v[0] : v)
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)

/** The printer's nozzle_volume as a whole number of mm3, 0 when it has none. */
export function printerMinFlush(nozzleVolume: SettingValue | undefined): number {
  const n = num(first(nozzleVolume))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** Orca's LongRectrationLevel: 0 off, 1 the machine decides, 2 each filament decides. */
export interface FlushPrinter {
  nozzleVolume: number
  level: number
  machineActivated: boolean
  /** retraction_distances_when_cut of the extruder, mm. */
  machineRetract: number
  /** nozzle_flush_dataset of the extruder. */
  dataset: number
}

export interface FlushFilament {
  /** filament_long_retractions_when_cut */
  activated: boolean
  /** filament_retraction_distances_when_cut, mm; null when the filament leaves it to the printer. */
  retract: number | null
}

/** The extra volume a change from this filament carries (Plater.cpp get_min_flush_volumes). */
export function minFlushFor(p: FlushPrinter, f: FlushFilament): number {
  let retract = p.level !== 0 && p.machineActivated ? Math.trunc(p.machineRetract) : 0
  if (!f.activated) retract = 0
  else if (p.level === 2) retract = f.retract !== null && Number.isFinite(f.retract) ? Math.trunc(f.retract) : Math.trunc(p.machineRetract)
  // The C++ subtracts a double from an int and stores it back: the result is cut toward zero.
  return Math.trunc(p.nozzleVolume - (Math.PI * 1.75 * 1.75 / 4) * retract)
}

/** The printer and slot filaments' flush inputs from a resolved configuration (the printer's, then one entry per slot). */
export function flushInputs(cfg: Record<string, SettingValue | undefined>, slots: number, extruder = 0): { printer: FlushPrinter; filaments: FlushFilament[]; mins: number[] } {
  const at = (key: string, i = 0): unknown => {
    const v = cfg[key]
    return Array.isArray(v) ? (v.length > i ? v[i] : v[0]) : v
  }
  const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true'
  const printer: FlushPrinter = {
    nozzleVolume: Number.isFinite(num(at('nozzle_volume', extruder))) ? Math.trunc(num(at('nozzle_volume', extruder))) : 0,
    level: Number.isFinite(num(cfg['enable_long_retraction_when_cut'])) ? Math.trunc(num(cfg['enable_long_retraction_when_cut'])) : 0,
    machineActivated: truthy(at('long_retractions_when_cut', extruder)),
    machineRetract: Number.isFinite(num(at('retraction_distances_when_cut', extruder))) ? num(at('retraction_distances_when_cut', extruder)) : 18,
    dataset: Number.isFinite(num(at('nozzle_flush_dataset', extruder))) ? Math.trunc(num(at('nozzle_flush_dataset', extruder))) : 0,
  }
  const filaments: FlushFilament[] = Array.from({ length: Math.max(1, slots) }, (_, i) => {
    const d = num(at('filament_retraction_distances_when_cut', i))
    return { activated: truthy(at('filament_long_retractions_when_cut', i)), retract: Number.isFinite(d) ? d : null }
  })
  return { printer, filaments, mins: filaments.map((f) => minFlushFor(printer, f)) }
}

/**
 * How many extruders the printer has (`nozzle_diameter` entries): the flush matrix holds one block per extruder, as
 * Bambu Studio reads it (`get_flush_volumes_matrix`). A printer without a diameter list counts its per-nozzle lists.
 */
export function extruderCount(cfg: Record<string, SettingValue | undefined>): number {
  const len = (k: string): number => {
    const v = cfg[k]
    return Array.isArray(v) ? v.length : 0
  }
  return Math.max(1, len('nozzle_diameter') || len('nozzle_flush_dataset'))
}

/**
 * The entry of the per-nozzle lists (`nozzle_volume`, `nozzle_flush_dataset`) that holds extruder `e` (0-based). A printer
 * whose lists run per extruder variant (the H2C: `printer_extruder_id` 1, 1, 1, 2, 2) takes the extruder's entry for its
 * nozzle volume type (Standard unless `nozzle_volume_type` says High Flow); other printers keep one entry per extruder.
 */
export function variantIndex(cfg: Record<string, SettingValue | undefined>, e: number): number {
  const ids = Array.isArray(cfg['printer_extruder_id']) ? (cfg['printer_extruder_id'] as unknown[]).map(Number) : []
  if (ids.length <= extruderCount(cfg)) return e
  const names = Array.isArray(cfg['printer_extruder_variant']) ? (cfg['printer_extruder_variant'] as unknown[]).map(String) : []
  const types = Array.isArray(cfg['nozzle_volume_type']) ? (cfg['nozzle_volume_type'] as unknown[]).map(String) : []
  const high = /high/i.test(types[e] ?? '')
  const mine = ids.flatMap((id, i) => (id === e + 1 ? [i] : []))
  return mine.find((i) => /high flow/i.test(names[i] ?? '') === high && !/e3d/i.test(names[i] ?? '')) ?? mine[0] ?? e
}

type Rgb = [number, number, number]

/** #rrggbb, or #rrggbbaa where a fully transparent color counts as white. */
export function parseHex(color: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim())
  if (!m) return null
  if (m[2] !== undefined && parseInt(m[2], 16) === 0) return [255, 255, 255]
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const luminance = ([r, g, b]: Rgb): number => (r * 0.3 + g * 0.59 + b * 0.11) / 255

function hsv([r, g, b]: Rgb): { h: number; s: number; v: number } {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const d = max - Math.min(R, G, B)
  let h = 0
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** Distance between the two colors as points on the hue wheel scaled by saturation and value, capped at 1.2. */
function hueSatDistance(a: Rgb, b: Rgb): { d: number; from: ReturnType<typeof hsv>; to: ReturnType<typeof hsv> } {
  const from = hsv(a)
  const to = hsv(b)
  const rad = Math.PI / 180
  const dx = Math.cos(from.h * rad) * from.s * from.v - Math.cos(to.h * rad) * to.s * to.v
  const dy = Math.sin(from.h * rad) * from.s * from.v - Math.sin(to.h * rad) * to.s * to.v
  return { d: Math.min(1.2, Math.hypot(dx, dy)), from, to }
}

// --- the measured data set -------------------------------------------------------------------------------------

const toLab = ([r8, g8, b8]: Rgb): [number, number, number] => {
  const gamma = (x: number): number => (x > 0.04045 ? Math.pow((x + 0.055) / 1.055, 2.4) : x / 12.92)
  const R = gamma(r8 / 255) * 100
  const G = gamma(g8 / 255) * 100
  const B = gamma(b8 / 255) * 100
  const x = 0.412453 * R + 0.35758 * G + 0.180423 * B
  const y = 0.212671 * R + 0.71516 * G + 0.072169 * B
  const z = 0.019334 * R + 0.119193 * G + 0.950227 * B
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 0.137931)
  const xn = f(x / 95.0489)
  const yn = f(y / 100)
  const zn = f(z / 108.884)
  return [116 * yn - 16, 500 * (xn - yn), 200 * (yn - zn)]
}

/** CIEDE2000 between two colors (FlushVolPredictor.cpp calc_color_distance). */
export function deltaE2000(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toLab(a)
  const [l2, a2, b2] = toLab(b)
  const p7 = Math.pow(25, 7)
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cMean = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cMean, 7) / (Math.pow(cMean, 7) + p7)))
  const pa1 = (1 + g) * a1
  const pa2 = (1 + g) * a2
  const pc1 = Math.hypot(pa1, b1)
  const pc2 = Math.hypot(pa2, b2)
  const hue = (y: number, x: number): number => {
    if (x === 0 && y === 0) return 0
    const h = Math.atan2(y, x)
    return h < 0 ? h + 2 * Math.PI : h
  }
  const h1 = hue(b1, pa1)
  const h2 = hue(b2, pa2)
  const dL = l2 - l1
  const dC = pc2 - pc1
  let dH = 0
  if (pc1 * pc2 !== 0) {
    dH = h2 - h1
    if (dH < -Math.PI) dH += 2 * Math.PI
    else if (dH > Math.PI) dH -= 2 * Math.PI
    dH = 2 * Math.sqrt(pc1 * pc2) * Math.sin(dH / 2)
  }
  const lMean = (l1 + l2) / 2
  const cBar = (pc1 + pc2) / 2
  const hSum = h1 + h2
  let hMean: number
  if (pc1 * pc2 === 0) hMean = hSum
  else if (Math.abs(h1 - h2) <= Math.PI) hMean = hSum / 2
  else hMean = hSum < 2 * Math.PI ? (hSum + 2 * Math.PI) / 2 : (hSum - 2 * Math.PI) / 2
  const rad = (d: number): number => (d * Math.PI) / 180
  const T = 1 - 0.17 * Math.cos(hMean - rad(30)) + 0.24 * Math.cos(2 * hMean) + 0.32 * Math.cos(3 * hMean + rad(6)) - 0.2 * Math.cos(4 * hMean - rad(63))
  const dTheta = rad(30) * Math.exp(-Math.pow((hMean - rad(275)) / rad(25), 2))
  const rC = 2 * Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + p7))
  const l50 = Math.pow(lMean - 50, 2)
  const sL = 1 + (0.015 * l50) / Math.sqrt(20 + l50)
  const sC = 1 + 0.045 * cBar
  const sH = 1 + 0.015 * cBar * T
  const rT = -Math.sin(2 * dTheta) * rC
  return Math.sqrt(Math.pow(dL / sL, 2) + Math.pow(dC / sC, 2) + Math.pow(dH / sH, 2) + rT * (dC / sC) * (dH / sH))
}

interface Measured {
  colors: Rgb[]
  volume: Map<string, number>
}

const measuredSets = new Map<number, Measured>()
const rgbKey = (c: Rgb): string => c.join(',')
// The measured tables (16 K of text) load on the first flush calculation, not with the shell. Until
// they land the color model alone answers, and the store is nudged so every flush value is redone.
let dataSets: Record<number, string> | null = null
let loading: Promise<void> | null = null

export function loadFlushData(): Promise<void> {
  if (dataSets) return Promise.resolve()
  loading ??= import('./flush-data').then((m) => {
    dataSets = { 0: m.FLUSH_DATA_STANDARD, 1: m.FLUSH_DATA_DUAL_STANDARD, 2: m.FLUSH_DATA_DUAL_HIGHFLOW }
    measuredSets.clear()
    // A store write every reader of flush values depends on; imported here so the store need not import this module.
    // It is a refresh, not an edit, so it leaves no undo step.
    return Promise.all([import('../state/store'), import('../plate/history')]).then(([s, h]) => h.quietly(() => s.set((state) => ({ flush: { ...state.flush } }))))
  })
  return loading
}

/** True once the measured tables are in; false means the values on screen come from the color model and will update. */
export const flushDataReady = (): boolean => dataSets !== null

function loadMeasured(dataset: number): Measured | undefined {
  if (!dataSets) {
    void loadFlushData()
    return undefined
  }
  const text = dataSets[dataset]
  if (text === undefined) return undefined
  const cached = measuredSets.get(dataset)
  if (cached) return cached
  const lines = text.split('\n')
  const colors = (lines[1] ?? '').trim().split(/\s+/).map((h) => parseHex(h)).filter((c): c is Rgb => c !== null)
  const volume = new Map<string, number>()
  for (const line of lines.slice(3)) {
    const [from, to, v] = line.trim().split(/\s+/)
    const a = from ? parseHex(from) : null
    const b = to ? parseHex(to) : null
    if (a && b && Number.isFinite(Number(v))) volume.set(`${rgbKey(a)}>${rgbKey(b)}`, Number(v))
  }
  const set = { colors, volume }
  measuredSets.set(dataset, set)
  return set
}

/** The measured volume for the pair in a data set, or null when either color is not within delta E 5 of a measured color or the pair is not in the table. */
export function measuredFlush(from: Rgb, to: Rgb, dataset = 0): number | null {
  const set = loadMeasured(dataset)
  if (!set) return null
  const near = (c: Rgb): Rgb | undefined => set.colors.find((m) => deltaE2000(m, c) <= 5)
  const a = near(from)
  const b = near(to)
  if (!a || !b) return null
  return set.volume.get(`${rgbKey(a)}>${rgbKey(b)}`) ?? null
}

/** The color model alone (FlushVolCalculator::calc_flush_vol_rgb after the data set), floored at 60 mm3. */
function modelFlush(a: Rgb, b: Rgb): number {
  const dist = hueSatDistance(a, b)
  let hs = dist.d
  const la = luminance(a)
  const lb = luminance(b)
  let lumi: number
  if (lb >= la) {
    lumi = Math.pow(lb - la, 0.7) * 560
  } else {
    lumi = (la - lb) * 80
    hs = Math.min(0.67 * dist.to.v + 0.33 * dist.from.v, hs)
  }
  const hsFlush = 230 * hs
  // Third side of a triangle whose other two sides are the hue term and the luminance term, 120 degrees apart.
  const side = Math.sqrt(hsFlush * hsFlush + lumi * lumi - 2 * hsFlush * lumi * Math.cos((120 * Math.PI) / 180))
  return Math.max(side, 60)
}

/** Purge volume in mm3 for changing from one color to another (FlushVolCalculator::calc_flush_vol), in whole mm3. Unparseable colors get the default. */
export function flushVolume(from: string, to: string, minExtra = 0, dataset = 0): number {
  const a = parseHex(from)
  const b = parseHex(to)
  if (!a || !b) return FLUSH_DEFAULT
  const data = measuredFlush(a, b, dataset)
  // The dual nozzle sets are final: no minimum is added to them (Orca returns before adding it).
  if (dataset !== 0 && data !== null) return Math.min(Math.trunc(data), FLUSH_MAX)
  let v: number = dataset === 0 && data !== null ? data : modelFlush(a, b)
  // A light filament after a dark one needs more with the dual nozzle sets.
  // Orca compares the 0 to 255 luminance with 180/255 and 75/255 here, so the test is true for almost any source and for a near black target; the port keeps that.
  const raw = ([r, g, bl]: Rgb): number => r * 0.3 + g * 0.59 + bl * 0.11
  if (dataset !== 0 && data === null && raw(a) > 180 / 255 && raw(b) < 75 / 255) v *= 1.3
  return Math.min(Math.trunc(v + minExtra), FLUSH_MAX)
}

/** The n by n matrix for the given slot colors, before the multiplier. Slot i is row and column i. The diagonal is 0. */
export function flushMatrix(colors: readonly string[], settings: FlushSettings = FLUSH_DEFAULTS, minExtra: number | readonly number[] = 0, dataset = 0): number[][] {
  const minOf = (i: number): number => (typeof minExtra === 'number' ? minExtra : (minExtra[i] ?? minExtra[0] ?? 0))
  return colors.map((from, i) =>
    colors.map((to, j) => {
      if (i === j) return 0
      const typed = settings.manual[pairKey(i + 1, j + 1)]
      return typed ?? flushVolume(from, to, minOf(i), dataset)
    }),
  )
}

/** The matrix flattened row by row, as the slicer config stores it. The multiplier travels as its own key. */
export function flushValues(colors: readonly string[], settings: FlushSettings = FLUSH_DEFAULTS, minExtra: number | readonly number[] = 0, dataset = 0): number[] {
  return flushMatrix(colors, settings, minExtra, dataset).flat()
}

export function clampFlush(v: number): number {
  return Number.isFinite(v) ? Math.min(FLUSH_LIMIT, Math.max(0, Math.round(v))) : FLUSH_DEFAULT
}
