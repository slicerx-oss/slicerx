// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print time along the SXPV segments, so the Preview playback bar can scrub by time and
// map a time to a layer and a move within it (and back). On a printer with a tool changer,
// each change takes its own time before the first move of the new tool: the firmware's seconds
// for it (the same rule the engine uses in its estimate) plus the moves the head makes to the
// rack or chute and back, so playback shows the whole trip. The bar plays the print's whole time, the estimate's:
// it opens with the start before the first layer (heating, homing, the purge line) while the bed is empty, and
// the layers, with their tool changes, fill the rest, so its end is the same figure the estimate shows.
import { SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type PreviewBuffers } from '@slicerx/contracts'
import { ChangeClock, changePoints, changeSequence, type ToolChangerSpec } from '@slicerx/viewport'

export interface ChangeEvent {
  /** The first segment of the new tool; the change plays before it. */
  segment: number
  from: number
  to: number
  /** Print time when the change starts. */
  start: number
  duration: number
  /** The firmware's own seconds for the change (loading, switching), part of `duration`. */
  fixed: number
}

/** The estimate the timeline has to agree with: the whole print's seconds and the part of them before the first layer. */
export interface TimelineFit {
  totalS: number
  leadS: number
}

export interface Timeline {
  /** Print time in seconds, the start included. */
  total: number
  /** Seconds before the first layer starts, with nothing drawn (heating, homing, the purge line). */
  lead: number
  /** Time at the end of each layer. */
  layerEnd: Float64Array
  /** Time at the end of each segment. Inside a layer the segments share that layer's time by length over speed. */
  segEnd: Float32Array
  /** Tool changes in print order. */
  changes: ChangeEvent[]
}

export interface PlaybackPosition {
  layerHi: number
  moveCut: number
  /** Set while the time falls inside a tool change: which one and how far into it. */
  change?: { segment: number; seconds: number; fixed: number }
}

/** The fit for a finished slice's stats, or none when the slice has no estimate. */
export function fitOf(stats: { timeS: number; prepareS?: number } | null | undefined): TimelineFit | null {
  return stats && stats.timeS > 0 ? { totalS: stats.timeS, leadS: stats.prepareS ?? 0 } : null
}

const cache = new WeakMap<PreviewBuffers, { spec: ToolChangerSpec | null; fit: TimelineFit | null; tl: Timeline }>()

const sameFit = (a: TimelineFit | null, b: TimelineFit | null): boolean => (a === null || b === null ? a === b : a.totalS === b.totalS && a.leadS === b.leadS)

/**
 * `fit` is the slice's estimate. With it the timeline starts with `fit.leadS` of nothing drawn and ends at
 * `fit.totalS`: the layers' seconds are scaled by the little that is left over (the tool changes that the
 * simulation adds on top, and rounding), which is 1 when the preview carries the estimate's own layer times.
 */
export function buildTimeline(p: PreviewBuffers, changer: ToolChangerSpec | null = null, fit: TimelineFit | null = null): Timeline {
  const hit = cache.get(p)
  if (hit && hit.spec === changer && sameFit(hit.fit, fit)) return hit.tl
  const view = new DataView(p.raw, p.segmentsOffset, p.segmentCount * SXPV_SEGMENT_BYTES)
  const seg = new Float32Array(p.raw, p.segmentsOffset, p.segmentCount * (SXPV_SEGMENT_BYTES / 4))
  const layerEnd = new Float64Array(p.layerCount)
  const segEnd = new Float32Array(p.segmentCount)
  const raw = new Float64Array(p.segmentCount)
  const changes: ChangeEvent[] = []
  // Changes and their durations, before the clock runs: each needs where the head is and what the racks hold.
  const points = changer && p.toolCount > 1 ? changePoints(p) : []
  const pending = new Map<number, ChangeEvent>()
  if (changer && points.length) {
    const clock = new ChangeClock(changer, Math.max(1, ...changer.extruderOf) + 1)
    clock.change(view.getUint8(SXPV_SEGMENT.tool))
    const history: [number, number][] = []
    for (const c of points) {
      const fixed = clock.change(c.to)
      const q = (c.segment - 1) * 8
      const r = c.segment * 8
      const at: [number, number, number] = [seg[q + 2] ?? 0, seg[q + 3] ?? 0, seg[q + 4] ?? 0]
      const resume: [number, number, number] = [seg[r] ?? 0, seg[r + 1] ?? 0, seg[r + 4] ?? 0]
      const duration = changeSequence(changer, c.from, c.to, at, resume, fixed, history).duration
      history.push([c.from, c.to])
      pending.set(c.segment, { segment: c.segment, from: c.from, to: c.to, start: 0, duration, fixed })
    }
  }
  const lead = fit && fit.leadS > 0 ? fit.leadS : 0
  let motion = 0
  for (let l = 0; l < p.layerCount; l++) motion += Math.max(0, p.layerTimeS[l] ?? 0)
  const changing = [...pending.values()].reduce((a, c) => a + c.duration, 0)
  const room = fit ? fit.totalS - lead - changing : 0
  // Fits only when the estimate has room for the layers; otherwise the preview plays its own times.
  const scale = fit && motion > 0 && room > 0 ? room / motion : 1
  const start = fit && motion > 0 && room > 0 ? lead : 0
  let clock = start
  for (let l = 0; l < p.layerCount; l++) {
    const a = p.layerStart[l] ?? 0
    const b = p.layerStart[l + 1] ?? a
    let sum = 0
    for (let i = a; i < b; i++) {
      const o = i * SXPV_SEGMENT_BYTES
      const dx = view.getFloat32(o + SXPV_SEGMENT.x1, true) - view.getFloat32(o + SXPV_SEGMENT.x0, true)
      const dy = view.getFloat32(o + SXPV_SEGMENT.y1, true) - view.getFloat32(o + SXPV_SEGMENT.y0, true)
      const speed = Math.max(1, view.getUint16(o + SXPV_SEGMENT.speedDeciMmS, true)) / 10
      const t = Math.hypot(dx, dy) / speed
      raw[i] = t
      sum += t
    }
    const dur = Math.max(0, p.layerTimeS[l] ?? 0) * scale
    let acc = 0
    for (let i = a; i < b; i++) {
      const c = pending.get(i)
      if (c) {
        c.start = clock + acc
        changes.push(c)
        acc += c.duration
      }
      acc += sum > 0 ? ((raw[i] ?? 0) / sum) * dur : dur / Math.max(1, b - a)
      segEnd[i] = clock + acc
    }
    clock += acc
    layerEnd[l] = clock
  }
  const tl = { total: clock, lead: start, layerEnd, segEnd, changes }
  cache.set(p, { spec: changer, fit, tl })
  return tl
}

/**
 * Print time at the drawn moves: `layerHi` is 1 based, `moveCut` the share of the top layer's moves drawn. A
 * fractional move count is part of the way along that move, at its own pace, so this inverts `positionAt`.
 */
export function timeAt(tl: Timeline, p: PreviewBuffers, layerHi: number, moveCut: number): number {
  const top = Math.min(Math.max(layerHi, 0), p.layerCount)
  if (top < 1) return 0
  const prev = top > 1 ? (tl.layerEnd[top - 2] ?? 0) : tl.lead
  if (moveCut >= 1) return tl.layerEnd[top - 1] ?? tl.total
  const a = p.layerStart[top - 1] ?? 0
  const b = p.layerStart[top] ?? a
  const x = (b - a) * Math.max(0, moveCut)
  const n = Math.floor(x + 1e-9)
  const done = n <= 0 ? prev : (tl.segEnd[a + n - 1] ?? prev)
  const f = x - n
  if (f < 1e-9 || a + n >= b) return done
  return segmentStartTime(tl, a + n, done) + f * ((tl.segEnd[a + n] ?? done) - segmentStartTime(tl, a + n, done))
}

/** When segment `s` starts drawing: after the move before it (`before`) and any tool change that precedes it. */
function segmentStartTime(tl: Timeline, s: number, before: number): number {
  const c = tl.changes.length ? changeBefore(tl, s) : undefined
  return c ? c.start + c.duration : before
}

/** The change that plays before `segment`, if any. */
export function changeBefore(tl: Timeline, segment: number): ChangeEvent | undefined {
  let lo = 0
  let hi = tl.changes.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = tl.changes[mid]!
    if (c.segment === segment) return c
    if (c.segment < segment) lo = mid + 1
    else hi = mid - 1
  }
  return undefined
}

/** The layer (1 based) and move share that reach print time `t`, and the tool change in progress there. */
export function positionAt(tl: Timeline, p: PreviewBuffers, t: number): PlaybackPosition {
  const n = p.layerCount
  if (n === 0) return { layerHi: 0, moveCut: 1 }
  if (t >= tl.total) return { layerHi: n, moveCut: 1 }
  // Before the first layer starts the bed is empty.
  if (t < tl.lead) return { layerHi: 1, moveCut: 0 }
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((tl.layerEnd[mid] ?? 0) >= t) hi = mid
    else lo = mid + 1
  }
  const a = p.layerStart[lo] ?? 0
  const b = p.layerStart[lo + 1] ?? a
  if (b <= a) return { layerHi: lo + 1, moveCut: 1 }
  let s = a
  let e = b - 1
  while (s < e) {
    const mid = (s + e) >> 1
    if ((tl.segEnd[mid] ?? 0) >= t) e = mid
    else s = mid + 1
  }
  const c = tl.changes.length ? changeBefore(tl, s) : undefined
  if (c && t < c.start + c.duration) {
    // The head is on its way: the moves before the change are drawn, the change plays at its own clock.
    return { layerHi: lo + 1, moveCut: (s - a) / (b - a), change: { segment: s, seconds: Math.max(0, t - c.start), fixed: c.fixed } }
  }
  // Part of the way along move `s`, at its own pace, so the head and the bead advance every frame rather than
  // one whole move at a time.
  const start = segmentStartTime(tl, s, s > a ? (tl.segEnd[s - 1] ?? 0) : lo > 0 ? (tl.layerEnd[lo - 1] ?? 0) : tl.lead)
  const end = tl.segEnd[s] ?? start
  const f = end > start ? Math.min(1, Math.max(0, (t - start) / (end - start))) : 1
  return { layerHi: lo + 1, moveCut: f >= 1 ? (s - a + 1) / (b - a) : (s - a + f) / (b - a) }
}

/**
 * The share of the Time slider's track the tool changes get together when, by their own time, they would be
 * slivers: a 35 s change in a 3 hour print would be 2 px of track, too narrow to drag through. With this the
 * track runs faster over printing and slower over changes, so a drag can play a change in slow motion; the
 * mapping is continuous and monotonic, and the time readout stays the print's own.
 */
export const CHANGE_SHARE = 0.15

interface SliderScale {
  /** Track per print second inside a change, and outside. */
  a: number
  b: number
  starts: number[]
  durations: number[]
  /** Track position where each change starts. */
  vStarts: number[]
}

const scales = new WeakMap<Timeline, SliderScale>()

function sliderScale(tl: Timeline): SliderScale {
  const hit = scales.get(tl)
  if (hit) return hit
  const starts = tl.changes.map((c) => c.start)
  const durations = tl.changes.map((c) => c.duration)
  const D = durations.reduce((s, d) => s + d, 0)
  const T = tl.total
  const warp = D > 0 && T > D && D < CHANGE_SHARE * T
  const a = warp ? (CHANGE_SHARE * T) / D : 1
  const b = warp ? ((1 - CHANGE_SHARE) * T) / (T - D) : 1
  const vStarts: number[] = []
  let before = 0
  for (let i = 0; i < starts.length; i++) {
    vStarts.push(b * ((starts[i] ?? 0) - before) + a * before)
    before += durations[i] ?? 0
  }
  const s = { a, b, starts, durations, vStarts }
  scales.set(tl, s)
  return s
}

/** The last index whose value is at or below `x` in an ascending list, or -1. */
function lastAtOrBelow(list: readonly number[], x: number): number {
  let lo = 0
  let hi = list.length - 1
  let out = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((list[mid] ?? 0) <= x) {
      out = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return out
}

/** Where print time `t` sits on the Time slider's track (0 to `tl.total`). */
export function sliderOf(tl: Timeline, t: number): number {
  const s = sliderScale(tl)
  const x = Math.min(Math.max(t, 0), tl.total)
  const i = lastAtOrBelow(s.starts, x)
  if (i < 0) return s.b * x
  const start = s.starts[i] ?? 0
  const d = s.durations[i] ?? 0
  const vStart = s.vStarts[i] ?? 0
  return x < start + d ? vStart + s.a * (x - start) : vStart + s.a * d + s.b * (x - start - d)
}

/** The print time at track position `v` of the Time slider; the inverse of `sliderOf`. */
export function timeOfSlider(tl: Timeline, v: number): number {
  const s = sliderScale(tl)
  const x = Math.min(Math.max(v, 0), tl.total)
  const i = lastAtOrBelow(s.vStarts, x)
  if (i < 0) return x / s.b
  const start = s.starts[i] ?? 0
  const d = s.durations[i] ?? 0
  const vStart = s.vStarts[i] ?? 0
  const vEnd = vStart + s.a * d
  return Math.min(tl.total, x <= vEnd ? start + (x - vStart) / s.a : start + d + (x - vEnd) / s.b)
}

/**
 * The Moves slider of one layer: every move is one step of track, and a tool change inside the layer gets the
 * track its time is worth at the layer's own pace (its seconds over the layer's average seconds per move), so
 * dragging the Moves slider through a change plays it as the time slider would, and a layer whose head spends
 * most of its time changing tools gives most of its track to the change.
 */
interface MovesTrack {
  a: number
  n: number
  width: number
  changes: { at: number; c: ChangeEvent; w: number }[]
}

function movesTrack(tl: Timeline, p: PreviewBuffers, layerHi: number): MovesTrack | null {
  const l = Math.min(Math.max(layerHi, 1), p.layerCount) - 1
  if (l < 0) return null
  const a = p.layerStart[l] ?? 0
  const b = p.layerStart[l + 1] ?? a
  const n = b - a
  if (n <= 0) return null
  const inLayer = tl.changes.filter((c) => c.segment >= a && c.segment < b)
  if (!inLayer.length) return { a, n, width: n, changes: [] }
  const span = (tl.layerEnd[l] ?? 0) - (l > 0 ? (tl.layerEnd[l - 1] ?? 0) : tl.lead)
  const printing = span - inLayer.reduce((s, c) => s + c.duration, 0)
  const perMove = printing > 1e-6 ? printing / n : 1
  const changes = inLayer.map((c) => ({ at: c.segment - a, c, w: c.duration / perMove }))
  return { a, n, width: n + changes.reduce((s, x) => s + x.w, 0), changes }
}

/** Where the Moves slider stands (0 to 1) for the top layer drawn to `moveCut`, or inside `change`. */
export function movesOf(tl: Timeline, p: PreviewBuffers, layerHi: number, moveCut: number, change: { segment: number; seconds: number } | null = null): number {
  const m = movesTrack(tl, p, layerHi)
  if (!m) return moveCut
  if (!m.changes.length) return Math.min(1, Math.max(0, moveCut))
  let before = 0
  for (const x of m.changes) {
    if (change && change.segment === x.c.segment) return (x.at + before + (x.w * Math.min(Math.max(change.seconds, 0), x.c.duration)) / x.c.duration) / m.width
    before += x.w
  }
  const moves = Math.min(1, Math.max(0, moveCut)) * m.n
  const done = m.changes.filter((x) => x.at < moves - 1e-9).reduce((s, x) => s + x.w, 0)
  return (moves + done) / m.width
}

/** The top layer's drawn share and the change in progress at Moves slider position `u` (0 to 1); the inverse of `movesOf`. */
export function movesAt(tl: Timeline, p: PreviewBuffers, layerHi: number, u: number): { moveCut: number; change?: { segment: number; seconds: number; fixed: number } } {
  const m = movesTrack(tl, p, layerHi)
  const v = Math.min(1, Math.max(0, u))
  if (!m || !m.changes.length) return { moveCut: v }
  const x = v * m.width
  let cursor = 0
  let drawn = 0
  for (const ch of m.changes) {
    const gap = ch.at - drawn
    if (x <= cursor + gap) return { moveCut: (drawn + (x - cursor)) / m.n }
    cursor += gap
    drawn = ch.at
    if (x < cursor + ch.w) return { moveCut: ch.at / m.n, change: { segment: ch.c.segment, seconds: ((x - cursor) / ch.w) * ch.c.duration, fixed: ch.c.fixed } }
    cursor += ch.w
  }
  return { moveCut: Math.min(1, (drawn + (x - cursor)) / m.n) }
}

/** 1:05:09 for long prints, 4:09 for short ones. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  const two = (v: number) => String(v).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}
