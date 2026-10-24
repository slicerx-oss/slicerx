// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What arrange keeps clear of and the request sx-geom's nest takes, shared by the app and the MCP server so both lay a
// plate out the same way: the printer's excluded areas, the prime tower's room, and each part's outline with how far
// its first layer and its print reach past it (print-margins.ts). Pure, so either host runs it next to its own engine
// call: the app's geometry worker, the server's sx-geom.
import type { SettingValue } from '@slicerx/contracts'
import { marginFlag as flag, marginNumber as num, marginText as text, objectPrintMargins, type FirstLayerShape, type PrintSize } from './print-margins'

type Pt = [number, number]

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Room kept between two printed things beyond what is computed, mm: the engine rounds a brim up to whole lines. */
export const MARGIN_SAFETY_MM = 1

// The printer's `bed_exclude_area` as polygons. Profiles store it as a list of points, either as number pairs
// (resolved profiles) or as "XxY" text (the profile files' own form, and what a person types in printer settings). Up
// to four points are one polygon; a longer list is one per four points, which is how the Qidi X-Plus 4 lists its two
// corner strips. A list or group without area, such as the usual [[0, 0]], means none.

function point(v: unknown): Pt | null {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) return [v[0] as number, v[1] as number]
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*x\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(v)
    if (m) return [Number(m[1]), Number(m[2])]
  }
  return null
}

function area(p: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i] as Pt
    const [x1, y1] = p[(i + 1) % p.length] as Pt
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/** Polygons to hatch on the bed; empty when the printer has none. */
export function excludedPolygons(value: unknown): Pt[][] {
  const items = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  const pts = items.map(point).filter((p): p is Pt => p !== null)
  return groups(pts).filter((g) => g.length >= 3 && area(g) > 0.01)
}

/** One polygon of up to four points, else one per four points with a shorter tail dropped. */
function groups<T>(pts: readonly T[]): T[][] {
  if (pts.length <= 4) return [[...pts]]
  const out: T[][] = []
  for (let i = 0; i + 4 <= pts.length; i += 4) out.push(pts.slice(i, i + 4))
  return out
}

/**
 * The printer profile keys that name areas of the bed nothing may print in, as the slice reads them
 * (packages/core/src/collide/plate.rs `zones`): the excluded areas, and the corner a printer runs its nozzle wrap
 * check in (the Bambu Lab A1 family). Arrange, the plate and the MCP server's arrange keep off all of them.
 */
export const KEEP_OUT_KEYS = ['bed_exclude_area', 'head_wrap_detect_zone'] as const

/** Every keep-out area of `cfg` (KEEP_OUT_KEYS) as polygons, machine coordinates. */
export function keepOutPolygons(cfg: Readonly<Record<string, unknown>>): Pt[][] {
  return KEEP_OUT_KEYS.flatMap((k) => excludedPolygons(cfg[k]))
}

/** The box around each keep-out area of `cfg` (keepOutPolygons), machine coordinates. */
export function keepOutBoxes(cfg: Readonly<Record<string, unknown>>): Rect[] {
  return KEEP_OUT_KEYS.flatMap((k) => excludeBoxes(cfg[k]))
}

/** The box around each polygon of a `bed_exclude_area` value (see `excludedPolygons`), in machine coordinates. */
export function excludeBoxes(points: unknown): Rect[] {
  return excludedPolygons(points).map((pts) => {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  })
}

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

/** The printable area as the plate counts it: where its front left corner sits on the machine, and its size when known. */
export interface PlateArea {
  origin: readonly [number, number]
  size: { widthMm: number; depthMm: number } | null
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
 * The room the prime tower takes when the plate prints in two or more filaments, in plate coordinates: the tower, its
 * brim and 1 mm, the room the engine keeps objects' first layers out of (they keep their own brim and 1 mm more). The
 * size is what the last slice gave the tower, else `prime_tower_width` square. A hand placed tower is a fixed place
 * nothing may print on (`keepOut`). While the engine picks the spot (auto, the default), arrange keeps room for it at
 * the configured spot (`towerRoom`): the engine then finds that spot clear, or a nearer clear one. Either is pulled
 * onto the bed the way the engine pulls a tower there: its brim 1 mm inside the edge, past the loops of a skirt round
 * the plate.
 */
export function towerRoomOf(cfg: Record<string, SettingValue>, tools: number, plate: PlateArea, tower?: TowerState): { keepOut: Rect[]; towerRoom: Rect[] } {
  if (tools < 2 || !flag(cfg['enable_prime_tower'])) return { keepOut: [], towerRoom: [] }
  const auto = tower ? tower.auto : cfg['prime_tower_auto_position'] === undefined || flag(cfg['prime_tower_auto_position'])
  // The configuration places the tower on the machine; the plate counts from the printable area's corner.
  const [ox, oy] = plate.origin
  let x = tower && !tower.auto ? tower.x : num(cfg['wipe_tower_x'], 15) - ox
  let y = tower && !tower.auto ? tower.y : num(cfg['wipe_tower_y'], 220) - oy
  const width = tower?.size?.width ?? Math.max(5, num(cfg['prime_tower_width'], 35))
  const depth = tower?.size?.depth ?? width
  const angle = tower?.size?.angle ?? num(cfg['wipe_tower_rotation_angle'], 0)
  const brim = Math.max(0, num(cfg['prime_tower_brim_width'], 3))
  const bed = plate.size
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
 * The clearance radius a plate printed by object is held to, the engine's own choice (collide `clearance_radius`):
 * Bambu Studio's `extruder_clearance_max_radius` on a Bambu Lab printer, `extruder_clearance_radius` on the others.
 * The by-object check and arrange both take it from here, so arrange spaces a plate the way the check reads it.
 */
export function clearanceRadius(cfg: Record<string, SettingValue>): number {
  const model = cfg['printer_model']
  const bambu = cfg['gcode_flavor'] === 'bambu' || (typeof model === 'string' && model.startsWith('Bambu Lab'))
  const radius = num(cfg['extruder_clearance_radius'], 40)
  // Orca's Bambu Lab profiles carry the max radius in extruder_clearance_radius (73 mm for the A1).
  return bambu ? Math.max(num(cfg['extruder_clearance_max_radius'], 68), radius) : radius
}

/**
 * The margins of a plate: what prints round each object (print-margins.ts), the spacing of a plate printed by object,
 * and the prime tower's place or room for a plate printed in `tools` filaments.
 */
export function plateMargins(cfg: Record<string, SettingValue>, tools: number, plate: PlateArea, tower?: TowerState) {
  // Printing by object, arrange keeps the clearance the by-object check holds the plate to between objects.
  const byObject = text(cfg['print_sequence']) === 'by object'
  return {
    ...(byObject ? { apart: Math.max(0, clearanceRadius(cfg)) + MARGIN_SAFETY_MM } : {}),
    ...objectPrintMargins(cfg),
    ...towerRoomOf(cfg, tools, plate, tower),
  }
}

/** An outline seen from above, as sx-geom gives and takes it: the outer ring and its holes, mm. */
export interface NestOutline {
  outer: Pt[]
  holes: Pt[][]
}

/** What an object covers seen from above (`nest.footprint`): its outline, its exact hull, and what it stands on when asked. */
export interface NestFootprint {
  polygons: NestOutline[]
  hull: Pt[]
  /** Its first layer: everything up to the cut asked for above its lowest point. */
  base?: NestOutline[]
}

/** How far what prints round an object reaches past it, as print-margins.ts gives it, plus a by-object plate's spacing. */
export interface NestMargins {
  grow(size: PrintSize, base?: readonly FirstLayerShape[]): number
  reach(size: PrintSize, base?: readonly FirstLayerShape[]): number
  skirt: boolean
  /** Printing by object: the extruder clearance between objects, mm. */
  apart?: number
}

export interface NestItem {
  id: string
  polygons: NestOutline[]
  hull: Pt[]
  grow: number
  reach: number
  copies: number
}

/** Turn step for arrange and fill the bed, degrees, when turning is allowed. */
export const NEST_STEP_DEFAULT = 10

/**
 * The work each effort may spend after the first layout, in sx-geom's units (vertices through its polygon operations;
 * packages/geom/src/nest/place.rs DEFAULT_BUDGET is normal). Counted work, not time, so the same plate gives the same
 * layout on any machine. Normal is about a second on a typical plate in the browser and a few on a crowded one.
 */
export const NEST_BUDGET = { quick: 1.5e6, normal: 6e6, thorough: 24e6 } as const

export const rectOutline = (r: Rect): NestOutline => ({ outer: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], holes: [] })

/**
 * One object for the nest: its footprint (the box `bounds` when it has no outline, such as a point cloud or a part
 * still loading) grown by what prints round it. The automatic brim grows from the first layer; without one (nothing
 * touches the bed) the bounds estimate it.
 */
export function nestItem(id: string, foot: NestFootprint, size: PrintSize, bounds: Rect | undefined, margins: NestMargins, copies = 1): NestItem {
  let { polygons, hull } = foot
  if (polygons.length === 0 && bounds) {
    polygons = [rectOutline(bounds)]
    hull = []
  }
  const first = foot.base && foot.base.length > 0 ? foot.base : undefined
  return { id, polygons, hull, grow: margins.grow(size, first), reach: margins.reach(size, first), copies }
}

/**
 * The spacing a plate printed by object keeps between footprints, mm: `apart` (the clearance radius and the safety)
 * and the farthest of the objects' `reaches`, what each prints round itself (brim, raft, support pad, its own skirt).
 * heimdall holds every move of the object printing to the radius from the finished object's footprint
 * (core/src/collide/walk.rs, the close check), its brim and skirt moves too, so the reach comes on top of the radius.
 * Undefined by layer.
 */
export function byObjectApart(apart: number | undefined, reaches: readonly number[]): number | undefined {
  return apart ? apart + Math.max(0, ...reaches) : apart
}

/**
 * How far an arrange keeps an object's outline from a zone, mm, for an object whose brim and the like reach `grow` and
 * everything printed `reach`: the nest keeps the larger of its edge spacing and its half spacing (packages/geom/src/
 * nest/place.rs edge_of and half_of), the box packer (`nest` false) the edge spacing.
 */
export function zoneKeep(grow: number, reach: number, gapMm: number, apart = 0, nest = true): number {
  const edge = Math.max(gapMm, reach > 0 ? reach + MARGIN_SAFETY_MM : 0)
  return nest ? Math.max(edge, gapMm / 2, apart / 2, grow > 0 ? grow + MARGIN_SAFETY_MM / 2 : 0) : edge
}

/** An object of a finished layout: its box on the bed, how far what prints round it reaches, and how far it keeps from a zone. */
export interface LaidOut {
  box: Rect
  reach: number
  keep?: number
}

/**
 * The shift, mm, that moves a finished layout as a whole toward the middle of the bed, the way the nest centers one
 * when nothing stays: in whole `cellMm` steps (the engine's lattice, so its by-object rules see the same rows and
 * columns), no further than keeps every object and its reach on the bed, and none when that would bring an object,
 * grown by its keep, onto one of `zones`, or on a round bed.
 */
export function layoutCenterShift(items: readonly LaidOut[], bed: { widthMm: number; depthMm: number; round?: boolean | undefined }, zones: readonly Rect[] = [], cellMm = 1): [number, number] {
  if (items.length === 0 || bed.round) return [0, 0]
  const along = (size: number, from: (r: Rect) => number, len: (r: Rect) => number): number => {
    const lo = Math.max(...items.map((i) => i.reach - from(i.box)))
    const hi = Math.min(...items.map((i) => size - i.reach - from(i.box) - len(i.box)))
    const mid = (Math.min(...items.map((i) => from(i.box))) + Math.max(...items.map((i) => from(i.box) + len(i.box)))) / 2
    const [min, max] = [Math.min(lo, 0), Math.max(hi, 0)]
    const want = Math.min(max, Math.max(min, size / 2 - mid))
    const whole = Math.round(want / cellMm) * cellMm
    return (whole >= min && whole <= max ? whole : Math.trunc(want / cellMm) * cellMm) || 0
  }
  const shift: [number, number] = [along(bed.widthMm, (r) => r.x, (r) => r.w), along(bed.depthMm, (r) => r.y, (r) => r.h)]
  const meets = items.some((i) => {
    const k = i.keep ?? 0
    const b = { x: i.box.x + shift[0] - k, y: i.box.y + shift[1] - k, w: i.box.w + 2 * k, h: i.box.h + 2 * k }
    return zones.some((z) => b.x < z.x + z.w && z.x < b.x + b.w && b.y < z.y + z.h && z.y < b.y + b.h)
  })
  return meets ? [0, 0] : shift
}

/** The request for `nest.start` or `nest.arrange`. */
export interface NestRequest {
  bed: { widthMm: number; depthMm: number; round?: boolean }
  items: readonly NestItem[]
  /** Objects that stay where they are. */
  fixed: readonly NestItem[]
  /** The printer's excluded areas, in plate coordinates. */
  avoid: readonly Rect[]
  /** The prime tower's place or room, in plate coordinates: the skirt goes round these. */
  towers: readonly Rect[]
  margins: NestMargins
  gapMm: number
  rotate: boolean
  stepDeg?: number | undefined
  effort?: keyof typeof NEST_BUDGET | undefined
  /** Move the finished layout to the middle of the bed. */
  center: boolean
}

/** The problem sx-geom's nest takes, in its own key order, so the same plate always sends the same request. */
export function nestProblem(r: NestRequest) {
  return {
    // A round bed (a delta) keeps every outline inside its circle, not the circle's box.
    bed: { widthMm: r.bed.widthMm, depthMm: r.bed.depthMm, ...(r.bed.round ? { round: true } : {}) },
    items: r.items,
    fixed: r.fixed.map(({ copies: _c, ...f }) => f),
    // The prime tower's boxes go last: the skirt round the whole print goes round the tower too.
    zones: [...r.avoid, ...r.towers].map((z) => ({ polygons: [rectOutline(z)] })),
    options: {
      gapMm: r.gapMm,
      // Printing by object: the extruder clearance between objects, the bed edge keeping the gap. Sent only when set.
      ...(r.margins.apart ? { apartMm: byObjectApart(r.margins.apart, [...r.items, ...r.fixed].map((i) => i.reach)) } : {}),
      safetyMm: MARGIN_SAFETY_MM,
      rotate: r.rotate,
      rotationStepDeg: r.stepDeg ?? NEST_STEP_DEFAULT,
      skirt: r.margins.skirt,
      ...(r.towers.length > 0 ? { towerZones: r.towers.length } : {}),
      center: r.center,
      budget: NEST_BUDGET[r.effort ?? 'normal'],
    },
  }
}

/** One copy the nest placed: a point p of the object's footprint goes to the turn of p by `angleDeg`, plus `offset`. */
export interface NestPlacement {
  id: string
  copy: number
  angleDeg: number
  offset: [number, number]
}

/** What `nest.arrange` (and each `nest.step`) answers. */
export interface NestReply {
  placements: NestPlacement[]
  leftOver: { id: string; copies: number }[]
  tooLarge: { id: string; withoutMargin: boolean }[]
  stats: { placed: number; wanted: number; passes: number; utilization: number }
}
