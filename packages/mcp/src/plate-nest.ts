// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange on true outlines for a project's plate, with the nest the app runs: sx-geom gives each object's outline seen
// from above and its first layer (nest.footprint), and nests them (nest.arrange, packages/geom/src/nest). The request
// is the app's (@slicerx/settings/arrange-room): each outline grown by its brim, sized from its first layer as the
// engine sizes it, its raft and the skirt, clear of the printer's excluded areas and the prime tower's room. The plate
// counts in bed coordinates; the nest counts from the printable area's front left corner.
import type { EngineCall } from '@slicerx/cad-history'
import type { MeshPart, SettingValue } from '@slicerx/contracts'
import { byObjectApart, keepOutBoxes, nestItem, nestProblem, plateMargins, zoneKeep, type NestFootprint, type NestItem, type NestPlacement, type NestReply, type Rect } from '@slicerx/settings/arrange-room'
import { arrangeRules, gantryLane, overRod } from '@slicerx/settings/by-object'
import { marginFlag as flag, marginNumber, objectPrintMargins } from '@slicerx/settings/print-margins'
import type { BedArea } from './bed'

/** An object for the nest, as placed: its rotation and scale, without the move. */
export interface NestObject {
  /** The object id, for copies the nest places; a plate object id for a copy that stays. */
  id: string
  meshId: string
  parts: () => readonly Pick<MeshPart, 'positions' | 'indices'>[]
  /** Rotation and scale, a column-major 4x4 with no move. */
  linear: readonly number[]
  /** Size and lowest corner with `linear` applied, mm. */
  size: readonly [number, number, number]
  min: readonly [number, number, number]
  /** The plate's settings with the object's own over them. */
  config: Record<string, SettingValue>
  copies: number
  /** A copy that stays: the move in X and Y its transform has, bed coordinates. */
  at?: readonly [number, number]
}

export interface NestPlate {
  bed: BedArea
  config: Record<string, SettingValue>
  /** Filaments the plate prints in; two or more put the prime tower on it. */
  tools: number
  gapMm: number
  moving: readonly NestObject[]
  fixed: readonly NestObject[]
  /** Move the layout to the middle of the bed when nothing stays (arrange); fill the bed leaves it where it packs. */
  center: boolean
  /** More of the bed to keep clear of for this nest only, bed coordinates: a tall copy's gantry lane (nestInLanes). */
  zones?: readonly Rect[]
  /** False leaves out the rule that keeps a whole-print skirt off the zones, which a lane between copies breaks. */
  skirt?: false
}

/** Footprints by mesh, rotation and scale and first layer cut; a move only shifts one. */
export type FootprintCache = Map<string, NestFootprint>

async function footprintOf(engine: EngineCall, o: NestObject, baseMm: number | undefined, cache: FootprintCache): Promise<NestFootprint> {
  const key = `${o.meshId}|${o.linear.map((v) => v.toFixed(6)).join(',')}|${baseMm ?? ''}`
  const hit = cache.get(key)
  if (hit) return hit
  const meshes = o.parts().map((p) => ({ positions: Array.from(p.positions), indices: Array.from(p.indices) }))
  const r = (await engine('nest.footprint', { meshes, transform: [...o.linear], ...(baseMm !== undefined ? { baseMm } : {}) })) as NestFootprint
  const f: NestFootprint = { polygons: r.polygons, hull: r.hull, ...(r.base ? { base: r.base } : {}) }
  if (cache.size >= 32) cache.delete(cache.keys().next().value as string)
  cache.set(key, f)
  return f
}

const shift = (f: NestFootprint, dx: number, dy: number): NestFootprint => {
  const move = (r: [number, number][]): [number, number][] => r.map(([x, y]) => [x + dx, y + dy])
  const moved = (list: NestFootprint['polygons']) => list.map((p) => ({ outer: move(p.outer), holes: p.holes.map(move) }))
  return { polygons: moved(f.polygons), hull: move(f.hull), ...(f.base ? { base: moved(f.base) } : {}) }
}

async function itemOf(engine: EngineCall, o: NestObject, origin: readonly [number, number], cache: FootprintCache): Promise<NestItem> {
  const margins = objectPrintMargins(o.config)
  let foot = await footprintOf(engine, o, margins.firstLayerMm, cache)
  const size = { w: o.size[0], h: o.size[1], height: o.size[2] }
  // In plate coordinates: a copy that stays where it is, a copy to place where its outline is.
  const dx = (o.at?.[0] ?? 0) - origin[0]
  const dy = (o.at?.[1] ?? 0) - origin[1]
  if (o.at) foot = shift(foot, dx, dy)
  return nestItem(o.id, foot, size, { x: o.min[0] + dx, y: o.min[1] + dy, w: size.w, h: size.h }, margins, o.copies)
}

/**
 * How many filaments a plate prints in, for its prime tower: the objects print in filament 1 (a project's parts load
 * in it), and support or a raft in `support_filament` and `support_interface_filament` when set (0 is the object's).
 */
export function plateTools(configs: readonly Record<string, SettingValue>[]): number {
  const used = new Set([1])
  for (const c of configs) {
    if (!flag(c['enable_support']) && !(marginNumber(c['raft_layers'], 0) > 0)) continue
    for (const k of ['support_filament', 'support_interface_filament']) {
      const n = Math.round(marginNumber(c[k], 0))
      if (n >= 1) used.add(n)
    }
  }
  return used.size
}

/** The printer's excluded areas, in plate coordinates. */
function avoidOf(cfg: Record<string, SettingValue>, origin: readonly [number, number]): Rect[] {
  return keepOutBoxes(cfg).map((r) => ({ ...r, x: r.x - origin[0], y: r.y - origin[1] }))
}

/** Nests a plate's moving objects around the ones that stay. Offsets come back in bed coordinates. */
export async function nestPlate(engine: EngineCall, p: NestPlate, cache: FootprintCache): Promise<NestReply> {
  const origin = [p.bed.x0, p.bed.y0] as const
  const plate = plateMargins(p.config, p.tools, { origin, size: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm } })
  const margins = p.skirt === false ? { ...plate, skirt: false } : plate
  const items = await Promise.all(p.moving.map((o) => itemOf(engine, o, origin, cache)))
  const fixed = await Promise.all(p.fixed.map((o) => itemOf(engine, o, origin, cache)))
  const towers = [...margins.keepOut, ...margins.towerRoom]
  const problem = nestProblem({ bed: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm, ...(p.bed.circle ? { round: true } : {}) }, items, fixed, avoid: [...avoidOf(p.config, origin), ...(p.zones ?? []).map((r) => ({ ...r, x: r.x - origin[0], y: r.y - origin[1] }))], towers, margins, gapMm: p.gapMm, rotate: false, center: p.center })
  const r = (await engine('nest.arrange', problem)) as NestReply
  return { ...r, placements: r.placements.map((q) => ({ ...q, offset: [q.offset[0] + origin[0], q.offset[1] + origin[1]] })) }
}

/**
 * Printing by object, the copies taller than the gantry rod one at a time, each clear of the lanes of the ones before
 * it (@slicerx/settings/by-object gantryLane), so the gantry over a later copy never meets an earlier one; then the
 * rest around them, with the rod reaching as far as arrange holds it to (arrangeRules). Copies that stay count with
 * their lanes. Offsets in bed coordinates; null when a tall copy does not fit outside the lanes.
 */
export async function nestInLanes(engine: EngineCall, p: NestPlate, cache: FootprintCache): Promise<NestReply | null> {
  const tall = (o: NestObject) => overRod(o.size[2], p.config)
  const origin = [p.bed.x0, p.bed.y0] as const
  const apart = plateMargins(p.config, p.tools, { origin, size: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm } }).apart
  const fixed = [...p.fixed]
  // The footprints, bed coordinates, whose lanes the next tall copy keeps out of.
  const hullAt = async (o: NestObject, at: readonly [number, number]): Promise<[number, number][]> => {
    const foot = await footprintOf(engine, o, objectPrintMargins(o.config).firstLayerMm, cache)
    return foot.hull.map(([x, y]) => [x + at[0], y + at[1]])
  }
  const hulls = await Promise.all(fixed.filter((o) => tall(o) && o.at).map((o) => hullAt(o, o.at!)))
  const fixedReach = (await Promise.all(fixed.map((o) => itemOf(engine, o, origin, cache)))).map((i) => i.reach)
  const placements: NestPlacement[] = []
  for (const o of p.moving.filter(tall)) {
    const item = await itemOf(engine, o, origin, cache)
    // Its brim and skirt print under the gantry too, so its lane is wider by their reach.
    const away = zoneKeep(item.grow, item.reach, p.gapMm, byObjectApart(apart, [item.reach, ...fixedReach])) - item.reach
    for (let c = 1; c <= o.copies; c++) {
      const lanes = hulls.map((h) => gantryLane(h, arrangeRules(p.config), p.bed.x0, p.bed.widthMm, away))
      // The skirt rule would keep the parts off both sides of a lane, so the lanes pass leaves it out.
      const r = await nestPlate(engine, { ...p, moving: [{ ...o, copies: 1 }], fixed, center: false, zones: [...(p.zones ?? []), ...lanes], skirt: false }, cache)
      const q = r.placements.find((x) => x.id === o.id)
      if (!q) return null
      placements.push({ ...q, copy: c })
      fixed.push({ ...o, id: `${o.id}~${c}`, copies: 1, at: q.offset })
      hulls.push(await hullAt(o, q.offset))
    }
  }
  const low = p.moving.filter((o) => !tall(o))
  const rest: NestReply = low.length > 0 ? await nestPlate(engine, { ...p, moving: low, fixed, center: false }, cache) : { placements: [], leftOver: [], tooLarge: [], stats: { placed: 0, wanted: 0, passes: 0, utilization: 0 } }
  return { ...rest, placements: [...placements, ...rest.placements] }
}

/** The area an outline covers, holes taken out, mm2. */
function areaOf(list: NestFootprint['polygons']): number {
  const ring = (r: readonly [number, number][]): number => Math.abs(r.reduce((n, [x, y], i) => {
    const [u, v] = r[(i + 1) % r.length]!
    return n + x * v - u * y
  }, 0)) / 2
  return list.reduce((n, p) => n + ring(p.outer) - p.holes.reduce((m, h) => m + ring(h), 0), 0)
}

/** How many copies of `o` the nest fits on the plate around the ones that stay, up to `max` (fill the bed). */
export async function fillCount(engine: EngineCall, p: Omit<NestPlate, 'moving' | 'center'>, o: NestObject, max: number, cache: FootprintCache): Promise<number> {
  // No more than the bed holds of its bare outline.
  const area = areaOf((await footprintOf(engine, o, objectPrintMargins(o.config).firstLayerMm, cache)).polygons)
  const bed = p.bed.circle ? Math.PI * p.bed.circle.r ** 2 : p.bed.widthMm * p.bed.depthMm
  const copies = area > 0 ? Math.min(max, Math.floor(bed / area)) : max
  if (copies <= 0) return 0
  const r = await nestPlate(engine, { ...p, moving: [{ ...o, copies }], center: false }, cache)
  return r.placements.filter((q) => q.id === o.id).length
}
