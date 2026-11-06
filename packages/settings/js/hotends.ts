// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printers whose hotends are their tools: one extruder that holds several hotends, each with its own filament path (the
// Bambu Lab H3C holds nine). Each filament the plate prints with takes a hotend of its own by the rule the engine uses
// (packages/core/src/nozzles.rs, hotend_ids): 2.85 mm TPU a TPU285 hotend, any other filament the next free other one,
// and filaments past the free hotends share the hotend the external AMS feeds. The app shows that pick before a slice,
// and the app and the MCP server read each filament's tool back from it. No other imports, so the app's startup shell
// can take it.

type Cfg = Record<string, unknown>

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
const strings = (v: unknown): string[] => list(v).map(String)

/** The volume type of a hotend for 2.85 mm TPU. */
export const TPU285 = 'TPU285'

/** The hotends of a printer whose hotends are its tools: one `nozzle_diameter` entry and more than one hotend; else 0. */
export function hotendCount(cfg: Cfg): number {
  const counts = list(cfg['extruder_max_nozzle_count'])
  if (counts.length !== 1 || list(cfg['nozzle_diameter']).length > 1) return 0
  const n = Math.round(Number(counts[0]))
  return Number.isFinite(n) && n > 1 ? n : 0
}

/** The volume type a project gives an extruder whose hotends are of more than one type. No variant is named for it. */
export const HYBRID = 'Hybrid'

/**
 * Each hotend's volume type: the types the printer reports for its hotends (`extruder_nozzle_volume_type`, in a project
 * synced with the printer) or `nozzle_volume_type` when either lists every hotend, else the printer's defaults, else
 * one for all, never Hybrid.
 */
export function hotendTypes(cfg: Cfg, n = hotendCount(cfg)): string[] {
  const reported = strings(cfg['extruder_nozzle_volume_type'])
  if (reported.length === n) return reported
  const given = strings(cfg['nozzle_volume_type'])
  if (given.length === n) return given
  const defaults = strings(cfg['default_nozzle_volume_type'])
  if (defaults.length === n) return defaults
  const one = [...given, ...defaults].find((t) => t !== HYBRID) ?? 'Standard'
  return Array.from({ length: n }, () => one)
}

/** The first TPU285 hotend (0-based), if the printer has one. */
export function tpuHotend(cfg: Cfg): number | undefined {
  const i = hotendTypes(cfg).indexOf(TPU285)
  return i < 0 ? undefined : i
}

/**
 * Filament `slot` (1-based) is 2.85 mm TPU, which feeds only a TPU285 hotend: a filament over 2.5 mm, or one whose
 * only extruder variant is the TPU285 one.
 */
export function tpu285Slot(cfg: Cfg, slot: number): boolean {
  const d = Number(list(cfg['filament_diameter'])[slot - 1] ?? list(cfg['filament_diameter'])[0])
  if (d > 2.5) return true
  const variants = strings(cfg['filament_extruder_variant'])
  const owners = strings(cfg['filament_self_index'])
  const mine = owners.length && owners.length === variants.length ? variants.filter((_, i) => owners[i] === String(slot)) : variants.length === Math.max(list(cfg['filament_diameter']).length, list(cfg['filament_colour']).length) ? variants.slice(slot - 1, slot) : []
  return mine.length > 0 && mine.every((v) => v.endsWith(TPU285))
}

/**
 * The hotend (0-based) of each of `slots` filaments when the slicer picks them: each filament in `used` (1-based slots)
 * takes the next free hotend in slot order, 2.85 mm TPU a TPU285 one and any other filament one of the others; the rest
 * share the hotend the external AMS feeds (`ams_nozzle_idx`, hotend 0). A filament the plate does not print with is on
 * hotend 0.
 */
export function autoHotends(cfg: Cfg, slots: number, used: readonly number[]): number[] {
  const n = hotendCount(cfg)
  const types = hotendTypes(cfg, n)
  const tpu = types.flatMap((t, h) => (t === TPU285 ? [h] : []))
  const other = types.flatMap((t, h) => (t === TPU285 ? [] : [h]))
  const clamp = (h: number) => Math.max(0, Math.min(n - 1, Math.round(h)))
  const shared = clamp(Number(list(cfg['ams_nozzle_idx'])[0] ?? 0) || 0)
  let nextTpu = 0
  let nextOther = 0
  return Array.from({ length: slots }, (_, i) => {
    const slot = i + 1
    if (!used.includes(slot)) return 0
    if (tpu285Slot(cfg, slot)) return tpu[nextTpu++] ?? tpu[tpu.length - 1] ?? shared
    return other[nextOther++] ?? shared
  })
}

/** One filament on its tool, as the app and the MCP server read it back. */
export interface HotendRow {
  /** The filament, 1-based. */
  slot: number
  /** The tool as the printer and the app number it, from 1. */
  tool: number
  /** The hotend index the engine and the G-code use, from 0. */
  hotend: number
  /** The tool is a TPU285 hotend, the one for 2.85 mm TPU. */
  tpuTool: boolean
  /** The filament is 2.85 mm TPU. */
  tpu285: boolean
}

/** The filaments in `used` (1-based slots) on their hotends (`map`, 0-based, index slot - 1). */
export function hotendRows(cfg: Cfg, map: readonly number[], used: readonly number[]): HotendRow[] {
  const types = hotendTypes(cfg)
  return [...used].sort((a, b) => a - b).map((slot) => {
    const hotend = map[slot - 1] ?? 0
    return { slot, tool: hotend + 1, hotend, tpuTool: types[hotend] === TPU285, tpu285: tpu285Slot(cfg, slot) }
  })
}

/**
 * Why a hand-set map of tools (from 1, index slot - 1) does not fit the printer, in plain words; null when it fits. The
 * engine refuses the same maps when it slices (a tool the printer lacks, 2.85 mm TPU off the TPU tool, any other
 * filament on it).
 */
export function hotendMapProblem(cfg: Cfg, tools: readonly number[]): string | null {
  const n = hotendCount(cfg)
  if (n === 0) return 'this printer has no tools to pick; only a printer whose hotends are its tools (the H3C) takes a tool map'
  const tpu = tpuHotend(cfg)
  for (const [i, t] of tools.entries()) {
    const slot = i + 1
    if (!Number.isInteger(t) || t < 1 || t > n) return `filament ${slot}: the printer has tools 1 to ${n}`
    if (tpu === undefined) continue
    if (tpu285Slot(cfg, slot) && t !== tpu + 1) return `filament ${slot} is 2.85 mm TPU, which prints only on the TPU tool (tool ${tpu + 1})`
    if (!tpu285Slot(cfg, slot) && t === tpu + 1) return `tool ${t} is the TPU tool, for 2.85 mm TPU only; put filament ${slot} on another tool`
  }
  return null
}

/**
 * The hotends (0-based, index slot - 1) a project set by hand on a printer whose hotends are its tools (the H3C):
 * `filament_map_mode` Manual with `filament_nozzle_map`. A filament the map leaves unset gets the slicer's pick, the
 * next hotend of its kind that no filament has (a TPU285 one for 2.85 mm TPU); one the plate does not print with is on
 * hotend 0. Undefined when the project lets the slicer pick or the printer has no tools to pick. The app's project open
 * and the MCP server's both read the map with it.
 */
export function projectHotends(settings: Cfg, cfg: Cfg, slots: number, used: readonly number[]): number[] | undefined {
  const n = hotendCount(cfg)
  const own = Array.isArray(settings['filament_nozzle_map']) ? settings['filament_nozzle_map'] : []
  if (!n || String(settings['filament_map_mode'] ?? '') !== 'Manual' || !own.length) return undefined
  const set = (i: number): number | undefined => {
    const v = own[i]
    const h = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return Number.isInteger(h) && h >= 0 && h < n ? h : undefined
  }
  const types = hotendTypes(cfg, n)
  const taken = new Set(Array.from({ length: slots }, (_, i) => set(i)).filter((h): h is number => h !== undefined))
  return Array.from({ length: slots }, (_, i) => {
    const mine = set(i)
    if (mine !== undefined) return mine
    if (!used.includes(i + 1)) return 0
    const tpu = tpu285Slot(cfg, i + 1)
    const free = types.findIndex((t, h) => (t === TPU285) === tpu && !taken.has(h))
    const h = free >= 0 ? free : Math.max(0, types.findIndex((t) => (t === TPU285) === tpu))
    taken.add(h)
    return h
  })
}
