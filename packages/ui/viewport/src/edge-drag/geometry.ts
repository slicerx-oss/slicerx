// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag, the numbers only: which bed edge a moving footprint is past, whether it is past the commit line,
// which screen side each bed edge shows on, and which plate each side offers. No DOM and no store, so it is tested
// on its own and the overlay (session.ts) only draws what this decides. Part of @slicerx/viewport/edge-drag.
import { COMMIT_MM } from './reach'
import { DEFAULT_EDGE_DRAG_LABELS, type EdgeDragLabels } from './labels'

export { COMMIT_MM, COMMIT_PX, commitMarginMm, reachPastLineMm } from './reach'
export { DEFAULT_EDGE_DRAG_LABELS, type EdgeDragLabels } from './labels'

/** A bed edge in bed coordinates: x- is x = 0, x+ is x = width, y- is the front (y = 0), y+ the back. */
export type BedEdge = 'x-' | 'x+' | 'y-' | 'y+'
/** A side of the screen. */
export type Side = 'left' | 'top' | 'right' | 'bottom'

export const BED_EDGES: readonly BedEdge[] = ['x-', 'x+', 'y-', 'y+']
export const SIDES: readonly Side[] = ['left', 'top', 'right', 'bottom']

/** A footprint on the bed, mm. */
export interface Box2 {
  min: readonly [number, number]
  max: readonly [number, number]
}

export interface BedSize {
  widthMm: number
  depthMm: number
}

/**
 * The footprint against one edge, mm: `lead` is how far its far side is past the edge (negative while it is all on
 * the bed), `trail` how far its near side is (positive once all of it is past), `size` its extent across the edge.
 */
export function edgeReach(box: Box2, bed: BedSize, edge: BedEdge): { lead: number; trail: number; size: number } {
  const [x0, y0] = box.min
  const [x1, y1] = box.max
  switch (edge) {
    case 'x+':
      return { lead: x1 - bed.widthMm, trail: x0 - bed.widthMm, size: x1 - x0 }
    case 'x-':
      return { lead: -x0, trail: -x1, size: x1 - x0 }
    case 'y+':
      return { lead: y1 - bed.depthMm, trail: y0 - bed.depthMm, size: y1 - y0 }
    case 'y-':
      return { lead: -y0, trail: -y1, size: y1 - y0 }
  }
}

/** Whether the whole footprint is on the bed (a normal move). */
export function onBed(box: Box2, bed: BedSize, eps = 1e-6): boolean {
  return box.min[0] >= -eps && box.min[1] >= -eps && box.max[0] <= bed.widthMm + eps && box.max[1] <= bed.depthMm + eps
}

/** The bounds of several footprints: a multi-selection moves as one group, and the whole group must be past the line. */
export function groupBox(boxes: readonly Box2[]): Box2 | null {
  if (!boxes.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.min[0])
    y0 = Math.min(y0, b.min[1])
    x1 = Math.max(x1, b.max[0])
    y1 = Math.max(y1, b.max[1])
  }
  return { min: [x0, y0], max: [x1, y1] }
}

export interface EdgeRead {
  /** The edge the footprint is furthest past, among the edges on offer, or null while it is past none. */
  edge: BedEdge | null
  /** Past the commit line of that edge: a release here moves it. */
  armed: boolean
  lead: number
  trail: number
  size: number
  /** The commit line's distance past that edge, mm. */
  margin: number
}

/**
 * Which edge a footprint is going out over, and whether it is past that edge's commit line. Only the edges on offer
 * count. At a corner the edge it is further past wins, and only that edge can be armed, so a part pushed out over a
 * corner never arms two targets at once.
 */
export function readEdges(box: Box2, bed: BedSize, offered: Iterable<BedEdge>, margins: Readonly<Partial<Record<BedEdge, number>>> | number): EdgeRead {
  let best: { edge: BedEdge; lead: number; trail: number; size: number } | null = null
  for (const edge of offered) {
    const r = edgeReach(box, bed, edge)
    if (r.lead <= 0) continue
    if (!best || r.lead > best.lead) best = { edge, ...r }
  }
  if (!best) return { edge: null, armed: false, lead: 0, trail: 0, size: 0, margin: 0 }
  const margin = typeof margins === 'number' ? margins : (margins[best.edge] ?? COMMIT_MM)
  return { ...best, armed: best.trail >= margin, margin }
}

/**
 * How strongly an edge shows, 0 to 1: faint when a drag starts, a little brighter as the footprint nears the edge,
 * brighter as more of it is past, full once armed. `depth` is how far past the line the drag can go, for the pulse.
 */
export function glow(lead: number, size: number, margin: number, armed: boolean, depth = 0): { level: number; deep: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const deep = clamp(lead / Math.max(1e-6, size + margin + depth))
  if (armed) return { level: 1, deep }
  const near = clamp((lead + 20) / 20)
  const past = clamp(lead / Math.max(1e-6, size + margin))
  return { level: 0.16 + 0.12 * near + 0.62 * past, deep }
}

/** The pulse added to an edge's level at time `t` (s): stronger and faster the deeper the drag goes; none before the edge. */
export function pulse(t: number, lead: number, deep: number): number {
  if (lead <= 0) return 0
  return (0.05 + 0.17 * deep) * Math.sin(t * Math.PI * 2 * (0.9 + 1.5 * deep))
}

const SIDE_ANGLE: Record<Side, number> = { right: 0, bottom: 90, left: 180, top: 270 }

function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()]
  const out: T[][] = []
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest])
  })
  return out
}

/**
 * Which screen side each bed edge shows on, from the direction each edge faces on screen (y down). Each side gets one
 * edge: of the 24 ways to pair them, the one closest in angle overall, so a turned view still gives every edge a side.
 */
export function sidesOf(outward: Readonly<Record<BedEdge, readonly [number, number]>>): Record<BedEdge, Side> {
  const angle = (e: BedEdge) => {
    const [x, y] = outward[e]
    return (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360
  }
  let best: Side[] = ['left', 'right', 'bottom', 'top']
  let cost = Infinity
  for (const p of permutations(SIDES)) {
    let c = 0
    BED_EDGES.forEach((e, i) => (c += angleGap(angle(e), SIDE_ANGLE[p[i]!])))
    if (c < cost - 1e-9) {
      cost = c
      best = p
    }
  }
  return { 'x-': best[0]!, 'x+': best[1]!, 'y-': best[2]!, 'y+': best[3]! }
}

/** A plate the host offers: its id, the name a label shows ("Plate 2", or the host's own) and its place in plate order. */
export interface PlateRef {
  id: string
  label: string
  order: number
}

/** What an edge offers: another plate, a new plate, or (past three other plates) a short list of the rest. */
export type EdgeTarget = { kind: 'plate'; plate: PlateRef } | { kind: 'new' } | { kind: 'more'; plates: readonly PlateRef[] }

/**
 * What each side offers while a part on `active` moves. The bottom always adds a new plate. The other plates, in plate
 * order, take the left, then the top, then the right. With more than three other plates the left and right take the
 * first two and the top becomes More plates, with the rest in its list. With one plate only the bottom shows.
 */
export function sideTargets(plates: readonly PlateRef[], active: string): Partial<Record<Side, EdgeTarget>> {
  const others = [...plates].sort((a, b) => a.order - b.order).filter((p) => p.id !== active)
  const out: Partial<Record<Side, EdgeTarget>> = { bottom: { kind: 'new' } }
  const plate = (p: PlateRef | undefined): EdgeTarget | undefined => (p ? { kind: 'plate', plate: p } : undefined)
  if (others.length <= 3) {
    const [l, t, r] = others
    if (l) out.left = plate(l)!
    if (t) out.top = plate(t)!
    if (r) out.right = plate(r)!
    return out
  }
  out.left = plate(others[0])!
  out.right = plate(others[1])!
  out.top = { kind: 'more', plates: others.slice(2) }
  return out
}

/** The label inside an edge's band. */
export function targetLabel(t: EdgeTarget, labels: EdgeDragLabels = DEFAULT_EDGE_DRAG_LABELS): string {
  if (t.kind === 'plate') return labels.addToPlate(t.plate.label)
  if (t.kind === 'new') return labels.addToNewPlate
  return labels.morePlates
}

/** What the live region says while armed. */
export function armedMessage(t: EdgeTarget | PlateRef, labels: EdgeDragLabels = DEFAULT_EDGE_DRAG_LABELS): string {
  if ('id' in t) return labels.releaseToPlate(t.label)
  if (t.kind === 'plate') return labels.releaseToPlate(t.plate.label)
  if (t.kind === 'new') return labels.releaseToNewPlate
  return labels.holdForMore
}

/** A rectangle on screen, px. */
export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** One offered edge on screen: its middle, the way out of the bed (a unit vector) and the room it needs past it, px. */
export interface EdgeRoom {
  mid: readonly [number, number]
  n: readonly [number, number]
  need: number
}

/**
 * The part of the view a person can see: the view's box inside the window, less the panels and bars floating over it
 * (each claims the side it sits against, as the camera's framing reads them).
 */
export function visibleArea(stage: ScreenRect, win: { width: number; height: number }, insets: { left: number; right: number; top: number; bottom: number }): ScreenRect {
  const left = Math.max(stage.left, 0) + insets.left
  const top = Math.max(stage.top, 0) + insets.top
  const right = Math.min(stage.right, win.width) - insets.right
  const bottom = Math.min(stage.bottom, win.height) - insets.bottom
  return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) }
}

/**
 * How much room an edge needs past it, px: the part across the edge and the furthest a drag may take it past the edge
 * (the commit line and the room past it), at the view's scale, plus `extraPx`, so all of an armed part stays in sight.
 */
export function roomNeeded(sizeMm: number, reachMm: number, mmPerPx: number, extraPx = 24): number {
  const k = Number.isFinite(mmPerPx) && mmPerPx > 0 ? mmPerPx : 1
  return (Math.max(0, sizeMm) + Math.max(0, reachMm)) / k + extraPx
}

/**
 * The view scale (1 or less) that gives every edge the room it needs inside `visible`, for a zoom about `origin`: each
 * edge's middle moves toward the origin and its room shrinks with the scale. 1 when everything fits already; never
 * below `min`.
 */
export function fitScale(visible: ScreenRect, origin: readonly [number, number], edges: readonly EdgeRoom[], min = 0.5): number {
  let s = 1
  for (const e of edges) {
    for (const i of [0, 1] as const) {
      const ni = e.n[i]
      if (Math.abs(ni) < 0.2) continue
      const sign = ni > 0 ? 1 : -1
      const bound = i === 0 ? (sign > 0 ? visible.right : visible.left) : sign > 0 ? visible.bottom : visible.top
      const avail = (bound - origin[i]) * sign
      const want = (e.mid[i] - origin[i]) * sign + e.need * Math.abs(ni)
      if (want > 0) s = Math.min(s, avail / want)
    }
  }
  return Math.min(1, Math.max(min, s))
}
