// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loose parts: a part added beside another a hair apart (under the gap a printer keeps open, half the nozzle) prints as
// a separate piece that the slicer may still bridge or fuse, and it reads as a part floating off what it stands on. A
// step that adds a separate part seats it: when the new part is that close to another, it moves along the gap, only
// that way and by the gap and a hair more, onto the other part, as the same step. A move larger than the gap kept open,
// or one that would run the part into a third part, is not made; the answer names the part instead. design.check fails
// such gaps as loose parts. Pieces that move (a plan with print-in-place pieces or planned gaps, a part with a thread's
// clearance) keep their gaps: the fit check owns those.
import { direction, invert, replayHistory, stepName, type Design as HostDesign, type DesignHost, type HistoryMesh, type Step, type StepParams, type Vec3 } from '@slicerx/cad-history'
import { gapMm, gapWay, nozzleOr, printsTogether, type FitFacts, type FitGap, type FitLimits, type PartPlan } from './design-check'
import type { PiecePlans } from './design-tools'
import { fitFacts } from './fit-facts'
import { movedStep } from './step-reshape'
import { partBoxes } from './sunk'

/** How far a seated part goes into the part it is seated on, past the gap, mm: well under a line, so they print as one. */
export const SEAT_OVERLAP_MM = 0.05

/** The gap a printer keeps open between two parts, mm: half the nozzle, at least 0.1. */
export const keepOpenMm = (nozzleMm: unknown): number => Math.max(0.1, nozzleOr(nozzleMm) / 2)

/** The fit check's limits for loose parts: the gap kept open, each way. */
export function keepOpenLimits(nozzleMm: unknown, layerHeightMm?: number): FitLimits {
  const nozzle = nozzleOr(nozzleMm)
  const keep = keepOpenMm(nozzle)
  return { sideMm: keep, verticalMm: keep, material: 'pla', nozzleMm: nozzle, layerHeightMm: layerHeightMm && layerHeightMm > 0 ? layerHeightMm : nozzle / 2 }
}

/** True when a plan has pieces that move or print together: print-in-place pieces, or a size that is a gap. */
export function plansMoving(plan: Pick<PartPlan, 'part' | 'features' | 'assumptions' | 'printInPlace'>): boolean {
  if (Array.isArray(plan.printInPlace) && plan.printInPlace.length) return true
  if (printsTogether(plan)) return true
  return plan.features.some((f) => Object.keys(f.sizes).some((k) => gapWay(k) !== null))
}

/** Parts a thread step marks as moving (a screw and its nut, with the thread's clearance), by index. */
export function movingParts(d: HostDesign): Set<number> {
  return new Set(d.history.steps.filter((s) => !s.suppressed && s.params.op === 'thread.apply').map((s) => s.part))
}

/** True when a plan tied to the design has pieces that move. */
function designMoves(plans: PiecePlans | undefined, d: HostDesign): boolean {
  if (!plans) return false
  return plans.tiedTo(d.id).some((id) => {
    const e = plans.get(id)
    return !!e && !e.stale && !e.superseded && plansMoving(e.plan)
  })
}

/** Gaps in `fit` above 0 and under the gap kept open, between bodies of parts that do not move. */
export function looseGaps(fit: FitFacts, moving: ReadonlySet<number> = new Set()): FitGap[] {
  return fit.gaps.filter((g) => (g.kind === 'horizontal' || g.kind === 'vertical') && g.gapMm > 0 && g.bodies.every((b) => !moving.has(fit.bodies[b]?.part ?? -1)))
}

const at = (g: FitGap): string => `[${[0, 1, 2].map((k) => Math.round(((g.from[k]! + g.to[k]!) / 2) * 10) / 10).join(', ')}]`

/** A loose gap in words: "Cap and Post, 0.1 mm apart at [5, 0, 20]". */
export function looseText(fit: FitFacts, g: FitGap): string {
  const name = (b: number): string => fit.bodies[b]?.name ?? `body ${b + 1}`
  return `${name(g.bodies[0])} and ${name(g.bodies[1])}, ${gapMm(g.gapMm)} apart at ${at(g)}`
}

const r2 = (v: number): number => Math.round(v * 100) / 100

type Box = ReturnType<typeof partBoxes>[number]
const within = (a: Box, b: Box, mm: number): boolean => [0, 1, 2].every((k) => a.lo[k]! <= b.hi[k]! + mm && a.hi[k]! >= b.lo[k]! - mm)

/** Parts whose boxes come within `mm` of part `k`'s box. */
function nearParts(d: HostDesign, k: number, mm: number): number[] {
  const boxes = partBoxes(d)
  const b = boxes[k]
  if (!b) return []
  return boxes.flatMap((o, j) => (j !== k && within(o, b, mm) ? [j] : []))
}

/**
 * The parts that can hold a loose gap, by index: those whose box comes within `mm` of another part's box, leaving out
 * `moving`. Empty when no two parts come that close, so a design of one part, or of parts well apart, needs no check.
 */
export function partsNear(d: HostDesign, mm: number, moving: ReadonlySet<number> = new Set()): number[] {
  const boxes = partBoxes(d)
  return boxes.flatMap((b, k) => (!moving.has(k) && boxes.some((o, j) => j !== k && !moving.has(j) && within(o, b, mm)) ? [k] : []))
}

/** Part `k` moved by `world` mm, in the design's own frame. */
function shifted(d: HostDesign, k: number, world: Vec3): HistoryMesh[] {
  const local = direction(invert(d.transform), world)
  return d.parts.map((p, j) => (j === k ? { ...p, positions: Float32Array.from(p.positions, (v, i) => v + local[i % 3]!) } : p))
}

/** Part pairs (low index first) that touch, from a fit check. */
function touching(fit: FitFacts): Set<string> {
  const out = new Set<string>()
  for (const g of fit.gaps) {
    if (g.kind !== 'fused') continue
    const [a, b] = g.bodies.map((x) => fit.bodies[x]?.part ?? -1) as [number, number]
    if (a !== b) out.add(a < b ? `${a},${b}` : `${b},${a}`)
  }
  return out
}

const pairOf = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`)

/** What a seat look found around one part: the fit check, the parts it took in, and the loose gaps of that part. */
interface Around {
  fit: FitFacts
  only: number[]
  /** Loose gaps between a body of the part and a body of another part, closest first. */
  gaps: FitGap[]
}

/** The loose gaps between part `k` and the parts beside it, or null when none comes within the gap kept open. */
async function looseAround(host: DesignHost, d: HostDesign, k: number, limits: FitLimits, moving: ReadonlySet<number>): Promise<Around | null> {
  const near = nearParts(d, k, limits.sideMm).filter((j) => !moving.has(j))
  if (!near.length) return null
  const only = [k, ...near]
  let fit: FitFacts
  try {
    fit = await fitFacts(host, d, limits, only)
  } catch {
    return null
  }
  const partOf = (b: number): number => fit.bodies[b]?.part ?? -1
  const gaps = looseGaps(fit)
    .filter((g) => {
      const [a, b] = g.bodies.map(partOf) as [number, number]
      return a !== b && (a === k || b === k)
    })
    .sort((x, y) => x.gapMm - y.gapMm)
  return gaps.length ? { fit, only, gaps } : null
}

/** The other part of a gap of part `k`, and the unit direction from `k`'s body to it. */
function sideOf(fit: FitFacts, g: FitGap, k: number): { other: number; dir: Vec3 } {
  const mine = (fit.bodies[g.bodies[0]]?.part ?? -1) === k
  const other = fit.bodies[g.bodies[mine ? 1 : 0]]?.part ?? -1
  const [f, t] = mine ? [g.from, g.to] : [g.to, g.from]
  const v: Vec3 = [t[0]! - f[0]!, t[1]! - f[1]!, t[2]! - f[2]!]
  const len = Math.hypot(...v) || 1
  return { other, dir: [v[0] / len, v[1] / len, v[2] / len] }
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** Two gap directions agree within about 8 degrees. */
const AGREE = 0.99
const names = (d: HostDesign, ks: Iterable<number>): string => listAnd([...new Set(ks)].map((j) => d.parts[j]?.name ?? `part ${j + 1}`))
const listAnd = (xs: readonly string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** Part pairs a check finds touching part `k` that did not touch it before, other than the pairs in `allowed`. */
function newTouches(before: FitFacts, after: FitFacts, k: number, allowed: ReadonlySet<number>): number[] {
  const was = touching(before)
  return [...touching(after)].filter((p) => !was.has(p) && p.split(',').includes(String(k))).map((p) => Number(p.split(',').find((x) => x !== String(k)))).filter((j) => !allowed.has(j))
}

/** True when every part in `partners` touches part `k` in `after`, and no loose gap of `k` is left. */
function allSeated(after: FitFacts, k: number, partners: ReadonlySet<number>): boolean {
  const now = touching(after)
  if (![...partners].every((j) => now.has(pairOf(k, j)))) return false
  return !looseGaps(after).some((g) => {
    const [a, b] = g.bodies.map((x) => after.bodies[x]?.part ?? -1) as [number, number]
    return a !== b && (a === k || b === k)
  })
}

/** Replays `d` with `steps` and keeps it; false (and `d` unchanged) when the replay throws. */
async function commit(host: DesignHost, d: HostDesign, steps: Step[]): Promise<boolean> {
  const candidate = { ...d, history: { ...d.history, steps }, redo: [...d.redo] }
  try {
    await host.replay(candidate)
  } catch {
    return false
  }
  // as replayChange does: an exported file of the design before the move no longer stands
  const file = d as { stl?: unknown }
  if (!(candidate as { stl?: unknown }).stl) delete file.stl
  Object.assign(d, candidate)
  return true
}

const leftWords = (d: HostDesign, k: number, a: Around, keep: number, why: string): string => {
  const others = a.gaps.map((g) => sideOf(a.fit, g, k).other)
  const place = a.gaps.length === 1 ? `is ${gapMm(a.gaps[0]!.gapMm)} from ${names(d, others)} at ${at(a.gaps[0]!)}` : `has ${a.gaps.length} places ${gapMm(a.gaps[0]!.gapMm)} to ${gapMm(a.gaps.at(-1)!.gapMm)} from ${names(d, others)}`
  return `${d.parts[k]?.name ?? `part ${k + 1}`} ${place}, under the ${gapMm(keep)} a printer keeps open, and was left where it is: ${why}. Change the step that made it so it sits on ${names(d, others)}, or at least ${gapMm(keep)} away`
}

/**
 * Seats each new part (`added`, by index) that the last step just made: one under the gap kept open from another part
 * moves along that gap onto it, as that step, and the design replays once. Its loose gaps must all point one way, the
 * move must be within the gap kept open, and the moved part must meet every part it was loose from and run into no
 * other; else it is named and left where it is. A step that added several parts at once (separate copies) moves none of
 * them. Returns what the answer adds, or '' for none.
 */
export async function seatNew(host: DesignHost, d: HostDesign, added: readonly number[], opts: { nozzleMm?: number | undefined; layerHeightMm?: number | undefined; plans?: PiecePlans | undefined }): Promise<string> {
  if (!added.length || designMoves(opts.plans, d)) return ''
  const limits = keepOpenLimits(opts.nozzleMm, opts.layerHeightMm)
  const keep = limits.sideMm
  const moving = movingParts(d)
  const said: string[] = []
  const several: { k: number; a: Around }[] = []
  const j = d.history.steps.length - 1
  const s = d.history.steps[j]
  for (const k of added) {
    const part = d.parts[k]
    if (!part || moving.has(k)) continue
    const a = await looseAround(host, d, k, limits, moving)
    if (!a) continue
    const g = a.gaps[0]!
    const sides = a.gaps.map((x) => sideOf(a.fit, x, k))
    const partners = new Set(sides.map((x) => x.other))
    if (s?.params.op === 'parts.add' && s.params.parts.length !== 1) {
      several.push({ k, a })
      continue
    }
    if (sides.some((x) => dot3(x.dir, sides[0]!.dir) < AGREE)) {
      said.push(leftWords(d, k, a, keep, 'its gaps point different ways, so no one move seats it'))
      continue
    }
    const dist = g.gapMm + SEAT_OVERLAP_MM
    if (dist > keep + 1e-9) {
      said.push(leftWords(d, k, a, keep, `seating it would move it ${gapMm(r2(dist))}, more than that gap`))
      continue
    }
    const u = sides[0]!.dir
    const world: Vec3 = [u[0] * dist, u[1] * dist, u[2] * dist]
    const params = s ? movedStep(s, world, d.transform) : 'no step made it'
    if (typeof params === 'string') {
      said.push(leftWords(d, k, a, keep, params))
      continue
    }
    // the move is tried on the meshes first: it must meet every part it was loose from and run into no other
    let after: FitFacts
    try {
      after = await fitFacts(host, d, limits, a.only, shifted(d, k, world))
    } catch {
      continue
    }
    const hit = newTouches(a.fit, after, k, partners)
    if (hit.length) {
      said.push(leftWords(d, k, a, keep, `seating it would run it into ${names(d, hit)}`))
      continue
    }
    if (!allSeated(after, k, partners)) {
      said.push(leftWords(d, k, a, keep, `moving it ${gapMm(r2(dist))} along the gap does not seat it everywhere`))
      continue
    }
    if (!(await commit(host, d, d.history.steps.map((x, i) => (i === j ? { ...x, params } : x))))) {
      said.push(leftWords(d, k, a, keep, 'the step did not go through moved'))
      continue
    }
    said.push(`${part.name} was ${gapMm(g.gapMm)} from ${names(d, partners)}, so it is seated on ${names(d, partners)} (moved ${gapMm(r2(dist))})`)
  }
  // copies a step added at once (separate copies): no one of them is moved, and they are named together
  if (several.length) {
    const gaps = several.flatMap((x) => x.a.gaps.map((g) => ({ g, other: sideOf(x.a.fit, g, x.k).other })))
    const least = Math.min(...gaps.map((x) => x.g.gapMm))
    said.push(`${names(d, several.map((x) => x.k))} ${several.length === 1 ? 'is' : 'are'} ${gapMm(least)} or more but under the ${gapMm(keep)} a printer keeps open from ${names(d, gaps.map((x) => x.other))}, and ${several.length === 1 ? 'was' : 'were'} left where ${several.length === 1 ? 'it is' : 'they are'}: the step made ${s?.params.op === 'parts.add' ? s.params.parts.length : several.length} parts at once, so no one of them is moved. Change the step that made the source so the copies sit on ${names(d, gaps.map((x) => x.other))}, or at least ${gapMm(keep)} away`)
  }
  return said.join('. ')
}

/** The turns that take the source of an array or mirror step to each copy (the source's own first), linear parts only. */
function copyTurns(p: StepParams): number[][] {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  if (p.op === 'mirror') {
    if (!p.copy) return [I]
    const n = p.plane.normal
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    const [a, b, c] = [n[0] / l, n[1] / l, n[2] / l]
    return [I, [1 - 2 * a * a, -2 * a * b, -2 * a * c, -2 * b * a, 1 - 2 * b * b, -2 * b * c, -2 * c * a, -2 * c * b, 1 - 2 * c * c]]
  }
  if (p.op === 'array.merged' && p.spec.kind === 'circular' && p.spec.rotateCopies !== false) {
    const ax = p.spec.axis ?? [0, 0, 1]
    const l = Math.hypot(ax[0], ax[1], ax[2]) || 1
    const [x, y, z] = [ax[0] / l, ax[1] / l, ax[2] / l]
    const total = p.spec.angleDeg ?? 360
    const out: number[][] = []
    // each copy's turn; a part angle spreads the copies over it either way, so both spacings are tried
    for (const step of new Set([total / p.spec.count, p.spec.count > 1 ? total / (p.spec.count - 1) : total])) {
      for (let k = 0; k < p.spec.count; k++) {
        const t = (k * step * Math.PI) / 180
        const [co, si] = [Math.cos(t), Math.sin(t)]
        out.push([co + x * x * (1 - co), x * y * (1 - co) - z * si, x * z * (1 - co) + y * si, y * x * (1 - co) + z * si, co + y * y * (1 - co), y * z * (1 - co) - x * si, z * x * (1 - co) - y * si, z * y * (1 - co) + x * si, co + z * z * (1 - co)])
      }
    }
    return out
  }
  return [I]
}
const turn = (m: number[], v: Vec3): Vec3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]]
const back = (m: number[], v: Vec3): Vec3 => [m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2], m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2], m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2]]

/**
 * The one step that made part `k` before step `j`, when it is the only step on that part before `j`: an extrude,
 * revolve, loft or sweep making a new body, or a step adding that part alone. Otherwise why not.
 */
function onlyMaker(d: HostDesign, k: number, j: number): number | string {
  const name = d.parts[k]?.name
  const steps = d.history.steps.slice(0, j)
  const own = steps.flatMap((s, i) => (!s.suppressed && s.part === k ? [i] : []))
  const added = steps.flatMap((s, i) => (!s.suppressed && s.params.op === 'parts.add' && s.params.parts.length === 1 && s.params.parts[0]!.name === name ? [i] : []))
  if (own.length === 1 && !added.length) {
    const p = steps[own[0]!]!.params as { op: string; operation?: string; spec?: { operation?: string } }
    if ((p.operation ?? p.spec?.operation) === 'new') return own[0]!
  }
  if (!own.length && added.length === 1) return added[0]!
  return 'more than one step made it, so moving one would leave the others'
}

/**
 * Seats the copies an array or mirror step (`j`, the last step) made on part `k`: when they are loose from the parts
 * beside them and their gaps agree in the pattern's own frame (each copy's gap is the source's, turned or mirrored as
 * the copy is), the one step that made the part moves along the source's gap, the pattern follows it, and every copy
 * must then meet every part it was loose from and run into no other. Else the part is named and left. Returns what the
 * answer adds, or ''.
 */
export async function seatPattern(host: DesignHost, d: HostDesign, k: number, opts: { nozzleMm?: number | undefined; layerHeightMm?: number | undefined; plans?: PiecePlans | undefined }): Promise<string> {
  if (k < 0 || !d.parts[k] || designMoves(opts.plans, d)) return ''
  const limits = keepOpenLimits(opts.nozzleMm, opts.layerHeightMm)
  const keep = limits.sideMm
  const moving = movingParts(d)
  if (moving.has(k)) return ''
  const a = await looseAround(host, d, k, limits, moving)
  if (!a) return ''
  const j = d.history.steps.length - 1
  const s = d.history.steps[j]
  if (!s || (s.params.op !== 'mirror' && s.params.op !== 'array.merged')) return ''
  const sides = a.gaps.map((x) => sideOf(a.fit, x, k))
  const partners = new Set(sides.map((x) => x.other))
  const turns = copyTurns(s.params)
  // the source's own direction: a turn of the first gap's back to the source that every gap is some copy's turn of
  const tried = turns.map((m) => back(m, sides[0]!.dir)).filter((u) => sides.every((x) => turns.some((m) => dot3(turn(m, u), x.dir) >= AGREE)))
  if (!tried.length) return leftWords(d, k, a, keep, "its copies' gaps do not agree with the pattern, so no one move seats them")
  const dist = a.gaps[0]!.gapMm + SEAT_OVERLAP_MM
  if (dist > keep + 1e-9) return leftWords(d, k, a, keep, `seating it would move it ${gapMm(r2(dist))}, more than that gap`)
  const m = onlyMaker(d, k, j)
  if (typeof m === 'string') return leftWords(d, k, a, keep, m)
  for (const u of tried) {
    const world: Vec3 = [u[0] * dist, u[1] * dist, u[2] * dist]
    const params = movedStep(d.history.steps[m]!, world, d.transform)
    if (typeof params === 'string') return leftWords(d, k, a, keep, params)
    const steps = d.history.steps.map((x, i) => (i === m ? { ...x, params } : x))
    // the pattern replayed on the moved source, without keeping it: every copy must seat and run into nothing
    let parts: HistoryMesh[]
    try {
      const r = await replayHistory((op, request) => host.call(op, request), { history: { ...d.history, steps } })
      if (r.status.some((x) => x.state !== 'done')) continue
      parts = r.parts
    } catch {
      continue
    }
    let after: FitFacts
    try {
      after = await fitFacts(host, d, limits, a.only, parts)
    } catch {
      continue
    }
    if (newTouches(a.fit, after, k, partners).length || !allSeated(after, k, partners)) continue
    if (!(await commit(host, d, steps))) continue
    return `${d.parts[k]!.name} was ${gapMm(a.gaps[0]!.gapMm)} from ${names(d, partners)} at ${a.gaps.length} ${a.gaps.length === 1 ? 'place' : 'places'}, so step ${m + 1}, ${stepName(d.history.steps[m]!)}, moved ${gapMm(r2(dist))} and every copy is seated on ${names(d, partners)}`
  }
  return leftWords(d, k, a, keep, 'moving the step that made it does not seat every copy without running into another part')
}

