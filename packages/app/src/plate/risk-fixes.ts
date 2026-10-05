// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One-click fixes for the plate risk report. A risk's settings go on its own object (brim and
// supports are per-object settings in OrcaSlicer and Bambu Studio), so one tall post gets a brim
// without the rest of the plate. z hop is a printer setting and goes on the plate. A brim is never
// made narrower than it already is. Open edges get the mesh repair. A finding the engine placed on the
// bed (thin walls, floating islands, long bridges) goes to the object under that place, or to the plate
// when none is; supports for the plate turn on the plate's Supports control. Nothing here slices or prints.
import type { SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { get, markStale, set, type AppState } from '../state/store'
import { objectOverrides, setObjectSetting } from './object-settings'
import { bounds } from './transform'

export type RiskId = 'warp' | 'tall_thin' | 'overhang' | 'open_edges' | 'first_layer' | 'thin_wall' | 'floating' | 'long_bridge'

export interface RiskFix {
  risk: RiskId
  /** Empty for a fix that applies to the whole plate. */
  objectId: string
  object: string
  /** The button text, sentence case with units. */
  label: string
  /** Per-object settings, Orca keys. */
  objectSettings: Record<string, SettingValue>
  /** Plate-wide settings, Orca keys (printer settings that cannot differ by object). */
  plateSettings: Record<string, SettingValue>
  repair: boolean
}

interface RiskRow {
  id?: unknown
  object?: unknown
  objectId?: unknown
  at?: unknown
  settings?: unknown
}

type Fixable = Pick<AppState, 'plate' | 'easy' | 'overrides' | 'objectSettings'>

const PLATE_KEYS = new Set(['z_hop_types'])

/** The object whose footprint holds a bed point, mm. */
function objectAt(s: Pick<AppState, 'plate'>, at: unknown) {
  if (!Array.isArray(at) || typeof at[0] !== 'number' || typeof at[1] !== 'number') return undefined
  const [x, y] = at as [number, number]
  return s.plate.find((p) => {
    if (p.printable === false) return false
    const b = bounds(p.parts, p.transform)
    return b !== null && b !== undefined && x >= b.min[0]! - 0.5 && x <= b.max[0]! + 0.5 && y >= b.min[1]! - 0.5 && y <= b.max[1]! + 0.5
  })
}

/** The fixes the risk report's output offers, one per risk that has one, for objects still on the plate. */
export function riskFixes(output: unknown, s: Pick<AppState, 'plate'>): RiskFix[] {
  const risks = (output && typeof output === 'object' ? (output as { risks?: unknown }).risks : null) ?? []
  if (!Array.isArray(risks)) return []
  const out: RiskFix[] = []
  for (const r of risks as RiskRow[]) {
    const risk = r.id as RiskId
    const placed = r.at !== undefined
    const entry = s.plate.find((p) => p.id === r.objectId) ?? s.plate.find((p) => p.name === r.object) ?? objectAt(s, r.at)
    // A finding the engine placed between objects is for the plate; any other needs its object.
    if (!entry && !placed) continue
    const settings = (r.settings && typeof r.settings === 'object' ? r.settings : {}) as Record<string, SettingValue>
    const objectSettings: Record<string, SettingValue> = {}
    const plateSettings: Record<string, SettingValue> = {}
    for (const [k, v] of Object.entries(settings)) (PLATE_KEYS.has(k) || !entry ? plateSettings : objectSettings)[k] = v
    const repair = risk === 'open_edges' && entry !== undefined
    if (!repair && Object.keys(settings).length === 0) continue
    out.push({ risk, objectId: entry?.id ?? '', object: entry?.name ?? 'the plate', label: fixLabel(risk, settings, entry !== undefined), objectSettings, plateSettings, repair })
  }
  return out
}

function fixLabel(risk: RiskId, st: Record<string, SettingValue>, onObject: boolean): string {
  if (risk === 'open_edges') return 'Repair the mesh'
  if (st.enable_support === true) return onObject ? 'Turn on supports for this object' : 'Turn on supports'
  if (st.wall_generator === 'arachne') return onObject ? 'Use Arachne walls for this object' : 'Use Arachne walls'
  const parts: string[] = []
  if (typeof st.brim_width === 'number') parts.push(`Add a brim ${st.brim_width} mm wide`)
  if (typeof st.z_hop_types === 'string') parts.push(`${st.z_hop_types} z hop`)
  return parts.length ? parts.join(' and ') : 'Apply the fix'
}

/** The settings the object prints with now: the plate's, then its own. */
function effective(s: Fixable, objectId: string): Record<string, SettingValue> {
  const entry = s.plate.find((p) => p.id === objectId)
  const plate = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue>
  return entry ? { ...plate, ...objectOverrides(s, entry) } : plate
}

const sameZHop = (cur: SettingValue | undefined, want: SettingValue): boolean => (Array.isArray(cur) ? cur.length > 0 && cur.every((v) => v === want) : cur === want)

/** True when every setting of the fix is already in place, so the button has nothing to do. */
export function fixInPlace(fix: RiskFix, s: Fixable = get()): boolean {
  if (fix.repair) return false
  const cfg = effective(s, fix.objectId)
  for (const [k, v] of Object.entries(fix.objectSettings)) {
    if (k === 'brim_width') {
      if (typeof cfg.brim_width !== 'number' || cfg.brim_width < (v as number)) return false
    } else if (k === 'brim_type') {
      if (typeof cfg.brim_type !== 'string' || cfg.brim_type === 'no_brim') return false
    } else if (cfg[k] !== v) return false
  }
  for (const [k, v] of Object.entries(fix.plateSettings)) if (!(k === 'z_hop_types' ? sameZHop(cfg[k], v) : cfg[k] === v)) return false
  return true
}

/**
 * The settings the fix writes, given what is in place: a brim keeps its own type when it has one
 * and only widens; a per-extruder list gets the value for every extruder.
 */
export function fixPatch(fix: RiskFix, s: Fixable = get()): { object: Record<string, SettingValue>; plate: Record<string, SettingValue> } {
  const cfg = effective(s, fix.objectId)
  const object: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(fix.objectSettings)) {
    if (k === 'brim_type' && typeof cfg.brim_type === 'string' && cfg.brim_type !== 'no_brim') continue
    if (k === 'brim_width' && typeof cfg.brim_width === 'number' && cfg.brim_width >= (v as number)) continue
    if (cfg[k] === v) continue
    object[k] = v
  }
  const plate: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(fix.plateSettings)) {
    const cur = cfg[k]
    if (k === 'z_hop_types' && sameZHop(cur, v)) continue
    plate[k] = Array.isArray(cur) && typeof v === 'string' ? (cur.map(() => v) as string[]) : v
  }
  return { object, plate }
}

/** Applies a fix. `repair` runs the mesh repair on the object; it is passed in so this file stays free of the slicer host. */
export async function applyRiskFix(fix: RiskFix, repair: () => Promise<unknown>): Promise<void> {
  if (fix.repair) {
    set({ selection: fix.objectId, selectedIds: [fix.objectId] })
    await repair()
    return
  }
  const { object, plate } = fixPatch(fix)
  for (const [k, v] of Object.entries(object)) setObjectSetting(fix.objectId, k, v)
  // Supports for the whole plate are the Supports control, so it shows them on.
  const { enable_support: supports, ...rest } = plate
  if (supports === true) set((s) => ({ easy: { ...s.easy, supports: 'auto' } }))
  if (Object.keys(rest).length) set((s) => ({ overrides: { ...s.overrides, ...rest } }))
  markStale()
}
