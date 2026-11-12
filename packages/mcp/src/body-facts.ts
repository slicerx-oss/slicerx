// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The facts design.check compares with a plan, read from a design's current body: its bounds (as geom.info gives
// them), whether each part is closed (welded by position, as geom.info and the slicer read it), its round holes (the
// inner loops of its flat faces, as geom.faces finds them, each measured with the engine's hole finder as geom.measure
// and geom.hole do), its feature steps with the planned feature each was tagged with, and its thinnest wall (a ray
// from each facet inward to the far side, through a grid of the facets, within a budget, skipping slivers and ledges
// a join leaves), when asked, the hook on its upright stem (hook-lip.ts) and, when asked, the floor of a part that holds
// something (holder-floor.ts), and for a plan with recess rows, its blind openings on any face (recesses.ts).
import { bakeMesh, stepName, type Design as HostDesign, type DesignHost, type HistoryMesh } from '@slicerx/cad-history'
import { notClosedWords, partClosure } from './closure'
import { colorWord, colorWordHex } from '@slicerx/pilot'
import type { BodyFacts, FitLimits, FloorFacts, PaintedRegion } from './design-check'
import { fitFacts } from './fit-facts'
import { floorOpenings } from './holder-floor'
import { hookOn, surfacePoints } from './hook-lip'
import { loftSections } from './plan-detail'
import { recessesOf } from './recesses'

type V3 = [number, number, number]
type Mesh = Pick<HistoryMesh, 'positions' | 'indices'>

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])

const vertex = (m: Mesh, i: number): V3 => [m.positions[i * 3] ?? 0, m.positions[i * 3 + 1] ?? 0, m.positions[i * 3 + 2] ?? 0]
const corners = (m: Mesh, t: number): [V3, V3, V3] => [vertex(m, m.indices[t * 3] ?? 0), vertex(m, m.indices[t * 3 + 1] ?? 0), vertex(m, m.indices[t * 3 + 2] ?? 0)]

/**
 * The facts about the design's body now; with `fit`, the limits of a print-in-place plan, its pieces and gaps too, with
 * `hook`, how far the hook on its upright stem rises at its tip, and with `floor`, where each part's cavity opens
 * through its bottom (holes up to `floor.plannedHoleMm` across left out, as the plan's own).
 */
export async function bodyFacts(host: DesignHost, d: HostDesign, fit?: FitLimits, opts: { hook?: boolean; nozzleMm?: number; floor?: { plannedHoleMm: number }; recesses?: boolean; bands?: { colors: readonly string[]; filaments?: readonly string[] | undefined } } = {}): Promise<BodyFacts> {
  const world = d.parts.map((p) => bakeMesh(p, d.transform))
  // closed as geom.info and the slicer read it: corners at the same point of the part's own positions are one vertex,
  // whatever their indices
  const shut = d.parts.map((p) => partClosure(p))
  const watertight = shut.length > 0 && shut.every((c) => c.watertight)
  const open = { boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 }
  for (const c of shut) {
    open.boundaryEdges += c.boundaryEdges
    open.nonManifoldEdges += c.nonManifoldEdges
    open.flippedEdges += c.flippedEdges
  }
  const holes: { part: number; at: V3; axis: V3; diameterMm: number }[] = []
  for (const [part, w] of world.entries()) {
    const loops = holeLoops(w)
    if (loops.length === 0) continue
    // the part as the engine takes it, copied once for all of its holes
    const mesh = { positions: Array.from(d.parts[part]!.positions), indices: Array.from(d.parts[part]!.indices) }
    for (const loop of loops) {
      let diameterMm = loop.diameterMm
      try {
        // the request geom.hole makes for a hole picked by its axis: the part with the object's transform
        const found = (await host.call('hole.find', { mesh: { mesh, transform: d.transform }, at: loop.at, axis: loop.axis })) as { diameterMm?: unknown }
        if (typeof found.diameterMm === 'number' && Number.isFinite(found.diameterMm)) diameterMm = found.diameterMm
      } catch {
        // the engine finds no hole on that line (a pocket it does not take, say): the loop's own size stands
      }
      holes.push({ part, at: loop.at, axis: loop.axis, diameterMm })
    }
  }
  const wall = minWall(world, checkWallBudget(), undefined, opts.nozzleMm)
  const shaping = d.history.steps.filter((s) => !s.suppressed && s.params.op !== 'paint')
  let gaps: Pick<BodyFacts, 'fit' | 'fitWhy'> = {}
  if (fit)
    try {
      gaps = { fit: await fitFacts(host, d, fit) }
    } catch (e) {
      gaps = { fitWhy: e instanceof Error ? e.message : String(e) }
    }
  return {
    size: bounds(world),
    holes: sameHoles(holes).map((h) => ({ diameterMm: h.diameterMm })),
    features: shaping.length,
    steps: shaping.map((s) => stepName(s)),
    tags: shaping.map((s) => s.feature?.trim() || null),
    stepIds: shaping.map((s) => s.id),
    lofts: loftSections(shaping as unknown as Parameters<typeof loftSections>[0]),
    ...(world.length > 1 ? { parts: world.map((w) => bounds([w])) } : {}),
    watertight,
    ...(watertight ? {} : { openWhy: notClosedWords(open) }),
    minWallMm: wall.mm,
    ...(wall.why ? { minWallWhy: wall.why } : {}),
    ...(wall.tip ? { minWallTip: wall.tip } : {}),
    ...gaps,
    ...(opts.hook ? hookFacts(world) : {}),
    ...(opts.recesses ? { recesses: world.flatMap((w) => recessesOf(w)).map((r) => ({ round: r.round, widthMm: r.widthMm, lengthMm: r.lengthMm, depthMm: r.depthMm })) } : {}),
    ...(opts.floor ? { floor: floorFacts(world, d.parts.map((p) => p.name), opts.floor.plannedHoleMm) } : {}),
    ...(opts.bands ? await paintFacts(host, d, world, opts.bands) : {}),
  }
}

/**
 * Each part's color paint as the engine reads it back (paint.regions, as slicerx_paint_regions does), region by region,
 * with the plain color word of its filament, and the plan's band colors as plain color words, for a plan with a color
 * band (colorBands). A part the engine cannot read gives no regions.
 */
async function paintFacts(host: DesignHost, d: HostDesign, world: readonly Mesh[], bands: { colors: readonly string[]; filaments?: readonly string[] | undefined }): Promise<Pick<BodyFacts, 'painted' | 'bandColors'>> {
  const painted: PaintedRegion[] = []
  for (const [part, p] of d.parts.entries()) {
    const texts = p.paint?.color
    if (!texts || !Object.keys(texts).length) continue
    const [lo, hi] = zRange(world[part]!)
    let read: { states?: { state: number; regions?: { boundsMm: { min: V3; max: V3 } }[] }[] }
    try {
      read = (await host.call('paint.regions', { mesh: { positions: Array.from(p.positions), indices: Array.from(p.indices) }, transform: d.transform, paint: texts })) as typeof read
    } catch {
      continue
    }
    for (const st of read.states ?? []) {
      if (!(st.state > 0)) continue
      const hex = bands.filaments?.[st.state - 1]
      for (const r of st.regions ?? []) painted.push({ part, slot: st.state, color: hex ? colorWord(hex) : null, fromMm: r3(r.boundsMm.min[2]), toMm: r3(r.boundsMm.max[2]), partFromMm: r3(lo), partToMm: r3(hi) })
    }
  }
  return { painted, bandColors: Object.fromEntries(bands.colors.map((c) => [c, colorWord(colorWordHex(c) ?? undefined)])) }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** A mesh's lowest and highest z. */
function zRange(m: Mesh): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 2; i < m.positions.length; i += 3) {
    lo = Math.min(lo, m.positions[i]!)
    hi = Math.max(hi, m.positions[i]!)
  }
  return [lo, hi]
}

/** Each part's floor, named by its part when it has a name (the build eval scorer reads it the same way). */
export function floorFacts(world: readonly Mesh[], names: readonly (string | undefined)[], plannedHoleMm: number): FloorFacts {
  const read = floorOpenings(world, plannedHoleMm)
  return {
    plannedHoleMm,
    parts: read.parts.map((p, k) => ({
      ...(names[k] ? { name: names[k] } : {}),
      faceZ: Math.round(p.faceZ * 1000) / 1000,
      openings: p.openings.map((o) => ({ from: o.from, to: o.to, alongMm: Math.round(o.alongMm * 1000) / 1000, acrossMm: Math.round(o.acrossMm * 1000) / 1000 })),
    })),
  }
}

/** The hook's tip rise on the part's upright stem, or nothing when the part has no such stem to read it from. */
function hookFacts(world: readonly Mesh[]): Pick<BodyFacts, 'hookTipRiseMm'> {
  const read = hookOn(surfacePoints(world))
  if (read.found === 'no stem') return {}
  return { hookTipRiseMm: read.found === 'hook' ? Math.round(read.riseMm * 100) / 100 : null }
}

/** The size of the bounds of the meshes together, zero with no triangles. */
function bounds(meshes: readonly Mesh[]): BodyFacts['size'] {
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes)
    for (let j = 0; j < m.indices.length; j++) {
      const v = vertex(m, m.indices[j] ?? 0)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, v[k]!)
        hi[k] = Math.max(hi[k]!, v[k]!)
      }
    }
  const r = (k: number): number => (hi[k]! >= lo[k]! ? Math.round((hi[k]! - lo[k]!) * 1000) / 1000 : 0)
  return { x: r(0), y: r(1), z: r(2) }
}

/** Two readings on one axis are one hole when their diameters agree within this, or this share of the narrower. */
const SAME_HOLE_MM = 0.1
const SAME_HOLE_SHARE = 0.02

/**
 * A hole seen at one end, and the same hole at its other end, are one hole: the narrower reading stands. Coaxial
 * readings of different sizes are different holes, such as a bearing bore and the narrower shoulder behind it.
 */
export function sameHoles<H extends { part: number; at: V3; axis: V3; diameterMm: number }>(found: readonly H[]): H[] {
  const out: H[] = []
  for (const h of found) {
    const k = out.findIndex((o) => {
      if (o.part !== h.part || Math.abs(Math.abs(dot(o.axis, h.axis)) - 1) > 1e-3) return false
      const off = sub(h.at, o.at)
      const across = len(sub(off, scale(o.axis, dot(off, o.axis))))
      const narrow = Math.min(o.diameterMm, h.diameterMm)
      return across <= Math.max(0.05, 0.1 * narrow) && Math.abs(o.diameterMm - h.diameterMm) <= Math.max(SAME_HOLE_MM, SAME_HOLE_SHARE * narrow)
    })
    if (k < 0) out.push(h)
    else if (h.diameterMm < out[k]!.diameterMm) out[k] = h
  }
  return out
}

/** Points closer than this are one vertex: STL coordinates are float32. */
const WELD_MM = 1e-4
const keyOf = (v: V3): string => `${Math.round(v[0] / WELD_MM)},${Math.round(v[1] / WELD_MM)},${Math.round(v[2] / WELD_MM)}`

/**
 * The round holes that open on the mesh's flat faces: each face's inner boundary loops (they run clockwise seen from
 * outside) that lie on a circle and whose walls face in toward the center, with a point on the axis (the loop's
 * center), the axis out of the hole and the circle's diameter.
 */
export function holeLoops(m: Mesh): { at: V3; axis: V3; diameterMm: number }[] {
  const tris = m.indices.length / 3
  const normals: (V3 | undefined)[] = []
  const keys: [string, string, string][] = []
  const pos = new Map<string, V3>()
  // every directed edge of the mesh, to find the face across a boundary edge
  const across = new Map<string, number>()
  for (let t = 0; t < tris; t++) {
    const c = corners(m, t)
    const n = cross(sub(c[1], c[0]), sub(c[2], c[0]))
    const l = len(n)
    normals.push(l > 1e-12 ? scale(n, 1 / l) : undefined)
    const k = c.map(keyOf) as [string, string, string]
    keys.push(k)
    c.forEach((v, j) => pos.set(k[j]!, v))
    for (let j = 0; j < 3; j++) across.set(`${k[j]}>${k[(j + 1) % 3]}`, t)
  }
  // flat faces: triangles on one plane facing one way
  const planes = new Map<string, number[]>()
  for (let t = 0; t < tris; t++) {
    const n = normals[t]
    if (!n) continue
    const at = pos.get(keys[t]![0])!
    const id = `${n.map((c) => Math.round(c * 1000)).join(',')}|${Math.round(dot(n, at) * 1000)}`
    const list = planes.get(id)
    if (list) list.push(t)
    else planes.set(id, [t])
  }
  const out: { at: V3; axis: V3; diameterMm: number }[] = []
  for (const group of planes.values()) {
    const n = normals[group[0]!]!
    const inFace = new Set<string>()
    for (const t of group) for (let j = 0; j < 3; j++) inFace.add(`${keys[t]![j]}>${keys[t]![(j + 1) % 3]}`)
    // boundary edges: a directed edge whose reverse is not in the face
    const next = new Map<string, string>()
    for (const e of inFace) {
      const [a, b] = e.split('>') as [string, string]
      if (!inFace.has(`${b}>${a}`)) next.set(a, b)
    }
    const seen = new Set<string>()
    for (const start of next.keys()) {
      if (seen.has(start)) continue
      const loop: string[] = []
      let at: string | undefined = start
      while (at !== undefined && !seen.has(at)) {
        seen.add(at)
        loop.push(at)
        at = next.get(at)
      }
      if (at !== start || loop.length < 8) continue
      const hole = roundHole(loop.map((k) => pos.get(k)!), n)
      if (!hole) continue
      // its walls face in toward the center: a hole, not a boss standing on the face
      const [a, b] = [loop[0]!, loop[1]!]
      const wall = across.get(`${b}>${a}`)
      const wn = wall === undefined ? undefined : normals[wall]
      const mid = scale([...pos.get(a)!].map((c, k) => c + pos.get(b)![k]!) as V3, 0.5)
      if (!wn || dot(wn, sub(hole.at, mid)) <= 0) continue
      out.push({ ...hole, axis: n })
    }
  }
  return out
}

/** A closed loop on a plane (normal n) that runs clockwise seen from n and lies on a circle: its center and diameter. */
function roundHole(points: readonly V3[], n: V3): { at: V3; diameterMm: number } | null {
  const u0: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = cross(n, u0)
  const ul = len(u)
  const uu = scale(u, 1 / ul)
  const v = cross(n, uu)
  // in the plane, from the first point, so far-off coordinates keep their precision
  const p0 = points[0]!
  const flat = points.map((p) => [dot(sub(p, p0), uu), dot(sub(p, p0), v)] as [number, number])
  let area = 0
  let cx = 0
  let cy = 0
  for (let k = 0; k < flat.length; k++) {
    const [a, b] = [flat[k]!, flat[(k + 1) % flat.length]!]
    const w = a[0] * b[1] - b[0] * a[1]
    area += w
    cx += (a[0] + b[0]) * w
    cy += (a[1] + b[1]) * w
  }
  if (area >= 0) return null
  // The center is the loop's area centroid, not the mean of its corners: a boolean leaves a rim with its corners
  // bunched along some arcs, which pulls their mean off the axis (up to 3.5 mm on a 21.9 mm bore).
  const [ox, oy] = [cx / (3 * area), cy / (3 * area)]
  const at: V3 = [p0[0] + uu[0] * ox + v[0] * oy, p0[1] + uu[1] * ox + v[1] * oy, p0[2] + uu[2] * ox + v[2] * oy]
  const radii = flat.map(([x, y]) => Math.hypot(x - ox, y - oy))
  const most = Math.max(...radii)
  const least = Math.min(...radii)
  // a polygon's corners lie on its circle; an edge split on the way is a little inside it
  if (most <= 0 || (most - least) / most > 0.03) return null
  return { at, diameterMm: 2 * most }
}

/**
 * How much work the thinnest wall may take, for each part on its own. Past it the wall is reported as not measured,
 * never as a guess, unless a wall under the floor was read already: that part fails whatever else it holds. The work is
 * counted, not timed, so a loaded machine reads the same wall a quiet one does.
 */
export interface WallBudget {
  /** Facets of one part. */
  maxFacets: number
  /** Steps of work in one part: each facet a ray is tested against, each grid cell it passes, each facet a check of a taper or a flat patch looks at. */
  maxWork: number
}
/**
 * A curved part hollowed by the voxel shell (a lofted bottle shelled to 2 mm) comes back with about 600,000 facets and
 * reads its wall in about 23 million steps, under a second on a quiet machine, so the caps leave room for one that
 * size, about two and a half times over in work; a part copied (an arrayed detail) is read once.
 */
export const WALL_BUDGET: WallBudget = { maxFacets: 1_000_000, maxWork: 60_000_000 }

/** The budget design.check reads the wall with: counted work, the same on every machine. */
export function checkWallBudget(): WallBudget {
  return WALL_BUDGET
}

/**
 * The thinnest wall, in mm, or null with the reason when it was not measured (null alone: no ray met a far side). `mm`
 * leaves out readings under the floor between faces that meet within that floor of the ray's start, a taper
 * (tapers in partWall); the thinnest
 * of those is `tip`, with where its ray started, when it is thinner than `mm`.
 */
export interface WallReading {
  mm: number | null
  why?: string
  tip?: { mm: number; at: V3 }
}

/** The nozzle minWall reads tips for when it is given none: a tip zone and a floor of two nozzle widths. */
const WALL_NOZZLE_MM = 0.4
/** A taper's faces close to this share of the gap the ray read within the zone (tapers in partWall). */
const TAPER_CLOSE = 0.8

const TOO_DENSE = 'part too dense'
/** Grid cells per part at most, and facet entries over all cells (a facet is listed in each cell its bounds cross). */
const MAX_CELLS = 1 << 21
const MAX_ENTRIES = 4_000_000

/**
 * The thinnest wall: from the center of every facet a ray goes in, against its outward normal, to the first facet of
 * the same part it meets on the far side. The shortest such distance over every part. Each part's facets sit in a
 * uniform grid, so a ray only tests the facets of the cells it passes through. Over the budget (too many facets, or too
 * long) the reading is null with why "part too dense". A far facet counts only when it faces back against the facet the
 * ray starts from: the cosine between their two normals is under -`opposed` (OPPOSED unless given). Needles, specks and
 * flat patches narrower than LEDGE_MM across measure no wall.
 */
export function minWall(meshes: readonly Mesh[], budget: WallBudget = WALL_BUDGET, opposed = OPPOSED, nozzleMm = WALL_NOZZLE_MM, used?: { work: number }): WallReading {
  const nozzle = Number.isFinite(nozzleMm) && nozzleMm > 0 ? nozzleMm : WALL_NOZZLE_MM
  // the floor design.check holds the wall to (twice the nozzle), which is also the tip zone
  const floor = 2 * nozzle
  const read: PartReading = { best: Infinity, tip: Infinity, tipAt: [0, 0, 0] }
  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  const reading = (): WallReading => {
    const tip = read.tip < read.best ? { tip: { mm: r3(read.tip), at: read.tipAt.map((v) => Math.round(v * 100) / 100) as V3 } } : {}
    return { mm: Number.isFinite(read.best) ? r3(read.best) : null, ...tip }
  }
  const seen: Mesh[] = []
  for (const m of meshes) {
    // a part that is another one moved (an arrayed copy) has its walls: it is read once
    if (seen.some((o) => moved(o, m))) continue
    seen.push(m)
    const done = Math.floor(m.indices.length / 3) <= budget.maxFacets && partWall(m, read, budget.maxWork, opposed, floor, used)
    // out of budget: a wall under the floor read already fails the part, whatever else it holds; else not measured
    if (!done) return read.best < floor ? reading() : { mm: null, why: TOO_DENSE }
  }
  return reading()
}

/** Whether part `b` is part `a` moved: the same facets on the same corners, each corner shifted by the same amount. */
function moved(a: Mesh, b: Mesh): boolean {
  if (a.indices.length !== b.indices.length || a.positions.length !== b.positions.length || a.positions.length < 3) return false
  for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) return false
  const shift = [0, 1, 2].map((k) => b.positions[k]! - a.positions[k]!)
  for (let i = 0; i < a.positions.length; i++) if (Math.abs(b.positions[i]! - a.positions[i]! - shift[i % 3]!) > 1e-6) return false
  return true
}

/** The thinnest wall away from tips so far, and the thinnest reading under the floor at a tip, with where its ray started. */
interface PartReading {
  best: number
  tip: number
  tipAt: V3
}

/** A facet whose doubled area is under this share of its longest edge squared is a needle (about a 0.06 degree corner). */
const NEEDLE = 1e-3
/** A facet whose longest edge is under this, in mm, is a speck no nozzle prints: it measures no wall. */
const SPECK_MM = 0.01
/**
 * A flat patch narrower than this, in mm, across its narrow way measures no wall: a ledge a flush join leaves where two
 * rims of different facet counts meet on one circle, a strip microns wide but as long as the rim. Its width, not its
 * thickness, is what makes it no wall: a real wall 0.004 mm thick and millimeters wide still reads 0.004 mm.
 */
const LEDGE_MM = 0.01
/** Facets edge to edge whose normals are within about 2 degrees of the reading facet's are one flat patch with it. */
const FLAT_COS = Math.cos((2 * Math.PI) / 180)
/** A patch of more facets than this is wide enough to be a wall, without measuring it. */
const PATCH_MAX = 2048

/** Whether facets `a` and `b` (offsets into `tri`) share an edge: two corners at the same place. */
function shareEdge(tri: Float64Array, a: number, b: number): boolean {
  let same = 0
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (tri[a + i * 3] === tri[b + j * 3] && tri[a + i * 3 + 1] === tri[b + j * 3 + 1] && tri[a + i * 3 + 2] === tri[b + j * 3 + 2]) same++
  return same >= 2
}

/**
 * Reads one part's thinnest wall into `read`, keeping what is thinner there already; false when its work passes
 * `maxWork` steps (counted into `used` when given). `zone` is both the floor and the tip zone: a reading under it whose faces meet within it of the
 * ray's start (tapers) is a tip, kept apart from the wall.
 */
function partWall(m: Mesh, read: PartReading, maxWork: number, opposed: number, zone: number, used?: { work: number }): boolean {
  const tris = Math.floor(m.indices.length / 3)
  if (tris === 0) return true
  // the steps of work so far: facets tested against a ray, cells passed, facets a taper or flat patch check looks at
  let work = 0
  // every facet's corners, nine numbers each
  const tri = new Float64Array(tris * 9)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < tris; t++)
    for (let j = 0; j < 3; j++) {
      const vi = m.indices[t * 3 + j] ?? 0
      for (let k = 0; k < 3; k++) {
        const v = m.positions[vi * 3 + k] ?? 0
        tri[t * 9 + j * 3 + k] = v
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
    }
  const span = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!, 1e-9)
  const pad = span * 1e-6
  const ext = [0, 1, 2].map((k) => Math.max(hi[k]! - lo[k]!, span * 1e-3))
  // about one facet per cell, coarser until the cells and the entries fit
  let h = Math.cbrt((ext[0]! * ext[1]! * ext[2]!) / Math.min(tris, MAX_CELLS))
  let n0 = 1
  let n1 = 1
  let n2 = 1
  let cs0 = ext[0]!
  let cs1 = ext[1]!
  let cs2 = ext[2]!
  const cell = (v: number, k: number, size: number, count: number): number => Math.min(count - 1, Math.max(0, Math.floor((v - lo[k]!) / size)))
  const range = (t: number, k: number, size: number, count: number): [number, number] => {
    const b = t * 9 + k
    const a = Math.min(tri[b]!, tri[b + 3]!, tri[b + 6]!)
    const z = Math.max(tri[b]!, tri[b + 3]!, tri[b + 6]!)
    return [cell(a - pad, k, size, count), cell(z + pad, k, size, count)]
  }
  let entries = 0
  for (;;) {
    n0 = Math.max(1, Math.ceil(ext[0]! / h))
    n1 = Math.max(1, Math.ceil(ext[1]! / h))
    n2 = Math.max(1, Math.ceil(ext[2]! / h))
    cs0 = ext[0]! / n0
    cs1 = ext[1]! / n1
    cs2 = ext[2]! / n2
    const cells = n0 * n1 * n2
    if (cells > MAX_CELLS) {
      h *= 1.26
      continue
    }
    entries = 0
    for (let t = 0; t < tris; t++) {
      const [a0, z0] = range(t, 0, cs0, n0)
      const [a1, z1] = range(t, 1, cs1, n1)
      const [a2, z2] = range(t, 2, cs2, n2)
      entries += (z0 - a0 + 1) * (z1 - a1 + 1) * (z2 - a2 + 1)
    }
    if (entries > MAX_ENTRIES && cells > 1) {
      h *= 1.26
      continue
    }
    break
  }
  // the facets of each cell, in one list: cell c holds items[start[c]] up to items[start[c + 1]]
  const cells = n0 * n1 * n2
  const start = new Int32Array(cells + 1)
  const items = new Int32Array(entries)
  for (let pass = 0; pass < 2; pass++) {
    const fill = pass === 1 ? start.slice(0, cells) : null
    for (let t = 0; t < tris; t++) {
      const [a0, z0] = range(t, 0, cs0, n0)
      const [a1, z1] = range(t, 1, cs1, n1)
      const [a2, z2] = range(t, 2, cs2, n2)
      for (let c2 = a2; c2 <= z2; c2++)
        for (let c1 = a1; c1 <= z1; c1++)
          for (let c0 = a0; c0 <= z0; c0++) {
            const c = (c2 * n1 + c1) * n0 + c0
            if (fill) items[fill[c]!++] = t
            else start[c + 1]!++
          }
    }
    if (pass === 0) for (let c = 0; c < cells; c++) start[c + 1] = start[c + 1]! + start[c]!
  }
  // the ray each facet was last tested against, so a facet in several cells is tested once per ray
  const tested = new Int32Array(tris).fill(-1)
  // whether each facet's flat patch is narrower than LEDGE_MM: 0 not measured yet, 1 narrow, 2 wide
  const flat = new Int8Array(tris)
  let best = read.best
  for (let t = 0; t < tris; t++) {
    if ((t & 255) === 0 && work > maxWork) {
      if (used) used.work += work
      read.best = Math.min(read.best, best)
      return false
    }
    const b = t * 9
    const e10 = tri[b + 3]! - tri[b]!
    const e11 = tri[b + 4]! - tri[b + 1]!
    const e12 = tri[b + 5]! - tri[b + 2]!
    const e20 = tri[b + 6]! - tri[b]!
    const e21 = tri[b + 7]! - tri[b + 1]!
    const e22 = tri[b + 8]! - tri[b + 2]!
    const nx = e11 * e22 - e12 * e21
    const ny = e12 * e20 - e10 * e22
    const nz = e10 * e21 - e11 * e20
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-12) continue
    // a needle facet (a sliver a boolean leaves where faces meet) has no reliable normal: its ray runs along the
    // surface into the next facet and reads a wall of nothing. The facets around it measure the wall there.
    const e30 = tri[b + 6]! - tri[b + 3]!
    const e31 = tri[b + 7]! - tri[b + 4]!
    const e32 = tri[b + 8]! - tri[b + 5]!
    const longest = Math.max(e10 * e10 + e11 * e11 + e12 * e12, e20 * e20 + e21 * e21 + e22 * e22, e30 * e30 + e31 * e31 + e32 * e32)
    if (l < NEEDLE * longest || longest < SPECK_MM * SPECK_MM) continue
    const d0 = -nx / l
    const d1 = -ny / l
    const d2 = -nz / l
    const o0 = (tri[b]! + tri[b + 3]! + tri[b + 6]!) / 3
    const o1 = (tri[b + 1]! + tri[b + 4]! + tri[b + 7]!) / 3
    const o2 = (tri[b + 2]! + tri[b + 5]! + tri[b + 8]!) / 3
    // walk the cells the ray passes through, nearest first (Amanatides and Woo)
    let i0 = cell(o0, 0, cs0, n0)
    let i1 = cell(o1, 1, cs1, n1)
    let i2 = cell(o2, 2, cs2, n2)
    const s0 = d0 > 0 ? 1 : -1
    const s1 = d1 > 0 ? 1 : -1
    const s2 = d2 > 0 ? 1 : -1
    let t0 = d0 !== 0 ? (lo[0]! + (i0 + (d0 > 0 ? 1 : 0)) * cs0 - o0) / d0 : Infinity
    let t1 = d1 !== 0 ? (lo[1]! + (i1 + (d1 > 0 ? 1 : 0)) * cs1 - o1) / d1 : Infinity
    let t2 = d2 !== 0 ? (lo[2]! + (i2 + (d2 > 0 ? 1 : 0)) * cs2 - o2) / d2 : Infinity
    const dt0 = d0 !== 0 ? cs0 / Math.abs(d0) : Infinity
    const dt1 = d1 !== 0 ? cs1 / Math.abs(d1) : Infinity
    const dt2 = d2 !== 0 ? cs2 / Math.abs(d2) : Infinity
    let hit = Infinity
    let hitFacet = -1
    // whether the nearest facet met so far faces back against this one, as the far side of a wall does
    let faces = true
    for (;;) {
      const c = (i2 * n1 + i1) * n0 + i0
      work += 1 + start[c + 1]! - start[c]!
      for (let q = start[c]!; q < start[c + 1]!; q++) {
        const f = items[q]!
        if (f === t || tested[f] === t) continue
        tested[f] = t
        const d = rayHit(o0, o1, o2, d0, d1, d2, tri, f * 9)
        // a facet sharing an edge with this one is its neighbor on the same surface, never the far side of a wall
        if (d > 1e-6 && d < hit && !shareEdge(tri, b, f * 9)) {
          hit = d
          hitFacet = f
          // the ray runs along this facet's normal turned in, so the far facet's normal against the ray is the cosine
          // between the two normals with its sign turned
          faces = facing(tri, f * 9, d0, d1, d2) > opposed
        }
      }
      const exit = Math.min(t0, t1, t2)
      // a hit inside the cells walked so far is the first; a cell past the best wall cannot beat it
      if (hit <= exit || exit >= best) break
      if (t0 === exit) {
        i0 += s0
        if (i0 < 0 || i0 >= n0) break
        t0 += dt0
      } else if (t1 === exit) {
        i1 += s1
        if (i1 < 0 || i1 >= n1) break
        t1 += dt1
      } else {
        i2 += s2
        if (i2 < 0 || i2 >= n2) break
        t2 += dt2
      }
    }
    // A ray that meets a facet from outside has crossed air, not material: the gap between two bodies, or a facet whose
    // normal points out. A far facet that does not face back against this one meets it across an edge: from a sliver,
    // from beside the rim of a tube cut at a slant, or from the top face of an open rim over facets that lean in under
    // it, the ray reads how near it starts to that edge. None is a wall. Nor is a reading from a flat patch narrower
    // than LEDGE_MM across (asked only of a reading that would win).
    // A reading under the floor between faces that meet within the zone of its start is a taper, not a wall:
    // the rim of a flared body cut flat at a line, a pointed end. It is kept as the tip apart from the wall,
    // so a real thin wall away from any edge still fails while a sharp rim only warns (asked only of a reading that
    // would win: the tip matters only while the wall away from tips holds the floor).
    if (faces && (hit < best || (best >= zone && hit < read.tip)) && !narrow(t)) {
      if (hit < zone && tapers(hitFacet, d0, d1, d2, hit, o0, o1, o2)) {
        if (hit < read.tip) {
          read.tip = hit
          read.tipAt = [o0, o1, o2]
        }
      } else if (hit < best) best = hit
    }
  }
  read.best = best
  if (used) used.work += work
  return true

  /**
   * Whether the reading `hit` along the unit ray `(d0, d1, d2)` (against the start facet's outward normal), started at
   * `(x, y, z)`, to the far facet `far` is a taper's. Two things make it one. The two facets' planes meet within the
   * zone of the start: faces at an angle theta meet hit / tan(theta) away, so a 0.4 mm wall with a 2 degree draft meets
   * 11 mm away and is a wall, while a flared side cut flat meets its cut a hair away. And the part has a corner within
   * the zone where the faces have closed in: no farther from either plane than TAPER_CLOSE of the gap the ray read (the
   * corners of the rim where they meet). A thin floor whose far face only leans toward a meeting line the floor never
   * reaches (a countersink over a floor cut off by its bore) has no such corner, and stays a wall.
   */
  function tapers(far: number, d0: number, d1: number, d2: number, hit: number, x: number, y: number, z: number): boolean {
    if (far < 0) return false
    const n = unitNormal(tri, far * 9)
    // the start facet's outward normal is -d; the faces' angle theta has cos theta = -(-d . n) = d . n
    const cos = d0 * n[0] + d1 * n[1] + d2 * n[2]
    if (cos >= 1 - 1e-9) return false
    const tan = Math.sqrt(1 - cos * cos) / Math.max(cos, 1e-9)
    if (hit / tan > zone) return false
    const h: V3 = [x + d0 * hit, y + d1 * hit, z + d2 * hit]
    // a corner's gap to the far plane and to the start plane, each against the start's (inside the solid is positive)
    const farGap = TAPER_CLOSE * hit * cos
    const startGap = TAPER_CLOSE * hit
    const r = zone + pad
    const [a0, z0] = [cell(x - r, 0, cs0, n0), cell(x + r, 0, cs0, n0)]
    const [a1, z1] = [cell(y - r, 1, cs1, n1), cell(y + r, 1, cs1, n1)]
    const [a2, z2] = [cell(z - r, 2, cs2, n2), cell(z + r, 2, cs2, n2)]
    for (let c2 = a2; c2 <= z2; c2++)
      for (let c1 = a1; c1 <= z1; c1++)
        for (let c0 = a0; c0 <= z0; c0++) {
          const c = (c2 * n1 + c1) * n0 + c0
          work += 1 + start[c + 1]! - start[c]!
          for (let q = start[c]!; q < start[c + 1]!; q++)
            for (let j = 0; j < 3; j++) {
              const at = items[q]! * 9 + j * 3
              const [px, py, pz] = [tri[at]!, tri[at + 1]!, tri[at + 2]!]
              if (Math.hypot(px - x, py - y, pz - z) > zone) continue
              const toFar = n[0] * (h[0] - px) + n[1] * (h[1] - py) + n[2] * (h[2] - pz)
              const toStart = -(d0 * (x - px) + d1 * (y - py) + d2 * (z - pz))
              if (toFar <= farGap && toStart <= startGap) return true
            }
        }
    return false
  }

  /**
   * Whether facet `seed` lies in a flat patch narrower than LEDGE_MM across. The patch is the facets reached edge to edge
   * from it whose normals are within FLAT_COS of its own (against the seed's, not chained, so a curved surface never
   * joins up). Its width is twice the farthest any of its corners, edge middles and facet centers lies from its
   * boundary (the edges no other facet of the patch shares): a strip reads its width however long or curved it is, and
   * a face millimeters wide has points far inside it. A patch whose area is over its boundary length times LEDGE_MM is
   * wide without that measure (every point of a narrow one is within LEDGE_MM / 2 of the boundary). The answer holds
   * for every facet of the patch, so each patch is measured once.
   */
  function narrow(seed: number): boolean {
    const known = flat[seed]!
    if (known !== 0) return known === 1
    // a facet whose own center is half the width inside its own edges is in a wide patch: the patch's boundary is
    // those edges or lies past them
    if (deepInside(tri, seed)) {
      flat[seed] = 2
      return false
    }
    const n = unitNormal(tri, seed * 9)
    const members = [seed]
    const inPatch = new Set(members)
    for (let k = 0; k < members.length && members.length <= PATCH_MAX; k++) {
      const u = members[k]!
      const [a0, z0] = range(u, 0, cs0, n0)
      const [a1, z1] = range(u, 1, cs1, n1)
      const [a2, z2] = range(u, 2, cs2, n2)
      for (let c2 = a2; c2 <= z2; c2++)
        for (let c1 = a1; c1 <= z1; c1++)
          for (let c0 = a0; c0 <= z0; c0++) {
            const c = (c2 * n1 + c1) * n0 + c0
            work += 1 + start[c + 1]! - start[c]!
            for (let q = start[c]!; q < start[c + 1]!; q++) {
              const f = items[q]!
              if (inPatch.has(f)) continue
              const nf = unitNormal(tri, f * 9)
              if (nf[0] * n[0] + nf[1] * n[1] + nf[2] * n[2] > FLAT_COS && shareEdge(tri, u * 9, f * 9)) {
                inPatch.add(f)
                members.push(f)
              }
            }
          }
    }
    const thin = members.length <= PATCH_MAX && patchNarrow(tri, members)
    for (const f of members) flat[f] = thin ? 1 : 2
    return thin
  }
}

/** The unit normal of the facet at `tri[at]`, or zeros for a facet with no area. */
function unitNormal(tri: Float64Array, at: number): V3 {
  const e10 = tri[at + 3]! - tri[at]!
  const e11 = tri[at + 4]! - tri[at + 1]!
  const e12 = tri[at + 5]! - tri[at + 2]!
  const e20 = tri[at + 6]! - tri[at]!
  const e21 = tri[at + 7]! - tri[at + 1]!
  const e22 = tri[at + 8]! - tri[at + 2]!
  const nx = e11 * e22 - e12 * e21
  const ny = e12 * e20 - e10 * e22
  const nz = e10 * e21 - e11 * e20
  const l = Math.hypot(nx, ny, nz)
  return l > 1e-30 ? [nx / l, ny / l, nz / l] : [0, 0, 0]
}

/** Whether the flat patch of facets `members` is narrower than LEDGE_MM across (see partWall's narrow). */
function patchNarrow(tri: Float64Array, members: readonly number[]): boolean {
  const at = (f: number, j: number): V3 => [tri[f * 9 + j * 3]!, tri[f * 9 + j * 3 + 1]!, tri[f * 9 + j * 3 + 2]!]
  const key = (p: V3, q: V3): string => {
    const a = `${p[0]},${p[1]},${p[2]}`
    const b = `${q[0]},${q[1]},${q[2]}`
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }
  // each edge of the patch with how many of its facets have it
  const edges = new Map<string, { p: V3; q: V3; n: number }>()
  let area = 0
  for (const f of members) {
    const c = [at(f, 0), at(f, 1), at(f, 2)] as const
    area += len(cross(sub(c[1], c[0]), sub(c[2], c[0]))) / 2
    for (let j = 0; j < 3; j++) {
      const p = c[j]!
      const q = c[(j + 1) % 3]!
      const k = key(p, q)
      const e = edges.get(k)
      if (e) e.n++
      else edges.set(k, { p, q, n: 1 })
    }
  }
  const rim = [...edges.values()].filter((e) => e.n === 1)
  const perimeter = rim.reduce((s, e) => s + len(sub(e.q, e.p)), 0)
  if (perimeter <= 0 || area > perimeter * LEDGE_MM) return false
  const half = LEDGE_MM / 2
  // whether `x` is at least half the width from every boundary edge: a point that deep makes the patch wide
  const deep = (x: V3): boolean => rim.every((e) => segmentDistance(x, e.p, e.q) >= half)
  for (const f of members) {
    const c = [at(f, 0), at(f, 1), at(f, 2)] as const
    if (deep(scale([c[0][0] + c[1][0] + c[2][0], c[0][1] + c[1][1] + c[2][1], c[0][2] + c[1][2] + c[2][2]], 1 / 3))) return false
  }
  for (const e of edges.values()) {
    if (deep(e.p) || deep(e.q)) return false
    if (e.n > 1 && deep(scale([e.p[0] + e.q[0], e.p[1] + e.q[1], e.p[2] + e.q[2]], 0.5))) return false
  }
  return true
}

/** Whether the center of the facet at `tri[f * 9]` lies at least LEDGE_MM / 2 from each of its edges. */
function deepInside(tri: Float64Array, f: number): boolean {
  const c = [0, 1, 2].map((j) => [tri[f * 9 + j * 3]!, tri[f * 9 + j * 3 + 1]!, tri[f * 9 + j * 3 + 2]!] as V3)
  const [a, b, d] = c as [V3, V3, V3]
  const mid: V3 = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3]
  const half = LEDGE_MM / 2
  return segmentDistance(mid, a, b) >= half && segmentDistance(mid, b, d) >= half && segmentDistance(mid, d, a) >= half
}

/** The distance from `x` to the segment from `p` to `q`. */
function segmentDistance(x: V3, p: V3, q: V3): number {
  const d = sub(q, p)
  const dd = dot(d, d)
  const s = dd > 0 ? Math.min(1, Math.max(0, dot(sub(x, p), d) / dd)) : 0
  return len(sub(x, [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s]))
}

/**
 * How squarely a far facet must face back against the facet a ray starts from to measure a wall: the cosine between
 * their normals must be under minus this (about 61 degrees short of straight back; a wall's two faces meet at -1).
 * The two faces of a wall, tapered or not, face nearly opposite each other. Where they meet less squarely, the far
 * facet lies across an edge from the start, and the reading is how near the start is to that edge:
 * - the slanted tip of a swept spout: rays beside the rim leave through the bore at -0.10 to -0.2 and read 0.07 to
 *   0.3 mm of a 1.6 mm wall;
 * - the open top of a twisted vase with a 2 mm wall, whose cavity's last section is 1.1 mm under the rim: the top
 *   face and the facets leaning in under it meet at -0.38 to -0.425 and read 0.89 to 0.95 mm;
 * - a toy rocket's 4 mm fin, from its flat bottom to its slanted edge: -0.457, 2.13 mm.
 * The thinnest real wall that meets least squarely in the recorded builds is a cable clip's 0.41 mm floor between its
 * countersink and its bore, at -0.522. This sits between the two: over the -0.457 the edges reach, under the -0.522 a
 * real floor keeps.
 */
const OPPOSED = 0.49

/** The cosine between the facet's normal at `tri[at]` and a unit direction: above zero when the direction leaves the solid through it. */
function facing(tri: Float64Array, at: number, d0: number, d1: number, d2: number): number {
  const e10 = tri[at + 3]! - tri[at]!
  const e11 = tri[at + 4]! - tri[at + 1]!
  const e12 = tri[at + 5]! - tri[at + 2]!
  const e20 = tri[at + 6]! - tri[at]!
  const e21 = tri[at + 7]! - tri[at + 1]!
  const e22 = tri[at + 8]! - tri[at + 2]!
  const nx = e11 * e22 - e12 * e21
  const ny = e12 * e20 - e10 * e22
  const nz = e10 * e21 - e11 * e20
  const l = Math.hypot(nx, ny, nz)
  return l > 1e-12 ? (nx * d0 + ny * d1 + nz * d2) / l : 0
}

/** Where a ray meets the triangle at `tri[at]` (nine numbers), as its distance along the ray (Moller and Trumbore), or -1. */
function rayHit(f0: number, f1: number, f2: number, d0: number, d1: number, d2: number, tri: Float64Array, at: number): number {
  const a0 = tri[at]!
  const a1 = tri[at + 1]!
  const a2 = tri[at + 2]!
  const e10 = tri[at + 3]! - a0
  const e11 = tri[at + 4]! - a1
  const e12 = tri[at + 5]! - a2
  const e20 = tri[at + 6]! - a0
  const e21 = tri[at + 7]! - a1
  const e22 = tri[at + 8]! - a2
  // p = dir x e2
  const p0 = d1 * e22 - d2 * e21
  const p1 = d2 * e20 - d0 * e22
  const p2 = d0 * e21 - d1 * e20
  const det = e10 * p0 + e11 * p1 + e12 * p2
  if (Math.abs(det) < 1e-12) return -1
  const inv = 1 / det
  const s0 = f0 - a0
  const s1 = f1 - a1
  const s2 = f2 - a2
  const u = (s0 * p0 + s1 * p1 + s2 * p2) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return -1
  // q = s x e1
  const q0 = s1 * e12 - s2 * e11
  const q1 = s2 * e10 - s0 * e12
  const q2 = s0 * e11 - s1 * e10
  const v = (d0 * q0 + d1 * q1 + d2 * q2) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return -1
  return (e20 * q0 + e21 * q1 + e22 * q2) * inv
}
