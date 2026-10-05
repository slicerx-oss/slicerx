// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// True shape arrange and fill the bed. sx-geom gives each object's outline seen from above, holes and
// inner corners kept, and nests the outlines on no fit polygons at any turn (packages/geom/src/nest):
// an L tucks into another's corner and a small part goes inside a ring. The outlines grow by what
// prints around each object (brim, raft, support pad, skirt: footprint.ts) and keep clear of fixed
// objects, the printer's excluded areas and the prime tower. The engine runs in the geometry worker one
// pass at a time, so a long run shows its progress; the same plate gives the same layout every time.
// When the engine cannot run, arrange falls back to the box packer in arrange.ts.
import type { Bed, MeshPart } from '@slicerx/contracts'
import { geom } from '../geom/client'
import { avoidAreas, currentMargins, MARGIN_SAFETY_MM, printSizeOf, type ArrangeOptions, type ArrangeResult, type PrintMargins, type Rect } from './arrange'
import { bounds, multiply, type Mat4 } from './transform'

export interface NestEntry {
  id: string
  parts: readonly Pick<MeshPart, 'positions' | 'indices'>[]
  transform: Mat4
}

export interface Outline {
  outer: [number, number][]
  holes: [number, number][][]
}

interface Placement {
  id: string
  copy: number
  angleDeg: number
  offset: [number, number]
}

interface NestReply {
  placements: Placement[]
  leftOver: { id: string; copies: number }[]
  tooLarge: { id: string; withoutMargin: boolean }[]
  stats: { placed: number; wanted: number; passes: number; utilization: number }
}

interface Progress {
  session: number
  done: number
  passes: number
  finished: boolean
  result: NestReply
}

/** Turn step for arrange and fill the bed, degrees, when turning is allowed. */
export const NEST_STEP_DEFAULT = 10

/**
 * The work each effort may spend after the first layout, in sx-geom's units (vertices through its
 * polygon operations; packages/geom/src/nest/place.rs DEFAULT_BUDGET is normal). Counted work, not
 * time, so the same plate gives the same layout on any machine. Normal is about a second on a typical
 * plate in the browser and a few on a crowded one.
 */
const EFFORT_BUDGET = { quick: 1.5e6, normal: 6e6, thorough: 24e6 } as const

/** What an object covers seen from above: its outline, simplified so it still covers it, and its exact hull. */
export interface Footprint {
  polygons: Outline[]
  hull: [number, number][]
}

/** Footprints by mesh and by the linear part of the transform; moving an object only shifts its footprint. */
const outlines = new WeakMap<object, Map<string, Footprint>>()

/** The object's footprint seen from above, in bed coordinates. */
export async function outlineOf(e: NestEntry): Promise<Footprint> {
  const m = e.transform
  const linear = [m[0]!, m[1]!, m[2]!, 0, m[4]!, m[5]!, m[6]!, 0, m[8]!, m[9]!, m[10]!, 0, 0, 0, 0, 1]
  const key = linear.map((v) => v.toFixed(6)).join(',')
  let per = outlines.get(e.parts)
  if (!per) outlines.set(e.parts, (per = new Map()))
  let local = per.get(key)
  if (!local) {
    const meshes = e.parts.map((p) => ({ positions: Array.from(p.positions), indices: Array.from(p.indices) }))
    const r = await geom().call<Footprint>('nest.footprint', { meshes, transform: linear })
    local = { polygons: r.polygons, hull: r.hull }
    if (per.size >= 8) per.delete(per.keys().next().value as string)
    per.set(key, local)
  }
  const dx = m[12] ?? 0
  const dy = m[13] ?? 0
  const move = (r: [number, number][]): [number, number][] => r.map(([x, y]) => [x + dx, y + dy])
  return { polygons: local.polygons.map((p) => ({ outer: move(p.outer), holes: p.holes.map(move) })), hull: move(local.hull) }
}

const rectOutline = (r: Rect): Outline => ({ outer: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], holes: [] })

/** A turn about Z by `deg` (exact at quarter turns) followed by a shift, applied after `m`. */
export function turnedAndMoved(m: Mat4, deg: number, offset: readonly [number, number]): Mat4 {
  const d = ((deg % 360) + 360) % 360
  const [s, c] = d === 0 ? [0, 1] : d === 90 ? [1, 0] : d === 180 ? [0, -1] : d === 270 ? [-1, 0] : [Math.sin((d * Math.PI) / 180), Math.cos((d * Math.PI) / 180)]
  return multiply([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, offset[0], offset[1], 0, 1], m)
}

export interface NestRun {
  /** Called while a long run goes on: passes done and planned. */
  progress?: (done: number, total: number) => void
  /** Stops early with the best layout so far when it returns true. */
  stop?: () => boolean
}

interface Request {
  moving: readonly NestEntry[]
  fixed: readonly NestEntry[]
  bed: Bed
  opts: ArrangeOptions
  /** Fill the bed: as many copies of the one moving object as fit. */
  copies?: number
  center: boolean
}

async function itemOf(e: NestEntry, margins: PrintMargins, copies = 1) {
  const b = bounds(e.parts, e.transform)
  const size = b ? printSizeOf(b) : { w: 0, h: 0, height: 0 }
  let { polygons, hull } = e.parts.some((p) => p.indices.length >= 3) ? await outlineOf(e) : { polygons: [], hull: [] as [number, number][] }
  // No triangles to project (a point cloud, or a part still loading): its bounds stand in.
  if (polygons.length === 0 && b) {
    polygons = [rectOutline({ x: b.min[0], y: b.min[1], w: size.w, h: size.h })]
    hull = []
  }
  return { id: e.id, polygons, hull, grow: margins.grow(size), reach: margins.reach(size), copies }
}

async function run(req: Request, hooks: NestRun = {}): Promise<NestReply> {
  const margins = req.opts.margins ?? currentMargins()
  const items = await Promise.all(req.moving.map((e) => itemOf(e, margins, req.copies ?? 1)))
  const fixed = await Promise.all(req.fixed.map((e) => itemOf(e, margins)))
  const zones = [...avoidAreas(), ...margins.keepOut].map((r) => ({ polygons: [rectOutline(r)] }))
  const problem = {
    bed: { widthMm: req.bed.widthMm, depthMm: req.bed.depthMm },
    items,
    fixed: fixed.map(({ copies: _c, ...f }) => f),
    zones,
    options: {
      gapMm: req.opts.gapMm,
      // Printing by object: the extruder clearance between objects, the bed edge keeping the gap. Sent only when set.
      ...(margins.apart ? { apartMm: margins.apart } : {}),
      safetyMm: MARGIN_SAFETY_MM,
      rotate: req.opts.rotate,
      rotationStepDeg: req.opts.stepDeg ?? NEST_STEP_DEFAULT,
      skirt: margins.skirt,
      center: req.center,
      budget: EFFORT_BUDGET[req.opts.effort ?? 'normal'],
    },
  }
  const started = Date.now()
  let p = await geom().call<Progress>('nest.start', problem)
  try {
    while (!p.finished && !hooks.stop?.()) {
      if (Date.now() - started > 300) hooks.progress?.(p.done, p.passes)
      p = await geom().call<Progress>('nest.step', { session: p.session, passes: 1 })
    }
  } finally {
    void geom().call('nest.end', { session: p.session }).catch(() => undefined)
  }
  return p.result
}

/** Arranges `moving` around `fixed` on true outlines. Rejects when the geometry engine cannot run. */
export async function nestArrange(moving: readonly NestEntry[], fixed: readonly NestEntry[], bed: Bed, opts: ArrangeOptions, hooks?: NestRun): Promise<ArrangeResult> {
  const r = await run({ moving, fixed, bed, opts, center: fixed.length === 0 }, hooks)
  const transforms: Record<string, Mat4> = {}
  const byId = new Map(moving.map((e) => [e.id, e]))
  for (const p of r.placements) {
    const e = byId.get(p.id)
    if (e) transforms[p.id] = turnedAndMoved(e.transform, p.angleDeg, p.offset)
  }
  const leftOver = moving.filter((e) => !transforms[e.id]).map((e) => e.id)
  return { transforms, leftOver, tooLarge: r.tooLarge }
}

/** Where copies of `item` fit around `others`, up to `max`, on true outlines. */
export async function nestFill(item: NestEntry, others: readonly NestEntry[], bed: Bed, opts: ArrangeOptions, max: number, hooks?: NestRun): Promise<{ transforms: Mat4[]; tooLarge: ArrangeResult['tooLarge'] }> {
  const r = await run({ moving: [item], fixed: others, bed, opts, copies: max, center: false }, hooks)
  return { transforms: r.placements.map((p) => turnedAndMoved(item.transform, p.angleDeg, p.offset)), tooLarge: r.tooLarge }
}
