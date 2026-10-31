// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange on true outlines for a project's plate, with the nest the app runs: sx-geom gives each object's outline seen
// from above and its first layer (nest.footprint), and nests them (nest.arrange, packages/geom/src/nest). The request
// is the app's (@slicerx/settings/arrange-room): each outline grown by its brim, sized from its first layer as the
// engine sizes it, its raft and the skirt, clear of the printer's excluded areas and the prime tower's room. The plate
// counts in bed coordinates; the nest counts from the printable area's front left corner.
// Without the engine the same layout runs on the objects' boxes (boxPlate), as the app's arrange does then.
import type { EngineCall } from '@slicerx/cad-history'
import type { MeshPart, SettingValue } from '@slicerx/contracts'
import { betterNest, byObjectApart, byObjectSpacingModes, keepOutBoxes, layoutCenterShift, nestItem, nestProblem, placesMore, plateMargins, shiftKeep, withoutKeepOut, zoneKeep, type NestFootprint, type NestItem, type NestPlacement, type NestReply, type Rect } from '@slicerx/settings/arrange-room'
import { arrangeReach, arrangeRules, CELL_MM, gantryLane, objectGetsSupport, overRod } from '@slicerx/settings/by-object'
import { marginFlag as flag, marginNumber, marginText, objectPrintMargins } from '@slicerx/settings/print-margins'
import { edgeOf, findSpot, middleShift, type Placed, type Want } from '@slicerx/settings/box-pack'
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
  /** A support enforcer is on it: a volume, or painted support. */
  enforcers?: boolean
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
  /** Turn each moving copy about Z where that packs better, as the app's arrange and fill the bed do; placing a copy around others does not. */
  turn?: boolean
}

/** A turn about Z by `deg` applied after the column-major 4x4 `m` (exact at quarter turns), with no move. */
export function turnedLinear(m: readonly number[], deg: number): number[] {
  const d = ((deg % 360) + 360) % 360
  const [s, c] = d === 0 ? [0, 1] : d === 90 ? [1, 0] : d === 180 ? [0, -1] : d === 270 ? [-1, 0] : [Math.sin((d * Math.PI) / 180), Math.cos((d * Math.PI) / 180)]
  const out = [...m]
  for (let col = 0; col < 4; col++) {
    const x = m[col * 4] ?? 0
    const y = m[col * 4 + 1] ?? 0
    out[col * 4] = c * x - s * y
    out[col * 4 + 1] = s * x + c * y
  }
  return out
}

/** The object as placed with a turn about Z by `deg` after its rotation and scale: its outline, size and lowest corner follow. */
export function turnedObject(o: NestObject, deg: number): NestObject {
  if (!deg) return o
  const linear = turnedLinear(o.linear, deg)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const part of o.parts()) {
    const p = part.positions
    for (let k = 0; k + 2 < p.length; k += 3) {
      const [x, y, z] = [p[k]!, p[k + 1]!, p[k + 2]!]
      for (let r = 0; r < 3; r++) {
        const v = (linear[r] ?? 0) * x + (linear[4 + r] ?? 0) * y + (linear[8 + r] ?? 0) * z
        if (v < lo[r]!) lo[r] = v
        if (v > hi[r]!) hi[r] = v
      }
    }
  }
  if (!Number.isFinite(lo[0]!)) return { ...o, linear }
  return { ...o, linear, min: [lo[0]!, lo[1]!, lo[2]!], size: [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!] }
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
  const item = nestItem(o.id, foot, size, { x: o.min[0] + dx, y: o.min[1] + dy, w: size.w, h: size.h }, margins, o.copies)
  if (marginText(o.config['print_sequence']) !== 'by object') return item
  // Printing by object, each pair keeps the clearance and the reach of its own two objects as the check counts them
  // (the app's by-object arrange does the same): a support pad only when the object gets support.
  const supported = objectGetsSupport(o.config, o.enforcers ?? false, o.parts(), o.linear)
  return { ...item, apartReach: arrangeReach({ id: o.id, name: o.id, hull: foot.hull, top: o.size[2], supported }, o.config) }
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
  // the printer's keep-out areas first, then the zones of this arrange (gantry lanes)
  const keepOut = avoidOf(p.config, origin)
  // Printing by object with reaches that differ, both spacings are nested and the better layout kept, as the app does.
  const modes = margins.apart ? byObjectSpacingModes([...items, ...fixed].map((i) => i.apartReach ?? i.reach)) : [undefined]
  let r: NestReply | undefined
  for (const spacing of modes) {
    const problem = nestProblem({ bed: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm, ...(p.bed.circle ? { round: true } : {}) }, items, fixed, avoid: [...keepOut, ...(p.zones ?? []).map((q) => ({ ...q, x: q.x - origin[0], y: q.y - origin[1] }))], keepOut: keepOut.length, towers, margins, gapMm: p.gapMm, rotate: p.turn === true, center: p.center, spacing })
    let next = (await engine('nest.arrange', problem)) as NestReply
    if ('keepOutZones' in problem.options && next.leftOver.length > 0) next = placesMore(next, (await engine('nest.arrange', withoutKeepOut(problem))) as NestReply)
    r = r ? betterNest(r, next) : next
  }
  if (!r) throw new Error('no nest')
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
      const placed = turnedObject(o, q.angleDeg)
      fixed.push({ ...placed, id: `${o.id}~${c}`, copies: 1, at: q.offset })
      hulls.push(await hullAt(placed, q.offset))
    }
  }
  const low = p.moving.filter((o) => !tall(o))
  const rest: NestReply = low.length > 0 ? await nestPlate(engine, { ...p, moving: low, fixed, center: false }, cache) : { placements: [], leftOver: [], tooLarge: [], stats: { placed: 0, wanted: 0, passes: 0, utilization: 0 } }
  const all = [...placements, ...rest.placements]
  // Each tall copy went down where it packs, so the lanes had room; the layout as a whole now goes to the middle of the
  // bed when nothing stays, as a plain arrange's does, in whole cells, so the by-object check finds the same.
  if (!p.center || p.fixed.length > 0 || p.bed.circle) return { ...rest, placements: all }
  const byId = new Map(p.moving.map((o) => [o.id, o]))
  const placed = all.flatMap((q) => {
    const base = byId.get(q.id)
    if (!base) return []
    // its box as the nest turned it
    const o = turnedObject(base, q.angleDeg)
    const size = { w: o.size[0], h: o.size[1], height: o.size[2] }
    const margins = objectPrintMargins(o.config)
    // as far from a zone as the nest keeps a part from the printer's keep-out areas, its skirt by object counted
    const box: [number, number][] = [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]]
    const ar = arrangeReach({ id: o.id, name: o.id, hull: box, top: o.size[2], supported: objectGetsSupport(o.config, o.enforcers ?? false, o.parts(), o.linear) }, o.config)
    return [{ box: { x: o.min[0] + q.offset[0] - origin[0], y: o.min[1] + q.offset[1] - origin[1], w: size.w, h: size.h }, reach: margins.reach(size), keep: shiftKeep(margins.grow(size), Math.max(margins.reach(size), ar)) }]
  })
  const plate = plateMargins(p.config, p.tools, { origin, size: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm } })
  const zones = [...avoidOf(p.config, origin), ...plate.keepOut, ...plate.towerRoom, ...(p.zones ?? []).map((r) => ({ ...r, x: r.x - origin[0], y: r.y - origin[1] }))]
  const [dx, dy] = layoutCenterShift(placed, { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm }, zones, CELL_MM)
  return { ...rest, placements: all.map((q) => ({ ...q, offset: [q.offset[0] + dx, q.offset[1] + dy] })) }
}

/**
 * The same layout on the objects' boxes, for when the geometry engine cannot run (none installed, or it failed): the
 * box packer the app's arrange falls back to (@slicerx/settings/box-pack), with the same room as the nest, each box
 * grown by its brim estimated from its bounds, its raft and the skirt, clear of the printer's keep-out areas, the
 * prime tower's room and `zones`, and printing by object the clearance radius apart. Largest first, as the app packs.
 * With `center` and nothing staying, the layout then moves to the middle of the bed as one group (middleShift).
 * Offsets in bed coordinates; copies that find no spot are left over.
 */
export function boxPlate(p: NestPlate): NestReply {
  const origin = [p.bed.x0, p.bed.y0] as const
  const plate = plateMargins(p.config, p.tools, { origin, size: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm } })
  const skirt = p.skirt === false ? false : plate.skirt
  const bed = { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm, ...(p.bed.circle ? { round: true } : {}) }
  const towers = [...plate.keepOut, ...plate.towerRoom]
  const avoid = [...avoidOf(p.config, origin), ...(p.zones ?? []).map((r) => ({ ...r, x: r.x - origin[0], y: r.y - origin[1] }))]
  const zones = [...avoid, ...towers]
  const wantOf = (o: NestObject): Want => {
    const m = objectPrintMargins(o.config)
    const size = { w: o.size[0], h: o.size[1], height: o.size[2] }
    const want = { w: size.w, h: size.h, grow: m.grow(size), reach: m.reach(size) }
    if (marginText(o.config['print_sequence']) !== 'by object') return want
    // Printing by object, as the nest does (itemOf): each pair keeps the clearance and the reach of its own two objects,
    // a support pad only when the object gets support, here on the object's box.
    const hull: [number, number][] = [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]]
    const supported = objectGetsSupport(o.config, o.enforcers ?? false, o.parts(), o.linear)
    return { ...want, ar: arrangeReach({ id: o.id, name: o.id, hull, top: o.size[2], supported }, o.config) }
  }
  const placed: Placed[] = p.fixed.map((o) => {
    const want = wantOf(o)
    return { r: { x: o.min[0] + (o.at?.[0] ?? 0) - origin[0], y: o.min[1] + (o.at?.[1] ?? 0) - origin[1], w: want.w, h: want.h }, grow: want.grow, reach: want.reach, ...(want.ar !== undefined ? { ar: want.ar } : {}) }
  })
  const copies = p.moving.flatMap((o) => Array.from({ length: o.copies }, (_, k) => ({ o, copy: k + 1, want: wantOf(o) })))
  copies.sort((a, b) => b.want.w * b.want.h - a.want.w * a.want.h || a.o.id.localeCompare(b.o.id) || a.copy - b.copy)
  const placements: NestPlacement[] = []
  const left = new Map<string, number>()
  const tooLarge = new Map<string, boolean>()
  const fitsAlone = (w: number, h: number, edge: number) => (p.bed.circle ? Math.hypot(w, h) / 2 + edge <= p.bed.circle.r + 1e-6 : w + 2 * edge <= bed.widthMm + 1e-6 && h + 2 * edge <= bed.depthMm + 1e-6)
  for (const { o, copy, want } of copies) {
    const spot = findSpot(want, placed, zones, towers, bed, p.gapMm, skirt, plate.apart, avoid)
    if (!spot) {
      left.set(o.id, (left.get(o.id) ?? 0) + 1)
      if (!fitsAlone(want.w, want.h, edgeOf(want.reach, p.gapMm))) tooLarge.set(o.id, fitsAlone(want.w, want.h, p.gapMm))
      continue
    }
    placements.push({ id: o.id, copy, angleDeg: 0, offset: [spot.x + origin[0] - o.min[0], spot.y + origin[1] - o.min[1]] })
    placed.push({ r: { x: spot.x, y: spot.y, w: want.w, h: want.h }, grow: want.grow, reach: want.reach, ...(want.ar !== undefined ? { ar: want.ar } : {}) })
  }
  // With nothing staying, the layout goes to the middle of the bed when it has room, as the nest's layout does.
  const shift = p.center && p.fixed.length === 0 && left.size === 0 ? middleShift(placed, bed, p.gapMm, zones, towers, skirt, avoid) : null
  if (shift) for (const q of placements) q.offset = [q.offset[0] + shift[0], q.offset[1] + shift[1]]
  const wanted = copies.length
  return {
    placements,
    leftOver: [...left].map(([id, n]) => ({ id, copies: n })),
    tooLarge: [...tooLarge].map(([id, withoutMargin]) => ({ id, withoutMargin })),
    stats: { placed: placements.length, wanted, passes: 1, utilization: 0 },
  }
}

/**
 * nestInLanes on the boxes (boxPlate): the copies taller than the gantry rod one at a time, each clear of the lanes of
 * the ones before it, then the rest around them. Null when a tall copy does not fit outside the lanes.
 */
export function boxInLanes(p: NestPlate): NestReply | null {
  const tall = (o: NestObject) => overRod(o.size[2], p.config)
  const origin = [p.bed.x0, p.bed.y0] as const
  const apart = plateMargins(p.config, p.tools, { origin, size: { widthMm: p.bed.widthMm, depthMm: p.bed.depthMm } }).apart
  const fixed = [...p.fixed]
  const boxHull = (o: NestObject, at: readonly [number, number]): [number, number][] => {
    const [x0, y0] = [o.min[0] + at[0], o.min[1] + at[1]]
    const [x1, y1] = [x0 + o.size[0], y0 + o.size[1]]
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  }
  const hulls = fixed.filter((o) => tall(o) && o.at).map((o) => boxHull(o, o.at!))
  const placements: NestPlacement[] = []
  for (const o of p.moving.filter(tall)) {
    const m = objectPrintMargins(o.config)
    const size = { w: o.size[0], h: o.size[1], height: o.size[2] }
    const away = zoneKeep(m.grow(size), m.reach(size), p.gapMm, apart, false)
    for (let c = 1; c <= o.copies; c++) {
      const lanes = hulls.map((h) => gantryLane(h, arrangeRules(p.config), p.bed.x0, p.bed.widthMm, away))
      const r = boxPlate({ ...p, moving: [{ ...o, copies: 1 }], fixed, center: false, zones: [...(p.zones ?? []), ...lanes], skirt: false })
      const q = r.placements.find((x) => x.id === o.id)
      if (!q) return null
      placements.push({ ...q, copy: c })
      fixed.push({ ...o, id: `${o.id}~${c}`, copies: 1, at: q.offset })
      hulls.push(boxHull(o, q.offset))
    }
  }
  const low = p.moving.filter((o) => !tall(o))
  const rest: NestReply = low.length > 0 ? boxPlate({ ...p, moving: low, fixed, center: false }) : { placements: [], leftOver: [], tooLarge: [], stats: { placed: 0, wanted: 0, passes: 0, utilization: 0 } }
  return { ...rest, placements: [...placements, ...rest.placements] }
}

/** fillCount on the boxes (boxPlate): how many copies of `o` fit around the ones that stay, up to `max`. */
export function boxFillCount(p: Omit<NestPlate, 'moving' | 'center'>, o: NestObject, max: number): number {
  const bed = p.bed.circle ? Math.PI * p.bed.circle.r ** 2 : p.bed.widthMm * p.bed.depthMm
  const area = o.size[0] * o.size[1]
  const copies = area > 0 ? Math.min(max, Math.floor(bed / area)) : max
  if (copies <= 0) return 0
  return boxPlate({ ...p, moving: [{ ...o, copies }], center: false }).placements.filter((q) => q.id === o.id).length
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
