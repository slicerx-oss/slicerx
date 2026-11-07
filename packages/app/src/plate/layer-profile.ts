// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights: a curve of layer height against height above the bed, set by hand in the layer height
// editor (or by a client through the app link, or read from a project file's layer_height_profile). The slice turns it
// into the layer tops the engine already takes (options.layerTopsMm), so it replaces sleipnir's plan and the fixed
// layer height on that plate. A plate without one slices exactly as before.
import type { PlateEntry } from '../state/store'
import { bounds } from './transform'

/** One point of the curve: height above the bed and the layer height there, both mm. */
export type ProfilePoint = [zMm: number, heightMm: number]

/** What the printer allows: the thinnest and thickest layer, and the first layer's height, mm. */
export interface LayerLimits {
  minMm: number
  maxMm: number
  firstMm: number
}

/** The engine's own bounds on a layer it is given (packages/core/src/session.rs, LayerPlan::from_tops). */
export const ENGINE_MIN_MM = 0.04
export const ENGINE_MAX_MM = 0.8
/** Points a profile keeps at most; a file's longer profile is thinned to this many. */
export const MAX_POINTS = 200
/** Layers a profile may make at most, as the engine allows. */
const MAX_LAYERS = 200_000

const first = (v: unknown): number => Number(Array.isArray(v) ? v[0] : v)
const all = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).map(Number)
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4

/**
 * The printer's limits from a resolved config: min_layer_height and max_layer_height (0 or missing: 0.07 mm and three
 * quarters of the nozzle, as the engine reads them), kept inside what the engine takes. On a printer with several
 * extruders whose limits differ, the strictest of them: the largest minimum and the smallest maximum, each extruder's
 * maximum from its own entry or its own nozzle, so every layer prints on any of its nozzles. The first layer is the
 * config's first layer height, or the layer height over a raft.
 */
export function layerLimits(config: Readonly<Record<string, unknown>>): LayerLimits {
  const nozzles = all(config['nozzle_diameter'])
  const los = all(config['min_layer_height'])
  const his = all(config['max_layer_height'])
  const n = Math.max(1, nozzles.length, los.length, his.length)
  let lo = ENGINE_MIN_MM
  let hi = ENGINE_MAX_MM
  for (let i = 0; i < n; i++) {
    const nozzle = nozzles[i] ?? nozzles[0] ?? NaN
    const nozzleMm = Number.isFinite(nozzle) && nozzle > 0 ? nozzle : 0.4
    const l = los[i] ?? los[0] ?? NaN
    const h = his[i] ?? his[0] ?? NaN
    lo = Math.max(lo, Number.isFinite(l) && l > 0 ? l : 0.07)
    hi = Math.min(hi, Number.isFinite(h) && h > 0 ? h : 0.75 * nozzleMm)
  }
  const minMm = round4(Math.min(ENGINE_MAX_MM, lo))
  const maxMm = round4(Math.max(minMm, hi))
  const raft = first(config['raft_layers'])
  const layer = first(config['layer_height'])
  const firstLayer = first(config['initial_layer_print_height'])
  const firstRaw = Number.isFinite(raft) && raft > 0 ? layer : firstLayer
  const firstMm = round4(Math.min(ENGINE_MAX_MM, Math.max(ENGINE_MIN_MM, Number.isFinite(firstRaw) && firstRaw > 0 ? firstRaw : 0.2)))
  return { minMm, maxMm, firstMm }
}

/** The layer height the curve gives at `z`: straight lines between points, the end points' heights past either end. */
export function heightAt(points: readonly ProfilePoint[], z: number): number {
  if (points.length === 0) return NaN
  if (z <= points[0]![0]) return points[0]![1]
  for (let i = 1; i < points.length; i++) {
    const [z1, h1] = points[i]!
    if (z <= z1) {
      const [z0, h0] = points[i - 1]!
      return z1 === z0 ? h1 : h0 + ((h1 - h0) * (z - z0)) / (z1 - z0)
    }
  }
  return points[points.length - 1]![1]
}

/**
 * A profile made safe to use: finite points only, heights above the bed from 0, rising (a repeated height keeps its
 * last point), each layer height inside the limits, at most MAX_POINTS points. A longer one keeps the points that
 * shape the curve most (the ends, then each step and bend), not every Nth. `clamped` says a height was moved into the
 * limits; `dropped` that a point was left out. Null when no point is left.
 */
export function cleanProfile(points: readonly (readonly number[])[], limits: Pick<LayerLimits, 'minMm' | 'maxMm'>): { points: ProfilePoint[]; clamped: boolean; dropped: boolean } | null {
  let clamped = false
  let dropped = false
  const byZ = new Map<number, number>()
  for (const p of points) {
    const z = Number(p[0])
    const h = Number(p[1])
    if (p.length < 2 || !Number.isFinite(z) || !Number.isFinite(h) || z < 0 || h <= 0) {
      dropped = true
      continue
    }
    const kept = round4(Math.min(limits.maxMm, Math.max(limits.minMm, h)))
    if (Math.abs(kept - h) > 1e-4) clamped = true
    const key = round4(z)
    if (byZ.has(key)) dropped = true
    byZ.set(key, kept)
  }
  let out = [...byZ].sort((a, b) => a[0] - b[0]) as ProfilePoint[]
  if (out.length > MAX_POINTS) {
    dropped = true
    out = simplifyTo(out, MAX_POINTS)
  }
  return out.length ? { points: out, clamped, dropped } : null
}

/**
 * The layer tops for a plate whose objects reach `topMm`: the first layer at the printer's first layer height, then
 * each layer as thick as the curve says at its bottom, inside the limits, and the last one ending on the top of the
 * plate. A last layer thinner than the minimum joins the one below it, or the two share their height evenly when one
 * layer would pass the maximum; when neither fits (right over the first layer, or a maximum under twice the minimum)
 * it is the minimum thick and ends just over the top. Tops are kept to 0.1 micron, so every layer's thickness is what
 * the engine checks it against.
 */
export function profileTops(points: readonly ProfilePoint[], topMm: number, limits: LayerLimits): number[] {
  const tops: number[] = [limits.firstMm]
  const top = round4(topMm)
  let bottom = limits.firstMm
  while (bottom < top - 1e-6 && tops.length < MAX_LAYERS) {
    const h = round4(Math.min(limits.maxMm, Math.max(limits.minMm, heightAt(points, bottom))))
    bottom = round4(Math.min(top, bottom + (Number.isFinite(h) ? h : limits.maxMm)))
    tops.push(bottom)
  }
  const n = tops.length
  if (n >= 2 && tops[n - 1]! - tops[n - 2]! < limits.minMm - 1e-6) {
    const below = n > 2 ? tops[n - 3]! : NaN
    const half = round4(below + (top - below) / 2)
    if (n > 2 && top - below <= limits.maxMm + 1e-6) tops.splice(n - 2, 1)
    else if (n > 2 && half - below >= limits.minMm - 1e-6 && top - half >= limits.minMm - 1e-6) tops[n - 2] = half
    // Right over the first layer, or where two layers cannot share it inside the limits: the last layer is the thinnest
    // the printer prints and ends a little over the top, which the engine takes (its middle decides whether it prints).
    else tops[n - 1] = round4(tops[n - 2]! + limits.minMm)
  }
  return tops
}

/**
 * A profile from layer tops (sleipnir's plan, or a project's own layers): each layer's height at its bottom, thinned to
 * at most `max` points by keeping the ones a straight line between their neighbors misses by more than `tolerance` mm.
 * The first layer is left out: it always prints at the printer's first layer height.
 */
export function profileFromTops(tops: readonly number[], max = 24, tolerance = 0.004): ProfilePoint[] {
  const pts: ProfilePoint[] = []
  for (let i = 1; i < tops.length; i++) pts.push([round4(tops[i - 1]!), round4(tops[i]! - tops[i - 1]!)])
  if (pts.length <= 2) return pts
  const keep = simplify(pts, tolerance)
  return keep.length > max ? thin(keep, max) : keep
}

/** A flat profile: one layer height from the first layer to `topMm`. */
export function flatProfile(heightMm: number, topMm: number, limits: LayerLimits): ProfilePoint[] {
  const h = round4(Math.min(limits.maxMm, Math.max(limits.minMm, heightMm)))
  return [[round4(limits.firstMm), h], [round4(Math.max(topMm, limits.firstMm + h)), h]]
}

/** The points a straight line between kept neighbors misses by more than `tolerance` (in layer height). */
function simplify(pts: readonly ProfilePoint[], tolerance: number): ProfilePoint[] {
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = true
  keep[pts.length - 1] = true
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [za, ha] = pts[a]!
    const [zb, hb] = pts[b]!
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const [z, h] = pts[i]!
      const line = zb === za ? ha : ha + ((hb - ha) * (z - za)) / (zb - za)
      const off = Math.abs(h - line)
      if (off > worst) {
        worst = off
        at = i
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = true
      stack.push([a, at], [at, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/**
 * At most `max` of the points, its ends kept: each next point is the one a straight line between the points kept so far
 * misses by the most, so steps and bends stay and points on straight runs go first.
 */
function simplifyTo(pts: readonly ProfilePoint[], max: number): ProfilePoint[] {
  if (pts.length <= max) return [...pts]
  const off = (a: number, b: number): [number, number] => {
    const [za, ha] = pts[a]!
    const [zb, hb] = pts[b]!
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const [z, h] = pts[i]!
      const d = Math.abs(h - (zb === za ? ha : ha + ((hb - ha) * (z - za)) / (zb - za)))
      if (d > worst) {
        worst = d
        at = i
      }
    }
    return [worst, at]
  }
  const keep = new Set<number>([0, pts.length - 1])
  const spans: { a: number; b: number; worst: number; at: number }[] = []
  const add = (a: number, b: number) => {
    const [worst, at] = off(a, b)
    if (at >= 0) spans.push({ a, b, worst, at })
  }
  add(0, pts.length - 1)
  while (keep.size < max && spans.length) {
    let k = 0
    for (let i = 1; i < spans.length; i++) if (spans[i]!.worst > spans[k]!.worst) k = i
    const { a, b, worst, at } = spans.splice(k, 1)[0]!
    if (worst <= 1e-6) break
    keep.add(at)
    add(a, at)
    add(at, b)
  }
  return [...keep].sort((x, y) => x - y).map((i) => pts[i]!)
}

/** `max` points spread evenly over the list, its ends kept. */
function thin(pts: readonly ProfilePoint[], max: number): ProfilePoint[] {
  if (pts.length <= max) return [...pts]
  const out: ProfilePoint[] = []
  for (let k = 0; k < max; k++) out.push(pts[Math.round((k * (pts.length - 1)) / (max - 1))]!)
  return out
}

/** The thinnest and thickest layer a profile asks for, mm. */
export function profileRange(points: readonly ProfilePoint[]): { minMm: number; maxMm: number } {
  const hs = points.map((p) => p[1])
  return { minMm: Math.min(...hs), maxMm: Math.max(...hs) }
}

/** The top of a plate's printing objects above the bed, mm (0 for none). */
export function plateTopMm(entries: readonly Pick<PlateEntry, 'parts' | 'transform' | 'printable'>[]): number {
  let top = 0
  for (const e of entries) {
    if (e.printable === false) continue
    const b = bounds(e.parts, e.transform)
    if (b && Number.isFinite(b.max[2])) top = Math.max(top, b.max[2])
  }
  return top
}

/** The layer tops a plate with its own profile slices at, with the printer's limits from the plate's resolved config. */
export function plateProfileTops(points: readonly (readonly number[])[], entries: readonly Pick<PlateEntry, 'parts' | 'transform' | 'printable'>[], config: Readonly<Record<string, unknown>>): number[] | null {
  const limits = layerLimits(config)
  const clean = cleanProfile(points, limits)
  const top = plateTopMm(entries)
  return clean && top > 0 ? profileTops(clean.points, top, limits) : null
}

/** One object of an opened project with the profile its file gives it, heights from the object's bottom. */
export interface FileObjectProfile {
  name: string
  points?: readonly (readonly number[])[]
  entry?: Pick<PlateEntry, 'parts' | 'transform'>
}

/**
 * The profile a plate takes from its objects' own (a project file keeps one per object): heights moved up by where
 * each object's bottom sits, then made safe for the printer. The tallest object's is used. Profiles that give the same
 * layer heights over the heights they share are one curve (a saved plate writes its curve cut to each object's
 * height); when they differ, `from` names the object whose profile was used. `clamped` says a height was moved into the
 * printer's limits, `dropped` that points were left out. Null when none has one.
 */
export function plateProfileFromFile(objects: readonly FileObjectProfile[], limits: Pick<LayerLimits, 'minMm' | 'maxMm'>): { points: ProfilePoint[]; clamped: boolean; dropped?: boolean; from?: string } | null {
  const withProfile = objects.flatMap((o) => {
    if (!o.points?.length) return []
    const box = o.entry ? bounds(o.entry.parts, o.entry.transform) : null
    const bottom = box && Number.isFinite(box.min[2]) ? box.min[2] : 0
    const top = box && Number.isFinite(box.max[2]) ? box.max[2] : 0
    const clean = cleanProfile(o.points.map((p) => [Number(p[0]) + bottom, Number(p[1])]), limits)
    return clean ? [{ name: o.name, top, ...clean }] : []
  })
  if (!withProfile.length) return null
  const pick = withProfile.reduce((a, b) => (b.top > a.top ? b : a))
  const same = withProfile.every((o) => o === pick || sameOverShared(o.points, pick.points))
  const dropped = withProfile.some((o) => o.dropped)
  return { points: pick.points, clamped: withProfile.some((o) => o.clamped), ...(dropped ? { dropped } : {}), ...(same ? {} : { from: pick.name }) }
}

/** Whether two curves give the same layer height, to 1 micron, everywhere over the heights both cover. */
function sameOverShared(a: readonly ProfilePoint[], b: readonly ProfilePoint[]): boolean {
  const lo = Math.max(a[0]![0], b[0]![0])
  const hi = Math.min(a[a.length - 1]![0], b[b.length - 1]![0])
  if (hi < lo) return false
  const zs = [lo, hi, ...a.map((p) => p[0]), ...b.map((p) => p[0])].filter((z) => z >= lo && z <= hi)
  return zs.every((z) => Math.abs(heightAt(a, z) - heightAt(b, z)) <= 1e-3)
}
