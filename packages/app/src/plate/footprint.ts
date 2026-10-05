// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the printer lays down around an object, as arrange and the off-the-bed checks need it: the brim
// (an automatic brim sized the way the engine sizes it), the raft, the support pad, the size
// compensation, and the skirt or draft shield around the whole print. Read from the same resolved
// configuration the slice uses, so the plate and the slice agree on how far the first layer reaches. The
// engine's own checks stay as they are; this only keeps arrange from placing what they would block.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { usedSlots } from '../filament/slots'
import type { AppState } from '../state/store'
import { MARGIN_SAFETY_MM, setMarginSource, type PrintMargins, type PrintSize, type Rect } from './arrange'
import { plateConfig } from './plates'
import { areaOrigin } from './bed-origin'

type Inputs = Pick<AppState, 'easy' | 'overrides' | 'plate' | 'plates' | 'activePlate'>

/** First element of a per-filament list, else the value; a number or a numeric string. */
function num(v: SettingValue | undefined, fallback: number): number {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'string' ? Number.parseFloat(x) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function text(v: SettingValue | undefined): string {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'string' ? x : ''
}

function flag(v: SettingValue | undefined): boolean {
  const x = Array.isArray(v) ? v[0] : v
  return x === true || x === 1 || x === '1' || x === 'true'
}

/** Orca's adhesion coefficient and thermal length by material, as the engine's automatic brim uses them. */
function material(cfg: Record<string, SettingValue>): { adhesion: number; thermal: number } {
  const name = text(cfg['filament_type'])
  const nylon = name === 'PA' || name.startsWith('PA-') || /^PA\d/.test(name)
  const adhesion = name === 'FLEX' || name === 'TPU' ? 0.5 : ['PCTG', 'PET', 'PET-CF', 'PET-GF', 'PETG'].includes(name) ? 2 : 1
  const thermal = name === 'FLEX' || name === 'TPU' ? 1000 : name === 'PC' || name === 'PC-PBT' ? 40 : name === 'PC-ABS' || name === 'PC-CF' ? 80 : name.startsWith('ABS') || name.startsWith('ASA') || nylon || name.startsWith('PET') ? 100 : 200
  return { adhesion, thermal }
}

/**
 * The width of the engine's automatic brim for a footprint as wide and deep as the object's bounds (the
 * engine's `brim::width`, from the second moment of area, the height, the top speed and the material).
 * A real footprint can have less area than its bounds, which only makes the brim wider, so the figure is
 * raised by a quarter. Zero when the engine would print no brim.
 */
export function autoBrimWidth(cfg: Record<string, SettingValue>, size: PrintSize): number {
  const { w, h, height } = size
  if (!(w > 0 && h > 0 && height > 0)) return 0
  const diagonal = Math.hypot(w, h)
  const ixx = (w * h ** 3) / 12
  const iyy = (h * w ** 3) / 12
  const speed = Math.max(0, ...['inner_wall_speed', 'outer_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'support_speed'].map((k) => num(cfg[k], 0)))
  const { adhesion, thermal } = material(cfg)
  const heightToArea = (Math.max((height / ixx) * h, (height / iyy) * w) * height) / 1920
  const raw = adhesion * Math.min(18, 1.5 * diagonal, Math.max(heightToArea * speed, (diagonal * 8 * Math.min(height, 30)) / thermal / 30))
  if (raw < 5 && raw < 1.5 * diagonal) return 0
  return Math.min(18, Math.min(raw, 18) * 1.25)
}

/** How far the first layer of the object itself reaches past its outline (brim, raft, size compensation), mm. */
function growOf(cfg: Record<string, SettingValue>, size: PrintSize): number {
  const kind = text(cfg['brim_type']) || 'auto_brim'
  const width = Math.max(0, num(cfg['brim_width'], 0))
  const gap = Math.max(0, num(cfg['brim_object_gap'], 0))
  // Painted and ear brims are discs the width of the brim; an inner-only brim stays inside the part.
  const brim = kind === 'no_brim' || kind === 'inner_only' ? 0 : kind === 'auto_brim' ? Math.max(autoBrimWidth(cfg, size), width) : width
  let grow = brim > 0 ? brim + gap : 0
  if (num(cfg['raft_layers'], 0) > 0) grow += Math.max(0, num(cfg['raft_expansion'], 1.5), num(cfg['raft_first_layer_expansion'], 2))
  return grow + Math.max(0, num(cfg['xy_contour_compensation'], 0))
}

/**
 * How far support reaches past the outline, mm, or 0 with support off. It stays under the object, but its
 * first layer pad widens by `raft_first_layer_expansion` and a tree support has a brim of its own. Objects
 * that need no support print none, so this is a safe upper bound, used only against the bed edge.
 */
function supportOf(cfg: Record<string, SettingValue>): number {
  if (!flag(cfg['enable_support'])) return 0
  const pad = Math.max(0, num(cfg['raft_first_layer_expansion'], 2), num(cfg['support_expansion'], 0)) + Math.max(0, num(cfg['support_object_xy_distance'], 0.35))
  return pad + (text(cfg['support_type']).startsWith('tree') ? Math.max(0, num(cfg['tree_support_brim_width'], 3)) : 0)
}

/** The skirt or draft shield: how far past the part (and its brim) the outermost loop lies, or 0 without one. */
function skirtOf(cfg: Record<string, SettingValue>, grow: number): number {
  const shield = text(cfg['draft_shield']) === 'enabled'
  const loops = Math.max(0, Math.floor(num(cfg['skirt_loops'], 0)))
  if (loops === 0 && !shield) return 0
  const nozzle = num(cfg['nozzle_diameter'], 0.4)
  const spacing = Math.max(num(cfg['line_width'], 0), nozzle * 1.2)
  const brim = text(cfg['brim_type']) === 'no_brim' ? 0 : Math.max(0, num(cfg['brim_width'], 0))
  // The engine puts the skirt at the brim width plus the skirt distance from the outline, or from the brim with a draft shield.
  return Math.max(grow, brim) + Math.max(0, num(cfg['skirt_distance'], 2)) + Math.max(1, loops) * spacing
}

/** The room the prime tower takes when the plate prints in two or more filaments, at its configured place. */
function towerOf(cfg: Record<string, SettingValue>, tools: number): Rect[] {
  if (tools < 2 || !flag(cfg['enable_prime_tower'])) return []
  // The configuration places the tower on the machine; the plate counts from the printable area's corner.
  const [ox, oy] = areaOrigin(cfg['printable_area'])
  const x = num(cfg['wipe_tower_x'], 15) - ox
  const y = num(cfg['wipe_tower_y'], 220) - oy
  const side = Math.max(5, num(cfg['prime_tower_width'], 35))
  const pad = Math.max(0, num(cfg['prime_tower_brim_width'], 3)) + 1
  return [{ x: x - pad, y: y - pad, w: side + 2 * pad, h: side + 2 * pad }]
}

/** The margins for a configuration and the number of filaments the plate prints in. */
export function marginsFor(cfg: Record<string, SettingValue>, tools = 1): PrintMargins {
  const keepOut = towerOf(cfg, tools)
  const support = supportOf(cfg)
  // Orca and Bambu Studio arrange a by-object plate with the extruder clearance between objects (Arrange.cpp).
  const byObject = text(cfg['print_sequence']) === 'by object'
  return {
    ...(byObject ? { apart: Math.max(0, num(cfg['extruder_clearance_radius'], 40)) + MARGIN_SAFETY_MM } : {}),
    grow: (size) => growOf(cfg, size),
    reach: (size) => {
      const own = Math.max(growOf(cfg, size), support)
      return Math.max(own, skirtOf(cfg, own))
    },
    skirt: skirtOf(cfg, 0) > 0,
    keepOut,
  }
}

let cached: { easy: unknown; overrides: unknown; plate: unknown; plates: unknown; activePlate: unknown; margins: PrintMargins } | null = null

/** The margins for the plate on screen, from the resolved configuration a slice of it would use. */
export function printMargins(s: Inputs): PrintMargins {
  if (cached && cached.easy === s.easy && cached.overrides === s.overrides && cached.plate === s.plate && cached.plates === s.plates && cached.activePlate === s.activePlate) return cached.margins
  const cfg = { ...resolveConfig(s.easy, s.overrides), ...plateConfig(s.plates.find((p) => p.id === s.activePlate)) } as PrintConfig & Record<string, SettingValue>
  const margins = marginsFor(cfg, usedSlots(s).size)
  cached = { easy: s.easy, overrides: s.overrides, plate: s.plate, plates: s.plates, activePlate: s.activePlate, margins }
  return margins
}

/** Makes arrange and the bed checks read the margins of the plate in the store. Call once with the store's getter. */
export function installPrintMargins(read: () => Inputs): void {
  setMarginSource(() => printMargins(read()))
}
