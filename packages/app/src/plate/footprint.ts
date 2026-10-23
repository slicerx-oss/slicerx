// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the printer lays down around an object, as arrange and the off-the-bed checks need it: the brim
// (an automatic brim sized the way the engine sizes it), the raft, the support pad, the size
// compensation, and the skirt or draft shield around the whole print, and the room of the prime tower. Read
// from the same resolved configuration the slice uses, so the plate and the slice agree on how far the first
// layer reaches. The engine's own checks stay as they are; this only keeps arrange from placing what they
// would block.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { usedSlots } from '../filament/slots'
import type { AppState } from '../state/store'
import { MARGIN_SAFETY_MM, setMarginSource, type PrintMargins, type Rect } from './arrange'
import { plateConfig } from './plates'
import { areaOrigin, areaSize } from './bed-origin'
import { objectPrintMargins, marginNumber as num, marginText as text, marginFlag as flag } from '@slicerx/settings/print-margins'
export { autoBrimWidth } from '@slicerx/settings/print-margins'

type Inputs = Pick<AppState, 'easy' | 'overrides' | 'plate' | 'plates' | 'activePlate' | 'tower' | 'slice'>

/** The prime tower as the plate knows it: who picks its spot, where a hand placed one stands, and how big the last slice made it. */
export interface TowerState {
  /** The engine picks the spot (`prime_tower_auto_position`). */
  auto: boolean
  /** The hand placed front left corner on the plate, mm, used while auto is off. */
  x: number
  y: number
  /** The tower the last slice laid down: width and depth, mm, and its turn, degrees. */
  size?: { width: number; depth: number; angle: number }
}

/** The box `[min x, min y, max x, max y]` of a tower `w` by `d` with `margin` round it, from its front left corner, turned about it by `deg`. */
function towerReach(w: number, d: number, deg: number, margin: number): [number, number, number, number] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const pts = ([[-margin, -margin], [w + margin, -margin], [w + margin, d + margin], [-margin, d + margin]] as const).map(([x, y]) => [x * c - y * s, x * s + y * c] as const)
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
}

/**
 * The room the prime tower takes when the plate prints in two or more filaments: the tower, its brim and 1 mm, the
 * room the engine keeps objects' first layers out of (they keep their own brim and 1 mm more). The size is what the
 * last slice gave the tower, else `prime_tower_width` square. A hand placed tower is a fixed place nothing may print
 * on (`keepOut`). While the engine picks the spot (auto, the default), arrange keeps room for it at the configured
 * spot (`towerRoom`): the engine then finds that spot clear, or a nearer clear one. Either is pulled onto the bed the
 * way the engine pulls a tower there: its brim 1 mm inside the edge, past the loops of a skirt round the plate.
 */
function towerOf(cfg: Record<string, SettingValue>, tools: number, tower?: TowerState): { keepOut: Rect[]; towerRoom: Rect[] } {
  if (tools < 2 || !flag(cfg['enable_prime_tower'])) return { keepOut: [], towerRoom: [] }
  const auto = tower ? tower.auto : cfg['prime_tower_auto_position'] === undefined || flag(cfg['prime_tower_auto_position'])
  // The configuration places the tower on the machine; the plate counts from the printable area's corner.
  const [ox, oy] = areaOrigin(cfg['printable_area'])
  let x = tower && !tower.auto ? tower.x : num(cfg['wipe_tower_x'], 15) - ox
  let y = tower && !tower.auto ? tower.y : num(cfg['wipe_tower_y'], 220) - oy
  const width = tower?.size?.width ?? Math.max(5, num(cfg['prime_tower_width'], 35))
  const depth = tower?.size?.depth ?? width
  const angle = tower?.size?.angle ?? num(cfg['wipe_tower_rotation_angle'], 0)
  const brim = Math.max(0, num(cfg['prime_tower_brim_width'], 3))
  const bed = areaSize(cfg['printable_area'])
  if (bed) {
    const loops = Math.max(0, Math.floor(num(cfg['skirt_loops'], 0)))
    const skirted = loops > 0 && (num(cfg['skirt_height'], 1) > 0 || text(cfg['draft_shield']) === 'enabled')
    const spacing = Math.max(num(cfg['line_width'], 0), num(cfg['nozzle_diameter'], 0.4) * 1.2)
    const edge = 1 + (skirted ? Math.max(0, num(cfg['skirt_distance'], 2)) + loops * spacing : 0)
    const r = towerReach(width, depth, angle, brim)
    const inside = (v: number, lo: number, hi: number) => (hi < lo ? v : Math.min(hi, Math.max(lo, v)))
    x = inside(x, edge - r[0], bed.widthMm - edge - r[2])
    y = inside(y, edge - r[1], bed.depthMm - edge - r[3])
  }
  const r = towerReach(width, depth, angle, brim + MARGIN_SAFETY_MM)
  const box = [{ x: x + r[0], y: y + r[1], w: r[2] - r[0], h: r[3] - r[1] }]
  return auto ? { keepOut: [], towerRoom: box } : { keepOut: box, towerRoom: [] }
}

/**
 * The margins for a configuration, the number of filaments the plate prints in, and the prime tower as the plate has
 * it (without it, the configuration's `prime_tower_auto_position`, `wipe_tower_x` and `wipe_tower_y`).
 */
export function marginsFor(cfg: Record<string, SettingValue>, tools = 1, tower?: TowerState): PrintMargins {
  // Orca and Bambu Studio arrange a by-object plate with the extruder clearance between objects (Arrange.cpp).
  const byObject = text(cfg['print_sequence']) === 'by object'
  return {
    ...(byObject ? { apart: Math.max(0, num(cfg['extruder_clearance_radius'], 40)) + MARGIN_SAFETY_MM } : {}),
    ...objectPrintMargins(cfg),
    ...towerOf(cfg, tools, tower),
  }
}

/** The tower the last slice laid down, while it is on screen. */
function lastTower(s: Pick<AppState, 'slice'>) {
  return s.slice.status === 'done' ? s.slice.result.primeTower : s.slice.status === 'running' ? s.slice.last?.primeTower : undefined
}

let cached: { easy: unknown; overrides: unknown; plate: unknown; plates: unknown; activePlate: unknown; tower: unknown; reported: unknown; margins: PrintMargins } | null = null

/** The margins for the plate on screen, from the resolved configuration a slice of it would use. */
export function printMargins(s: Inputs): PrintMargins {
  const reported = lastTower(s)
  if (cached && cached.easy === s.easy && cached.overrides === s.overrides && cached.plate === s.plate && cached.plates === s.plates && cached.activePlate === s.activePlate && cached.tower === s.tower && cached.reported === reported) return cached.margins
  const cfg = { ...resolveConfig(s.easy, s.overrides), ...plateConfig(s.plates.find((p) => p.id === s.activePlate)) } as PrintConfig & Record<string, SettingValue>
  const tower: TowerState = { ...s.tower, ...(reported ? { size: { width: reported.width, depth: reported.depth, angle: reported.angle } } : {}) }
  const margins = marginsFor(cfg, usedSlots(s).size, tower)
  cached = { easy: s.easy, overrides: s.overrides, plate: s.plate, plates: s.plates, activePlate: s.activePlate, tower: s.tower, reported, margins }
  return margins
}

/** Makes arrange and the bed checks read the margins of the plate in the store. Call once with the store's getter. */
export function installPrintMargins(read: () => Inputs): void {
  setMarginSource(() => printMargins(read()))
}
