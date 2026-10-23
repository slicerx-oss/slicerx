// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingValue } from '@slicerx/contracts'

export interface PrintSize { w: number; h: number; height: number }

type Pt = readonly [number, number]

/** One island of an object's first layer, mm: its outer ring and its holes, as sx-geom gives outlines. */
export interface FirstLayerShape {
  outer: readonly Pt[]
  holes: readonly (readonly Pt[])[]
}

/** First element of a per-filament list, else the value; a number or a numeric string. */
export function marginNumber(v: SettingValue | undefined, fallback: number): number {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'string' ? Number.parseFloat(x) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

export function marginText(v: SettingValue | undefined): string {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'string' ? x : ''
}

export function marginFlag(v: SettingValue | undefined): boolean {
  const x = Array.isArray(v) ? v[0] : v
  return x === true || x === 1 || x === '1' || x === 'true'
}

/** Material coefficients used by the engine's automatic brim. */
function material(cfg: Record<string, SettingValue>): { adhesion: number; thermal: number } {
  const name = marginText(cfg['filament_type'])
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
  const speed = topSpeed(cfg)
  const { adhesion, thermal } = material(cfg)
  const heightToArea = (Math.max((height / ixx) * h, (height / iyy) * w) * height) / 1920
  const raw = adhesion * Math.min(18, 1.5 * diagonal, Math.max(heightToArea * speed, (diagonal * 8 * Math.min(height, 30)) / thermal / 30))
  if (raw < 5 && raw < 1.5 * diagonal) return 0
  return Math.min(18, Math.min(raw, 18) * 1.25)
}

/** Signed area, centroid and second moments about the origin of a ring (the y and x squared sums), for the ring made counterclockwise. */
function ringMoments(ring: readonly Pt[]): { area: number; cx: number; cy: number; ix: number; iy: number } {
  let a2 = 0
  let cx = 0
  let cy = 0
  let ix = 0
  let iy = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!
    const q = ring[(i + 1) % ring.length]!
    const cross = p[0] * q[1] - q[0] * p[1]
    a2 += cross
    cx += (p[0] + q[0]) * cross
    cy += (p[1] + q[1]) * cross
    ix += ((p[1] * p[1] + p[1] * q[1] + q[1] * q[1]) * cross) / 12
    iy += ((p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) * cross) / 12
  }
  const area = a2 / 2
  if (Math.abs(area) < 1e-12) return { area: 0, cx: 0, cy: 0, ix: 0, iy: 0 }
  const s = Math.sign(area)
  return { area, cx: cx / (6 * area), cy: cy / (6 * area), ix: ix * s, iy: iy * s }
}

/** Second moments of a first layer about its own centroid, mm^4: [Ixx, Iyy], or null when it has no area. */
function secondMoments(shapes: readonly FirstLayerShape[]): [number, number] | null {
  const props: { a: number; x: number; y: number; ixx: number; iyy: number }[] = []
  for (const shape of shapes) {
    const o = ringMoments(shape.outer)
    let area = Math.abs(o.area)
    let cx = o.cx * area
    let cy = o.cy * area
    let sx = o.ix
    let sy = o.iy
    for (const ring of shape.holes) {
      const h = ringMoments(ring)
      const ha = -Math.abs(h.area)
      area += ha
      cx += h.cx * ha
      cy += h.cy * ha
      sx -= Math.abs(h.ix)
      sy -= Math.abs(h.iy)
    }
    if (Math.abs(area) < 1e-12) continue
    const x = cx / area
    const y = cy / area
    props.push({ a: area, x, y, ixx: sx - y * y * area, iyy: sy - x * x * area })
  }
  if (props.length === 0) return null
  const total = props.reduce((n, p) => n + p.a, 0)
  const gx = props.reduce((n, p) => n + p.x * p.a, 0) / total
  const gy = props.reduce((n, p) => n + p.y * p.a, 0) / total
  let ixx = 0
  let iyy = 0
  for (const p of props) {
    ixx += p.ixx + p.a * (p.y - gy) ** 2
    iyy += p.iyy + p.a * (p.x - gx) ** 2
  }
  return [ixx, iyy]
}

/** Width and depth of the box round the outer rings, mm. */
function extentOf(rings: readonly (readonly Pt[])[]): [number, number] {
  const pts = rings.flat()
  if (pts.length === 0) return [0, 0]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
}

/** The fastest of the print speeds the automatic brim looks at, mm/s. */
const topSpeed = (cfg: Record<string, SettingValue>): number => Math.max(0, ...['inner_wall_speed', 'outer_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'support_speed'].map((k) => marginNumber(cfg[k], 0)))

/** The engine's automatic brim width for an object whose first layer is `shapes` and whose height is `height`, mm, before whole loops. */
function firstLayerBrimWidth(cfg: Record<string, SettingValue>, shapes: readonly FirstLayerShape[], height: number): number {
  const [bx, by] = extentOf(shapes.map((s) => s.outer))
  const diagonal = Math.hypot(bx, by)
  const m = secondMoments(shapes)
  if (!m || !(m[0] > 0) || !(m[1] > 0)) return 0
  const { adhesion, thermal } = material(cfg)
  const heightToArea = (Math.max((height / m[0]) * by, (height / m[1]) * bx) * height) / 1920
  const raw = adhesion * Math.min(18, 1.5 * diagonal, Math.max(heightToArea * topSpeed(cfg), (diagonal * 8 * Math.min(height, 30)) / thermal / 30))
  // Small brims are left out, large ones capped.
  return raw < 5 && raw < 1.5 * diagonal ? 0 : Math.min(raw, 18)
}

/** A line width setting in mm: a number, a percent of the nozzle, or 0 for automatic (`fallback`). */
function widthMm(v: SettingValue | undefined, nozzle: number, fallback: number): number {
  const x = Array.isArray(v) ? v[0] : v
  if (typeof x === 'string' && x.trim().endsWith('%')) {
    const pct = Number.parseFloat(x)
    return pct > 0 ? (pct / 100) * nozzle : fallback
  }
  const n = marginNumber(x, 0)
  return n > 0 ? n : fallback
}

/** The distance between brim loops, mm: the first layer's line width less the rounded edges of the bead. */
function brimSpacing(cfg: Record<string, SettingValue>): number {
  const nozzle = marginNumber(cfg['nozzle_diameter'], 0.4)
  const line = widthMm(cfg['line_width'], nozzle, nozzle * 1.125)
  const first = cfg['initial_layer_line_width'] === undefined ? line : widthMm(cfg['initial_layer_line_width'], nozzle, nozzle * 1.125)
  const h = Math.max(0, marginNumber(cfg['initial_layer_print_height'], 0.2))
  return Math.max(first - h * (1 - Math.PI / 4), first * 0.5)
}

/**
 * One island's brim under the automatic brim, mm: the object's width, a few loops more for a tall part on a thin wall
 * that got none, and never more than the island's own extent.
 */
function islandBrimWidth(width: number, island: FirstLayerShape, height: number, spacing: number): number {
  let w = width
  if (w < 5 && height > 10 && island.outer.length > 0) {
    const area = Math.abs(ringMoments(island.outer).area)
    const length = island.outer.reduce((n, p, i) => {
      const q = island.outer[(i + 1) % island.outer.length]!
      return n + Math.hypot(q[0] - p[0], q[1] - p[1])
    }, 0)
    if (length > 0 && area / length < 1.1 && w < spacing) w += Math.floor(5 / spacing / 2) * spacing * 2
  }
  const [ex, ey] = extentOf([island.outer])
  return Math.min(w, Math.max(ex, ey))
}

/**
 * How far the engine's automatic brim reaches past an object's first layer, mm: the brim gap and the widest brim any
 * island of it prints, in whole pairs of loops, the way the engine sizes it per object (from the first layer's second
 * moment of area, its height, the top speed and the material, up to 18 mm). 0 when it prints none.
 */
export function autoBrimRoom(cfg: Record<string, SettingValue>, shapes: readonly FirstLayerShape[], height: number): number {
  if (shapes.length === 0 || !(height > 0)) return 0
  const spacing = brimSpacing(cfg)
  const width = firstLayerBrimWidth(cfg, shapes, height)
  const gap = Math.min(2, Math.max(0, marginNumber(cfg['brim_object_gap'], 0)))
  let room = 0
  for (const island of shapes) {
    const loops = 2 * Math.floor(islandBrimWidth(width, island, height, spacing) / spacing / 2)
    if (loops > 0) room = Math.max(room, gap + loops * spacing)
  }
  return room
}

/**
 * Where the engine cuts the first layer that its automatic brim is sized from, mm above the bed: half the first layer's
 * height. Undefined when no automatic brim prints (another kind of brim, or a raft in its place).
 */
export function firstLayerCut(cfg: Record<string, SettingValue>): number | undefined {
  if ((marginText(cfg['brim_type']) || 'auto_brim') !== 'auto_brim' || marginNumber(cfg['raft_layers'], 0) > 0) return undefined
  return Math.max(0.02, marginNumber(cfg['initial_layer_print_height'], 0.2)) / 2
}

/** How far the brim reaches past the outline, mm, its gap included. */
function brimOf(cfg: Record<string, SettingValue>, size: PrintSize, base?: readonly FirstLayerShape[]): number {
  const kind = marginText(cfg['brim_type']) || 'auto_brim'
  const width = Math.max(0, marginNumber(cfg['brim_width'], 0))
  const gap = Math.max(0, marginNumber(cfg['brim_object_gap'], 0))
  // Painted and ear brims are discs the width of the brim; an inner-only brim stays inside the part.
  if (kind === 'no_brim' || kind === 'inner_only') return 0
  if (kind !== 'auto_brim') return width > 0 ? width + gap : 0
  // With the first layer known, the automatic brim is the one the engine prints; brim_width still counts, since the
  // engine keeps the prime tower that far off as well. Without it, an estimate from the bounds.
  if (base && base.length > 0) return Math.max(autoBrimRoom(cfg, base, size.height), width)
  const estimate = Math.max(autoBrimWidth(cfg, size), width)
  return estimate > 0 ? estimate + gap : 0
}

/**
 * How far the first layer of the object itself reaches past its outline (brim, raft, size compensation), mm. `base`
 * is the object's first layer (see firstLayerCut), when known.
 */
function growOf(cfg: Record<string, SettingValue>, size: PrintSize, base?: readonly FirstLayerShape[]): number {
  let grow = brimOf(cfg, size, base)
  if (marginNumber(cfg['raft_layers'], 0) > 0) grow += Math.max(0, marginNumber(cfg['raft_expansion'], 1.5), marginNumber(cfg['raft_first_layer_expansion'], 2))
  return grow + Math.max(0, marginNumber(cfg['xy_contour_compensation'], 0))
}

/**
 * How far grid style support's first layer can print past the overhang it holds up, mm, with `pad` the first layer's
 * growth: its islands are stretched to whole cells of the grid (a cell is `support_base_pattern_spacing` plus the line
 * spacing, so an island that just reaches into a cell fills all of it) and printed half a line spacing past the cells,
 * and the pad grows round that. The grid turns by `support_angle`, which widens all of it. `line` is the support line
 * width.
 */
function gridReach(cfg: Record<string, SettingValue>, line: number, pad: number): number {
  const h = Math.max(0.01, Math.min(marginNumber(cfg['initial_layer_print_height'], 0.2), marginNumber(cfg['layer_height'], 0.2)))
  const spacing = Math.max(0, line - h * (1 - Math.PI / 4))
  const cell = spacing + Math.max(0, marginNumber(cfg['support_base_pattern_spacing'], 2.5))
  const turn = (marginNumber(cfg['support_angle'], 0) * Math.PI) / 180
  return (cell + 0.5 * spacing + pad) * (Math.abs(Math.cos(turn)) + Math.abs(Math.sin(turn))) + 0.01
}

/**
 * How far support's first layer reaches past the part's outline, mm, or 0 with support off, by the rule the engine
 * keeps its prime tower clear with. The pad is `support_expansion` and `raft_first_layer_expansion`; grid supports (the
 * default) add the cell the islands are stretched to ([`gridReach`]), snug supports a line, and trees their brim, half a
 * branch and a line. Objects that need no support print none, so this is an upper bound, used only against the bed edge
 * and the excluded areas.
 */
function supportOf(cfg: Record<string, SettingValue>): number {
  if (!marginFlag(cfg['enable_support'])) return 0
  const nozzle = marginNumber(cfg['nozzle_diameter'], 0.4)
  // Unset, support lines are as wide as the others (0.42 mm when those are unset too); 0 is the nozzle's width.
  const general = cfg['line_width'] === undefined ? 0.42 : widthMm(cfg['line_width'], nozzle, nozzle * 1.125)
  const line = cfg['support_line_width'] === undefined ? general : widthMm(cfg['support_line_width'], nozzle, nozzle)
  const pad = Math.max(0, marginNumber(cfg['support_expansion'], 0)) + Math.max(0, marginNumber(cfg['raft_first_layer_expansion'], 2))
  const style = marginText(cfg['support_style']) || 'default'
  if (marginText(cfg['support_type']).startsWith('tree') || style.startsWith('tree') || style === 'organic') {
    return pad + Math.max(0, marginNumber(cfg['tree_support_brim_width'], 3)) + 0.5 * Math.max(0, marginNumber(cfg['tree_support_branch_diameter'], 5)) + line
  }
  return style === 'default' || style === 'grid' ? gridReach(cfg, line, pad) : pad + line
}

/** The skirt or draft shield: how far past the part (and its brim) the outermost loop lies, or 0 without one. */
function skirtOf(cfg: Record<string, SettingValue>, grow: number): number {
  const shield = marginText(cfg['draft_shield']) === 'enabled'
  const loops = Math.max(0, Math.floor(marginNumber(cfg['skirt_loops'], 0)))
  if (loops === 0 && !shield) return 0
  const nozzle = marginNumber(cfg['nozzle_diameter'], 0.4)
  const spacing = Math.max(marginNumber(cfg['line_width'], 0), nozzle * 1.2)
  const brim = marginText(cfg['brim_type']) === 'no_brim' ? 0 : Math.max(0, marginNumber(cfg['brim_width'], 0))
  // The engine puts the skirt at the brim width plus the skirt distance from the outline, or from the brim with a draft shield.
  return Math.max(grow, brim) + Math.max(0, marginNumber(cfg['skirt_distance'], 2)) + Math.max(1, loops) * spacing
}

/**
 * The object's first-layer growth and the outermost printed boundary. Each takes the object's first layer when the
 * caller has it (cut at `firstLayerMm`, set when an automatic brim is sized from it); else the brim is estimated from
 * the bounds.
 */
export function objectPrintMargins(cfg: Record<string, SettingValue>) {
  const support = supportOf(cfg)
  const cut = firstLayerCut(cfg)
  return {
    grow: (size: PrintSize, base?: readonly FirstLayerShape[]) => growOf(cfg, size, base),
    reach: (size: PrintSize, base?: readonly FirstLayerShape[]) => {
      const own = Math.max(growOf(cfg, size, base), support)
      return Math.max(own, skirtOf(cfg, own))
    },
    skirt: skirtOf(cfg, 0) > 0,
    ...(cut !== undefined ? { firstLayerMm: cut } : {}),
  }
}
