// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's section edit: a follow-up reshapes a lofted body (a car body, a fuselage, a bottle) by its
// sections, its stations along the run, rather than building it again. One station gets wider, taller or moved; a
// station is added between two or taken out; the top or bottom line rises toward the ends; an end leans out (rake,
// overhang); the whole body gets more curve or a flatter bottom. Every edit is a change to the loft's own sections, so
// the steps after it replay with it on either engine. The names are generic (front, back, top line, widest, bottom),
// with the words of cars, bottles and other bodies as aliases in shape-words.json.
import { BED_FRAME, direction, type FaceFrame, type LoftProfile, type SketchLoop, type Step, type StepParams, type Vec2, type Vec3 } from '@slicerx/cad-history'
import shapeWords from './shape-words.json'

type Loft = Extract<StepParams, { op: 'sketch.loft' }>
type V = Vec3

const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k]
const unit = (a: V): V => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1))
const r1 = (n: number): number => Math.round(n * 10) / 10
const DEG = Math.PI / 180
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** A section's plane as the engine reads it: u squared to the normal, v the normal across u (the v given is not read). */
function planeOf(f: FaceFrame): FaceFrame {
  const n = unit(f.normal)
  const u = unit(sub(f.u, mul(n, dot(f.u, n))))
  return { ...f, normal: n, u, v: cross(n, u) }
}

/** The section edit as design.edit_step takes it. Sizes in mm; scale, curve and the By fields are factors. */
export interface SectionEdit {
  front?: 'high' | 'low' | undefined
  station?: number | string | undefined
  width?: number | undefined
  height?: number | undefined
  scale?: number | { width?: number | undefined; height?: number | undefined } | undefined
  at?: number | undefined
  out?: number | undefined
  outBy?: number | undefined
  add?: number | undefined
  remove?: number | string | undefined
  curve?: number | undefined
  line?: { which: string; front?: number | undefined; back?: number | undefined; frontBy?: number | undefined; backBy?: number | undefined } | undefined
  end?: { which: string; lean?: number | undefined; leanBy?: number | undefined; overhang?: number | undefined } | undefined
  flatten?: number | undefined
}

export const SHAPE_WORDS = shapeWords

/** A name a person uses for a station or a line, as its generic name ('front', 'back', 'top line', 'bottom', ...). */
export function genericName(word: string): string {
  const w = word.trim().toLowerCase()
  for (const [name, aliases] of Object.entries(shapeWords.names)) if (w === name || (aliases as string[]).includes(w)) return name
  return w
}

/** Every point of a loop, or null when it has a curve (an arc, a circle, a spline) the sections cannot be reshaped by. */
function loopPoints(l: SketchLoop): Vec2[] | null {
  if ('points' in l) return l.points
  if ('segments' in l) return l.segments.every((g) => g.type === 'line') ? [l.start, ...l.segments.map((g) => (g as { to: Vec2 }).to)] : null
  return null
}

function mapLoop(l: SketchLoop, f: (p: Vec2) => Vec2): SketchLoop {
  if ('points' in l) return { ...l, points: l.points.map(f) }
  if ('segments' in l) return { ...l, start: f(l.start), segments: l.segments.map((g) => ({ ...g, to: f((g as { to: Vec2 }).to) })) as typeof l.segments }
  return l
}

/** A section as read along the body: where it stands, its width across and its height (or depth) up, in mm. */
interface Station {
  /** The profile's index in the step. */
  i: number
  /** Its place along the run, mm. */
  t: number
  frame: FaceFrame
  /** In-plane unit directions across and up, in the section's u v. */
  across: Vec2
  up: Vec2
  lo: [number, number]
  hi: [number, number]
}

/** How the body lies: its run, whether it stands up (a bottle), its stations from front to back, and the front's place. */
export interface Body {
  run: V
  upright: boolean
  up: V
  stations: Station[]
  /** The axis the run goes along, as a word ('x', 'y', 'z') when it is one, for the read-back, and which way. */
  axisWord: string
  axisSign: number
}

const NO_POINTS = 'its sections have arcs, circles or splines; a section edit moves the points of a section, so draw them as points (geom.loft again) or change it with size'

/** The body a loft step makes, read from its sections; or why a section edit cannot work on it. */
export function bodyOf(s: Step, front?: 'high' | 'low'): Body | string {
  const p = s.params
  if (p.op !== 'sketch.loft') return 'section: only a loft is edited by its sections'
  if (p.profiles.length < 2) return 'section: the loft has one section'
  const frames = p.profiles.map((q) => planeOf(q.frame ?? BED_FRAME))
  // the ends may lean (a raked end), so with three or more sections the run is what the ones between share
  const inner = frames.length > 2 ? frames.slice(1, -1) : frames
  let run: V = [0, 0, 0]
  for (const f of inner) run = add(run, mul(f.normal, dot(f.normal, inner[0]!.normal) < 0 ? -1 : 1))
  run = unit(run)
  if (frames.some((f) => Math.abs(dot(f.normal, run)) < 0.2)) return 'section: its sections do not stand along one run; edit it with geom.loft again'
  const zUp = direction(s.transform, [0, 0, 1])
  const upright = Math.abs(dot(run, zUp)) > 0.8
  const stations: Station[] = []
  for (const [i, q] of p.profiles.entries()) {
    const f = frames[i]!
    let up: Vec2
    if (upright) up = [0, 1]
    else {
      const a = dot(f.u, zUp)
      const b = dot(f.v, zUp)
      const n = Math.hypot(a, b)
      if (n < 0.5) return 'section: a section lies flat; edit it with geom.loft again'
      up = [a / n, b / n]
    }
    const across: Vec2 = upright ? [1, 0] : [up[1], -up[0]]
    const pts = q.loops.flatMap((l) => loopPoints(l) ?? [[NaN, NaN] as Vec2])
    if (pts.some(([x]) => Number.isNaN(x))) return `section: ${NO_POINTS}`
    const lo: [number, number] = [Infinity, Infinity]
    const hi: [number, number] = [-Infinity, -Infinity]
    for (const [x, y] of pts) {
      const a = x * across[0] + y * across[1]
      const b = x * up[0] + y * up[1]
      lo[0] = Math.min(lo[0], a)
      hi[0] = Math.max(hi[0], a)
      lo[1] = Math.min(lo[1], b)
      hi[1] = Math.max(hi[1], b)
    }
    stations.push({ i, t: dot(f.origin, run), frame: f, across, up, lo, hi })
  }
  stations.sort((a, b) => a.t - b.t)
  for (let k = 1; k < stations.length; k++) if (stations[k]!.t - stations[k - 1]!.t < 1e-6) return 'section: two sections stand at one place along the run'
  // the front: asked, else the top of a standing body, else the end with the smaller section (a nose), else the
  // high end of the run
  const area = (x: Station) => (x.hi[0] - x.lo[0]) * (x.hi[1] - x.lo[1])
  const lowEnd = stations[0]!
  const highEnd = stations[stations.length - 1]!
  const highIsFront = front ? front === 'high' : upright ? dot(run, zUp) > 0 : area(highEnd) < area(lowEnd) * 0.85 ? true : area(lowEnd) < area(highEnd) * 0.85 ? false : true
  if (highIsFront) stations.reverse()
  const axes: [V, string][] = [[[1, 0, 0], 'x'], [[0, 1, 0], 'y'], [[0, 0, 1], 'z']]
  const along = axes.find(([a]) => Math.abs(dot(direction(s.transform, a), run)) > 0.999)
  const axisSign = along ? Math.sign(dot(direction(s.transform, along[0]), run)) : 1
  return { run, upright, up: zUp, stations, axisWord: along?.[1] ?? 'the run', axisSign }
}

const width = (x: Station) => x.hi[0] - x.lo[0]
const height = (x: Station) => x.hi[1] - x.lo[1]

/** The stations front to back as the read-back gives them: number, place along the run, width and height. */
export function stationRows(b: Body): { station: number; at: number; width: number; height: number; name?: string }[] {
  const widest = b.stations.reduce((m, x, k) => (width(x) > width(b.stations[m]!) ? k : m), 0)
  return b.stations.map((x, k) => {
    const name = k === 0 ? 'front' : k === b.stations.length - 1 ? 'back' : k === widest ? 'widest' : undefined
    return { station: k + 1, at: r1(x.t * b.axisSign) || 0, width: r1(width(x)), height: r1(height(x)), ...(name ? { name } : {}) }
  })
}

/** Which stations a name or number picks (by their place front to back), or why none. */
function pick(b: Body, which: number | string): number[] | string {
  const n = b.stations.length
  if (typeof which === 'number' || /^\d+$/.test(String(which).trim())) {
    const k = Number(which) - 1
    return k >= 0 && k < n ? [k] : `the body has ${n} stations, 1 (front) to ${n} (back)`
  }
  const w = genericName(String(which))
  if (w === 'all') return b.stations.map((_, k) => k)
  if (w === 'front') return [0]
  if (w === 'back') return [n - 1]
  if (w === 'middle') return [Math.floor((n - 1) / 2)]
  const widest = b.stations.reduce((m, x, k) => (width(x) > width(b.stations[m]!) ? k : m), 0)
  if (w === 'widest') return [widest]
  if (w === 'shoulder') return widest > 0 ? [widest - 1] : 'the widest station is the front one, so the body has no shoulder ahead of it'
  return `"${which}" is no station: give a number from 1 (front) to ${n}, or front, back, middle, widest, shoulder or all`
}

/** A section's points moved by f(across, up) in its own across/up reading. */
function reshape(q: LoftProfile, x: Station, f: (a: number, b: number) => [number, number]): LoftProfile {
  const { across: c, up: u } = x
  return {
    ...q,
    loops: q.loops.map((l) =>
      mapLoop(l, ([px, py]) => {
        const [a, b] = f(px * c[0] + py * c[1], px * u[0] + py * u[1])
        return [a * c[0] + b * u[0], a * c[1] + b * u[1]]
      }),
    ),
  }
}

/** A section scaled across about its middle and up from its bottom (about its middle for a standing body). */
function scaled(q: LoftProfile, x: Station, kw: number, kh: number, upright: boolean): LoftProfile {
  const mid = (x.lo[0] + x.hi[0]) / 2
  const base = upright ? (x.lo[1] + x.hi[1]) / 2 : x.lo[1]
  return reshape(q, x, (a, b) => [mid + (a - mid) * kw, base + (b - base) * kh])
}

/** Points resampled to `n` along the loop's length, for two sections of different point counts to blend. */
function resample(pts: Vec2[], n: number): Vec2[] {
  if (pts.length === n) return pts
  const len = [0]
  for (let k = 1; k < pts.length; k++) len.push(len[k - 1]! + Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]))
  const total = len[len.length - 1]!
  const out: Vec2[] = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const at = (total * k) / (n - 1)
    while (j < pts.length - 2 && len[j + 1]! < at) j++
    const span = len[j + 1]! - len[j]! || 1
    const f = (at - len[j]!) / span
    out.push([pts[j]![0] + (pts[j + 1]![0] - pts[j]![0]) * f, pts[j]![1] + (pts[j + 1]![1] - pts[j]![1]) * f])
  }
  return out
}

/** Turns vector `x` in the plane of `up` and `out` so `up` leans toward `out` by `th` radians. */
function lean(x: V, up: V, out: V, th: number): V {
  const a = dot(x, up)
  const b = dot(x, out)
  const rest = sub(x, add(mul(up, a), mul(out, b)))
  return add(rest, add(mul(add(mul(up, Math.cos(th)), mul(out, Math.sin(th))), a), mul(sub(mul(out, Math.cos(th)), mul(up, Math.sin(th))), b)))
}

/** What an end leans now: degrees its top reaches out past its bottom, from upright. */
function leanOf(f: FaceFrame, up: V, out: V): number {
  const n = dot(f.normal, out) < 0 ? mul(f.normal, -1) : f.normal
  return Math.atan2(-dot(n, up), dot(n, out)) / DEG
}

/** The loft with the section edit made, and what changed in words; or why it cannot be. */
export function sectionEdited(s: Step, e: SectionEdit): { params: Loft; said: string[]; lean?: { which: 'front' | 'back'; from: number; to: number } } | string {
  const b0 = bodyOf(s, e.front)
  if (typeof b0 === 'string') return b0
  let p = s.params as Loft
  let b = b0
  const said: string[] = []
  const set = (k: number, q: LoftProfile) => {
    p = { ...p, profiles: p.profiles.map((x, j) => (j === b.stations[k]!.i ? q : x)) }
  }
  const front = (): 'high' | 'low' => (b.stations[0]!.t > b.stations[b.stations.length - 1]!.t ? 'high' : 'low')
  const reread = (): string | null => {
    const f = front()
    const r = bodyOf({ ...s, params: p }, f)
    if (typeof r === "string") return r
    b = r
    return null
  }
  const length = Math.abs(b.stations[0]!.t - b.stations[b.stations.length - 1]!.t)
  const tallest = Math.max(...b.stations.map(height))
  const label = (k: number) => `station ${k + 1}${k === 0 ? ' (front)' : k === b.stations.length - 1 ? ' (back)' : ''}`

  // one station, or every one: wider, taller, moved along the run
  const reshapes = e.width !== undefined || e.height !== undefined || e.scale !== undefined || e.at !== undefined || e.out !== undefined || e.outBy !== undefined
  if (reshapes) {
    if (e.station === undefined) return 'section: give the station to change (a number from the front, or front, back, middle, widest, shoulder or all)'
    const ks = pick(b, e.station)
    if (typeof ks === 'string') return `section.station: ${ks}`
    if (ks.length > 1 && (e.at !== undefined || e.out !== undefined || e.outBy !== undefined)) return 'section: move one station at a time; to make the whole body longer, use size along its run'
    for (const k of ks) {
      const x = b.stations[k]!
      const sc = typeof e.scale === 'number' ? { width: e.scale, height: e.scale } : (e.scale ?? {})
      const kw = e.width !== undefined ? e.width / width(x) : (sc.width ?? 1)
      const kh = e.height !== undefined ? e.height / height(x) : (sc.height ?? 1)
      if (!(kw > 0.05 && kw < 20 && kh > 0.05 && kh < 20)) return 'section: that would squash or blow up the section; keep each size between a twentieth and twenty times what it is'
      if (kw !== 1 || kh !== 1) {
        set(k, scaled(p.profiles[x.i]!, x, kw, kh, b.upright))
        const parts = [kw !== 1 ? `${r1(width(x))} to ${r1(width(x) * kw)} mm wide` : '', kh !== 1 ? `${r1(height(x))} to ${r1(height(x) * kh)} mm ${b.upright ? 'deep' : 'tall'}` : ''].filter(Boolean)
        if (ks.length === 1) said.push(`${label(k)} ${parts.join(', ')}`)
      }
      const outward = Math.sign(x.t - (b.stations[0]!.t + b.stations[b.stations.length - 1]!.t) / 2) || Math.sign(b.stations[0]!.t - b.stations[b.stations.length - 1]!.t)
      const to = e.at !== undefined ? e.at * b.axisSign : e.out !== undefined ? x.t + outward * e.out : e.outBy !== undefined ? x.t + outward * e.outBy * length : undefined
      if (to !== undefined && ks.length === 1) {
        const before = b.stations[k - 1]
        const after = b.stations[k + 1]
        const between = (v: number, a?: Station, c?: Station) => (!a || (v - a.t) * (x.t - a.t) > 0) && (!c || (v - c.t) * (x.t - c.t) > 0)
        if (!between(to, before, after)) return `section: station ${k + 1} would pass the station next to it; give a place between them, or remove that one first`
        const f = x.frame
        set(k, { ...p.profiles[x.i]!, frame: { ...f, origin: add(f.origin, mul(b.run, to - x.t)) } })
        said.push(`${label(k)} moved ${r1(Math.abs(to - x.t))} mm ${(to - x.t) * outward > 0 ? 'out' : 'in'} along ${b.axisWord}`)
      }
    }
    if (ks.length > 1 && (e.scale !== undefined || e.width !== undefined || e.height !== undefined)) {
      const sc = typeof e.scale === 'number' ? { width: e.scale, height: e.scale } : (e.scale ?? {})
      said.push(`every station ${[sc.width && sc.width !== 1 ? `${Math.round(sc.width * 100)}% as wide` : '', sc.height && sc.height !== 1 ? `${Math.round(sc.height * 100)}% as ${b.upright ? 'deep' : 'tall'}` : ''].filter(Boolean).join(' and ') || 'resized'}`)
    }
    const r = reread()
    if (r) return r
  }

  if (e.add !== undefined) {
    const at = e.add * b.axisSign
    const k = b.stations.findIndex((x, j) => j > 0 && (at - x.t) * (at - b.stations[j - 1]!.t) < 0)
    if (k < 0) return `section.add: ${r1(e.add)} is not between two stations along ${b.axisWord}; to make the body longer, move an end station with out`
    const a = b.stations[k - 1]!
    const c = b.stations[k]!
    if (Math.abs(a.i - c.i) !== 1) return 'section.add: the sections are not kept in order along the run'
    const qa = p.profiles[a.i]!
    const qc = p.profiles[c.i]!
    if (qa.loops.length !== qc.loops.length) return 'section.add: the two sections around that place have different loops'
    if (Math.abs(dot(a.frame.u, c.frame.u)) < 0.999 || Math.abs(dot(a.frame.v, c.frame.v)) < 0.999) return 'section.add: the two sections around that place are turned differently; add it nearer the middle'
    const f = (at - a.t) / (c.t - a.t)
    const loops: SketchLoop[] = qa.loops.map((la, j) => {
      const pa = loopPoints(la)!
      const pc = loopPoints(qc.loops[j]!)!
      const n = Math.max(pa.length, pc.length)
      const ra = resample(pa, n)
      const rc = resample(pc, n).map(([x, y]) => [x * dot(c.frame.u, a.frame.u), y * dot(c.frame.v, a.frame.v)] as Vec2)
      return { points: ra.map(([x, y], m) => [x + (rc[m]![0] - x) * f, y + (rc[m]![1] - y) * f] as Vec2) } as SketchLoop
    })
    const origin = add(a.frame.origin, mul(sub(c.frame.origin, a.frame.origin), f))
    const q: LoftProfile = { ...qa, frame: { ...a.frame, origin }, loops }
    const idx = Math.max(a.i, c.i)
    p = { ...p, profiles: [...p.profiles.slice(0, idx), q, ...p.profiles.slice(idx)] }
    const r = reread()
    if (r) return r
    said.push(`a station added at ${b.axisWord} ${r1(e.add)}, between the two around it; it is station ${k + 1} of ${b.stations.length}`)
  }

  if (e.remove !== undefined) {
    const ks = pick(b, e.remove)
    if (typeof ks === 'string') return `section.remove: ${ks}`
    if (ks.length !== 1) return 'section.remove: take out one station at a time'
    if (b.stations.length < 3) return 'section.remove: a loft needs two sections; this one has two'
    const k = ks[0]!
    const gone = b.stations[k]!.i
    p = { ...p, profiles: p.profiles.filter((_, j) => j !== gone) }
    said.push(`${label(k)} taken out${k === 0 || k === b.stations.length - 1 ? '; the body now ends at the next one' : ''}`)
    const r = reread()
    if (r) return r
  }

  if (e.curve !== undefined) {
    const c = e.curve
    const wmax = Math.max(...b.stations.map(width))
    for (const [k, x] of b.stations.entries()) {
      const w = width(x)
      const to = Math.max(wmax - (wmax - w) * c, w * 0.1, 0.4)
      if (Math.abs(to - w) > 1e-6) set(k, scaled(p.profiles[x.i]!, x, to / w, 1, b.upright))
    }
    said.push(c > 1 ? `more curve: the stations away from the widest drawn in by ${Math.round((c - 1) * 100)}% of how far they were in` : `less curve: the stations away from the widest let out toward it`)
    const r = reread()
    if (r) return r
  }

  if (e.line !== undefined) {
    if (b.upright) return 'section.line: a standing body has no top or bottom line along its run; change its stations instead'
    const which = genericName(e.line.which)
    if (which !== 'top line' && which !== 'top' && which !== 'bottom') return `section.line: "${e.line.which}" is no line; give top (roofline, spine) or bottom (belly, underside)`
    const top = which !== 'bottom'
    const rf = e.line.front ?? (e.line.frontBy ?? 0) * tallest
    const rb = e.line.back ?? (e.line.backBy ?? 0) * tallest
    const tf = b.stations[0]!.t
    const tb = b.stations[b.stations.length - 1]!.t
    const tm = (tf + tb) / 2
    for (const [k, x] of b.stations.entries()) {
      const toFront = (x.t - tm) / (tf - tm)
      const rise = toFront > 0 ? rf * toFront * toFront : rb * toFront * toFront
      if (Math.abs(rise) < 1e-6) continue
      const h = height(x)
      set(k, reshape(p.profiles[x.i]!, x, (a, v) => [a, v + rise * (top ? (v - x.lo[1]) / h : (x.hi[1] - v) / h)]))
    }
    said.push(`the ${top ? 'top line' : 'bottom'} ${[rf ? `${rf > 0 ? 'rises' : 'drops'} ${r1(Math.abs(rf))} mm at the front` : '', rb ? `${rb > 0 ? 'rises' : 'drops'} ${r1(Math.abs(rb))} mm at the back` : ''].filter(Boolean).join(' and ')}, eased toward the middle`)
    const r = reread()
    if (r) return r
  }

  let leaned: { which: 'front' | 'back'; from: number; to: number } | undefined
  if (e.end !== undefined) {
    if (b.upright) return 'section.end: the ends of a standing body are its top and base; change those stations instead'
    const which = genericName(e.end.which)
    if (which !== 'front' && which !== 'back') return `section.end: "${e.end.which}" is no end; give front (nose, tip) or back (tail, base)`
    const k = which === 'front' ? 0 : b.stations.length - 1
    const x = b.stations[k]!
    const other = b.stations[which === 'front' ? 1 : b.stations.length - 2]!
    const out = unit(mul(b.run, Math.sign(x.t - other.t)))
    const up = unit(sub(b.up, mul(out, dot(b.up, out))))
    const from = leanOf(x.frame, up, out)
    const h = height(x)
    const to = e.end.overhang !== undefined ? Math.atan2(e.end.overhang, h) / DEG : e.end.lean !== undefined ? e.end.lean : from + (e.end.leanBy ?? 0)
    if (!(to > -60 && to < 75)) return 'section.end: lean an end between 60 degrees in and 75 degrees out'
    const th = (to - from) * DEG
    const f = x.frame
    // the end turns about its bottom, across the body: its foot stays put, its top reaches out
    const foot = add(f.origin, mul(up, Math.min(...p.profiles[x.i]!.loops.flatMap((l) => loopPoints(l)!).map(([px, py]) => dot(add(mul(f.u, px), mul(f.v, py)), up)))))
    const turn = (v: V) => lean(v, up, out, th)
    const frame: FaceFrame = { ...f, origin: add(foot, turn(sub(f.origin, foot))), u: turn(f.u), v: turn(f.v), normal: turn(f.normal) }
    set(k, { ...p.profiles[x.i]!, frame })
    said.push(`the ${which} leans ${r1(to)} degrees out (was ${r1(from)}), its top reaching ${r1(Math.tan(to * DEG) * h)} mm past its foot`)
    leaned = { which, from, to }
  }

  if (e.flatten !== undefined) {
    if (b.upright) return 'section.flatten: the bottom of a standing body is its back station; widen that one instead'
    const k0 = Math.min(1, Math.max(0, e.flatten))
    for (const [k, x] of b.stations.entries()) {
      const h = height(x)
      set(k, reshape(p.profiles[x.i]!, x, (a, v) => {
        const f = (v - x.lo[1]) / h
        return f >= 0.5 ? [a, v] : [a, x.lo[1] + (v - x.lo[1]) * (1 - k0 * (1 - f / 0.5))]
      }))
    }
    said.push(`a flatter bottom: the lower half of every station pressed toward its bottom by ${Math.round(k0 * 100)}%`)
  }

  if (!said.length) return 'section: give what to change (a station with width, height, scale, at or out; add; remove; curve; line; end; or flatten)'
  return leaned ? { params: p, said, lean: leaned } : { params: p, said }
}
