// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores one build eval run on two counts. Geometry: the steps a good build uses ran, the part is one closed solid (or
// the bodies the case allows), its walls print, it fits the bed and its main sizes are near the request, read on each
// body or assembly rather than on the plate, since parts are laid out apart to print; a hook holds what hangs on it,
// and a hinged lid sits on its box at a gap that prints apart and turns on a pin through both. Turns: the
// person sends one message, confirms the dimension sheet once and presses Go on the plan once (once for each part
// when the message asks for separate parts); any other answer, question card or nudge is an extra turn, and one extra
// turn fails the run however good the part is. The run's verdict is pass or fail from those checks alone, or disagree
// when what the run says of its own part (its last design.check result, else its reply) contradicts them.
import type { MeshPart, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { assessFit } from '@slicerx/pilot/evals'
import { bedFit, bodyBoxes, bodyCount, bodyTriangles, closure, minWall, type BuildVolume } from '../../../mcp/evals/creative/mesh-checks'
import { floorFacts, holeLoops } from '../../../mcp/src/body-facts'
import { floorItem } from '../../../mcp/src/design-check'
import { hookOn, least, LIP_RISE_MM, most, surfacePoints, type V3 } from '../../../mcp/src/hook-lip'
import type { BuildCase, FloorSpec, HookSpec, OpMatch, SizeCheck } from './cases'

export interface Check {
  pass: boolean
  detail: string
}

/**
 * Something the person did in the run, in order. The first message, one sheet confirm and one Go are free, or one sheet
 * and one Go for each part when the message asks for separate parts. A Go names the plan it approved, and the design
 * that plan was built in once a step built it (the drive reads the tie after the run). An amend is the Go on a change to
 * an approved plan (design.plan with amends, after a failed check): the plan it changes and the revision it makes.
 */
export type UserTurn =
  | { kind: 'message'; text: string }
  | { kind: 'sheet'; title: string }
  | { kind: 'go'; part: string; plan: string; design?: string }
  | { kind: 'amend'; part: string; plan: string; revision: number; design?: string }
  | { kind: 'answer'; question: string; picked: string }
  | { kind: 'nudge'; text: string; why: NoBuild }

/** Why a turn ended with nothing built: it turned the part down, asked a question, or neither. */
export type NoBuild = 'declined' | 'asked' | 'none'

// the same reading as the creative eval (packages/mcp/evals/creative/run.ts classifyNoBuild), plus the ways a reply
// says a shape is past the tools ("this modeler cannot create", "the tools don't support sweeps")
const DECLINES =
  /\b(?:can(?:'|’|no)t|cannot|unable to|not able to)\s+(?:\w+\s+){0,3}?(?:model|build|make|design|sculpt|create|do|loft|sweep)\b|\boutside what (?:I|the tools?) can\b|\btools? (?:can(?:'|’|no)t|cannot|only|do(?:es)?n(?:'|’)t)\b|\bmodeler (?:can(?:'|’|no)t|cannot)\b|\b(?:isn(?:'|’)t|not) (?:possible|supported)\b/i
const ASKS = /\?[)"'”’*_]*(?:\s|$)/

export function classifyNoBuild(reply: string): NoBuild {
  if (DECLINES.test(reply)) return 'declined'
  if (ASKS.test(reply)) return 'asked'
  return 'none'
}

/** The design steps that ran without an error, with their inputs. */
export function okSteps(events: readonly PilotEvent[]): { tool: string; input: unknown }[] {
  const ok = new Set(events.flatMap((e) => (e.type === 'tool_result' && e.ok !== false ? [e.callId] : [])))
  return events.flatMap((e) => (e.type === 'tool_call' && ok.has(e.callId) ? [{ tool: e.tool, input: e.input }] : []))
}

function matches(step: { tool: string; input: unknown }, m: OpMatch): boolean {
  if (m !== 'geom.revolve:partial') return step.tool === m
  if (step.tool !== 'geom.revolve') return false
  const angle = (step.input as { angle_deg?: unknown } | null)?.angle_deg
  return typeof angle === 'number' && Math.abs(angle) < 360
}

/** The part a Go is for: the design its plan was built in, or the plan alone when nothing was built from it. */
const goPart = (t: Extract<UserTurn, { kind: 'go' }>): string => t.design ?? `plan ${t.plan}`

/**
 * Every extra turn: answers to questions, nudges, and any sheet or Go that is not for a new part. Nothing here reads the
 * model's words for a part (a sheet's title, a plan's name), which it can change from one card to the next.
 *
 * A Go is for the design its plan was built in (goPart): free once for each design, up to `parts`, so a plan renamed
 * and built in the same design again counts. A sheet is matched to a Go: the sheets asked together (no Go between
 * them) go in order to the Gos that come after them before the next sheet, one each; a sheet with no such Go goes to
 * the last Go before it, and stands for a part of its own when there is none. A sheet is free once for each part, up to
 * `parts`, so two parts whose sheets share a title are both free, and a part sized again after its Go counts.
 *
 * An amend is part of the flow: a build whose check fails may change its approved plan once in that fix round, and the
 * person's Go on the change is free once for each plan. A second change to the same plan counts.
 */
export function extraTurns(turns: readonly UserTurn[], parts = 1): UserTurn[] {
  const extra = new Set<number>()
  const gos = new Set<string>()
  const amended = new Set<string>()
  turns.forEach((t, i) => {
    if (t.kind === 'amend') {
      if (amended.has(t.plan)) extra.add(i)
      amended.add(t.plan)
    }
    if (t.kind !== 'go') return
    const part = goPart(t)
    if (gos.has(part) || gos.size >= parts) extra.add(i)
    gos.add(part)
  })
  const sheeted = new Set<string>()
  let run = 0
  turns.forEach((t, i) => {
    if (t.kind === 'go') run = 0
    if (t.kind !== 'sheet') return
    // the Gos after this run of sheets and before the next sheet
    const ahead: string[] = []
    for (let k = i + 1; k < turns.length; k++) {
      const n = turns[k]!
      if (n.kind === 'go') ahead.push(goPart(n))
      else if (n.kind === 'sheet' && ahead.length) break
    }
    const before = turns.slice(0, i).reverse().find((n): n is Extract<UserTurn, { kind: 'go' }> => n.kind === 'go')
    const part = ahead[run] ?? (before ? goPart(before) : `sheet ${i}`)
    run++
    if (sheeted.has(part) || sheeted.size >= parts) extra.add(i)
    sheeted.add(part)
  })
  return turns.filter((t, i) => (t.kind === 'message' ? i > 0 : t.kind === 'sheet' || t.kind === 'go' || t.kind === 'amend' ? extra.has(i) : true))
}

/** `parts` placed on the plate: each one's positions through its 4x4 column-major transform. */
export function placed(entries: readonly { parts: readonly MeshPart[]; transform: readonly number[] }[]): MeshPart[] {
  return entries.flatMap((e) =>
    e.parts.map((p) => {
      const m = e.transform
      const src = p.positions
      const out = new Float32Array(src.length)
      for (let k = 0; k + 2 < src.length; k += 3) {
        const [x, y, z] = [src[k]!, src[k + 1]!, src[k + 2]!]
        out[k] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        out[k + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        out[k + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
      }
      return { ...p, positions: out }
    }),
  )
}

export function sizeOf(parts: readonly MeshPart[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts)
    for (let k = 0; k + 2 < p.positions.length; k += 3)
      for (let a = 0; a < 3; a++) {
        const v = p.positions[k + a]!
        if (v < lo[a]!) lo[a] = v
        if (v > hi[a]!) hi[a] = v
      }
  return [0, 1, 2].map((a) => (hi[a]! >= lo[a]! ? Math.round((hi[a]! - lo[a]!) * 10) / 10 : 0)) as [number, number, number]
}

const sideOf = (size: [number, number, number], axis: SizeCheck['axis']): number => (axis === 'x' ? size[0] : axis === 'y' ? size[1] : axis === 'z' ? size[2] : Math.max(size[0], size[1]))

type Box = { min: [number, number, number]; max: [number, number, number]; hull?: [number, number][] }
/**
 * Bodies whose boxes come this close count as one assembly (a lid sitting on its box, a hook on its stem), mm; parts
 * laid out to print sit further apart.
 */
const TOUCH_MM = 0.1

/**
 * How far apart two outlines seen from above stand at least, mm, as the widest gap along a side's outward normal of
 * either (0 or less when they overlap). It never reads more than the true gap, so outlines it puts apart are apart.
 */
function hullGap(a: readonly [number, number][], b: readonly [number, number][]): number {
  let gap = -Infinity
  for (const [p, q] of [[a, b], [b, a]] as const)
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i]!
      const [x1, y1] = p[(i + 1) % p.length]!
      const len = Math.hypot(x1 - x0, y1 - y0)
      if (len === 0) continue
      // the outward normal of a counterclockwise side
      const [nx, ny] = [(y1 - y0) / len, -(x1 - x0) / len]
      gap = Math.max(gap, Math.min(...q.map(([x, y]) => (x - x0) * nx + (y - y0) * ny)))
    }
  return gap
}

/**
 * The size of each assembly on the plate: bodies whose boxes touch or overlap and whose outlines seen from above touch
 * or overlap go together, as a lid sitting on its box, a planter standing in its saucer or a hook joined onto a stem
 * do, while a part laid out apart for printing (a lid beside its box, a round saucer corner to corner with its round
 * planter, whose square boxes overlap) is its own.
 */
export function assemblySizes(parts: readonly MeshPart[]): [number, number, number][] {
  const boxes: Box[] = bodyBoxes([...parts])
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const near = (a: Box, b: Box) =>
    [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + TOUCH_MM && b.min[k]! <= a.max[k]! + TOUCH_MM) &&
    (!a.hull || !b.hull || a.hull.length < 3 || b.hull.length < 3 || hullGap(a.hull, b.hull) <= TOUCH_MM)
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (near(boxes[i]!, boxes[j]!)) parent[find(i)] = find(j)
  const groups = new Map<number, Box>()
  for (const [i, b] of boxes.entries()) {
    const g = groups.get(find(i))
    groups.set(find(i), g ? { min: [0, 1, 2].map((k) => Math.min(g.min[k]!, b.min[k]!)) as Box['min'], max: [0, 1, 2].map((k) => Math.max(g.max[k]!, b.max[k]!)) as Box['max'] } : b)
  }
  return [...groups.values()].map((g) => [0, 1, 2].map((k) => Math.round((g.max[k]! - g.min[k]!) * 10) / 10) as [number, number, number])
}

const round1 = (v: number): number => Math.round(v * 10) / 10

/** How near a point of one body must come to another body's surface to touch it, mm. */
const JOIN_MM = 0.05
/**
 * How far where two bodies meet must reach both ways, mm: two bodies joined over a face meet over an area this wide or
 * more, while two that meet only along an edge or at a point meet along a line or not at all across.
 */
const JOIN_ACROSS_MM = 1

/**
 * Whether two bodies are joined over a face: the points of each that lie inside the other or on its surface (a body
 * standing in another, or face to face with it) reach JOIN_ACROSS_MM or more both ways. Bodies that meet only along an
 * edge or at a point, or not at all, are not.
 */
function joinedOverFace(a: Body & { pts: V3[] }, b: Body & { pts: V3[] }): boolean {
  const dist = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  const meet: V3[] = []
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const near = (q: V3) => [0, 1, 2].every((k) => q[k]! >= y.min[k]! - JOIN_MM && q[k]! <= y.max[k]! + JOIN_MM)
    const touches = (q: V3) => {
      for (let t = 0; t < y.tri.length; t += 9) if (dist(q, nearestOnTriangle(q, y.tri, t)) <= JOIN_MM) return true
      return false
    }
    for (const q of x.pts) if (near(q) && (touches(q) || inside(y, q))) meet.push(q)
  }
  if (meet.length < 3) return false
  // the longest way across, from the point farthest from any one, and how far the rest stand off that line
  const p = meet.reduce((m, q) => (dist(q, meet[0]!) > dist(m, meet[0]!) ? q : m))
  const q = meet.reduce((m, r) => (dist(r, p) > dist(m, p) ? r : m))
  const len = dist(p, q)
  if (len < JOIN_ACROSS_MM) return false
  const u: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
  const off = most(meet, (r) => {
    const w: V3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
    return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / len
  })
  return off >= JOIN_ACROSS_MM
}

/**
 * The surface points of each group of the part's bodies joined over a face (joinedOverFace), as one body: the bodies a
 * boolean join of them would make one, read whether the build joined them or left them as bodies that overlap.
 */
function joinedGroups(parts: readonly MeshPart[]): V3[][] {
  const bodies = bodyTriangles([...parts]).map((b) => ({ ...b, pts: surfacePoints([{ positions: b.tri, indices: Array.from({ length: b.tri.length / 3 }, (_, i) => i) }]) }))
  const parent = bodies.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const boxesMeet = (a: Body, b: Body) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + TOUCH_MM && b.min[k]! <= a.max[k]! + TOUCH_MM)
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) if (find(i) !== find(j) && boxesMeet(bodies[i]!, bodies[j]!) && joinedOverFace(bodies[i]!, bodies[j]!)) parent[find(i)] = find(j)
  const groups = new Map<number, V3[]>()
  for (const [i, b] of bodies.entries()) groups.set(find(i), [...(groups.get(find(i)) ?? []), ...b.pts])
  return [...groups.values()]
}

/**
 * Whether the part's hook holds what hangs on it (cases.ts HookSpec). lip reads the stem from the part itself (hookOn,
 * the reading design.check holds a planned hook's lip to), so a revolved, lofted or extruded stem is judged by its
 * shape, and says whether it tapers and is hollow; the hook must be joined to the stem over a face (joinedGroups), at
 * its side or its top, and its tip must rise. leg reads the rod from the part itself.
 */
export function hookCheck(spec: HookSpec, parts: readonly MeshPart[]): Check {
  const pts = surfacePoints(parts)
  if (!pts.length) return { pass: false, detail: 'no part' }
  if (spec.kind === 'leg') {
    const z0 = least(pts, (q) => q[2])
    // the rod alone, past the plate and below the bend
    const slab = pts.filter((q) => q[2] > z0 + 15 && q[2] < z0 + 30)
    if (!slab.length) return { pass: false, detail: 'no rod above the plate' }
    const c = [slab.reduce((a, q) => a + q[0], 0) / slab.length, slab.reduce((a, q) => a + q[1], 0) / slab.length]
    const d = (q: V3) => Math.hypot(q[0] - c[0]!, q[1] - c[1]!)
    const hook = pts.filter((q) => q[2] > z0 + 30 && d(q) > spec.rodMm / 2 + 2)
    if (!hook.length) return { pass: false, detail: 'no hook past the rod' }
    const top = most(pts, (q) => q[2])
    const far = most(hook, d)
    const leg = top - least(hook.filter((q) => d(q) >= far - spec.rodMm), (q) => q[2])
    const want = spec.rodMm + 5
    return { pass: leg >= want, detail: `leg hangs ${round1(leg)} mm below the top of the hook (want ${want} mm or more)` }
  }
  const read = hookOn(pts)
  if (read.found === 'no stem') return { pass: false, detail: 'no round column to read the stem from' }
  if (read.found === 'no hook') return { pass: false, detail: 'nothing reaches out past the stem' }
  const shape = (s: { bottomMm: number; topMm: number; hollow: boolean }) =>
    `stem ${s.bottomMm > s.topMm ? 'tapers' : 'runs'} from ${s.bottomMm} to ${s.topMm} mm across, ${s.hollow ? 'hollow' : 'solid'}`
  const rises = (riseMm: number) => `tip ${riseMm >= LIP_RISE_MM ? 'rises' : 'rises only'} ${round1(riseMm)} mm above the hook's lowest point near the end (want ${LIP_RISE_MM} mm or more)`
  // the hook read with only the bodies joined to the stem: one that stands apart, or meets it only along an edge or at a
  // point, is not there
  const held = joinedGroups(parts).map((g) => hookOn(g)).find((r) => r.found === 'hook')
  if (!held || held.found !== 'hook') return { pass: false, detail: `${shape(read.stem)}; the hook is not joined to the stem over a face (it stands apart, or meets it only along an edge or at a point); ${rises(read.riseMm)}` }
  return { pass: held.riseMm >= LIP_RISE_MM, detail: `${shape(held.stem)}; joined to the stem at its ${held.side ? 'side below its top' : 'top'}; ${rises(held.riseMm)}` }
}

/** How near a lid must come to its box to be joined to it by a hinge, mm: past this it lies apart. */
const LID_REACH_MM = 2
/**
 * How flat a face lies for the gap across it to be one over the other, as its normal's upward share (about 25 degrees
 * off level): a slanted face, such as a chamfered lip, is held to the side gap, since its layers step past each other.
 */
const FLAT = 0.9
/** A face this level is flat, not a facet near the top of a round face (a knuckle or a pin lying down). */
const LEVEL = 0.999
/**
 * How far under its limit a gap may measure and still clear it, mm, as the fit check takes it: side by side, and over
 * a round face, facets sit a little inside the round they are drawn for. A gap over a level face gets none.
 */
const FACET_MM = 0.02
/** How square to a face a gap runs to count as straight across it: the cosine to its normal, about 11 degrees off. */
const SQUARE = 0.98
/** The smallest share of the box's largest side (its two largest sizes multiplied) a lid's largest side has. */
const LID_FACE_SHARE = 0.25

/** The point of triangle `tri[at]` (nine numbers) nearest p (Ericson, Real-Time Collision Detection 5.1.5). */
function nearestOnTriangle(p: V3, tri: Float64Array, at: number): V3 {
  const a: V3 = [tri[at]!, tri[at + 1]!, tri[at + 2]!]
  const b: V3 = [tri[at + 3]!, tri[at + 4]!, tri[at + 5]!]
  const c: V3 = [tri[at + 6]!, tri[at + 7]!, tri[at + 8]!]
  const sub = (u: V3, v: V3): V3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
  const dot = (u: V3, v: V3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const along = (o: V3, u: V3, t: number): V3 => [o[0] + u[0] * t, o[1] + u[1] * t, o[2] + u[2] * t]
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3))
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/**
 * How near the faces of `from` come to those of `to`, mm, from each corner and edge middle of `from` within `reach`:
 * the nearest of all (`near`), and the smallest gap straight across a face of `to` (along its normal), side by side
 * (a face that stands or slants) and one over the other (a face that lies flat, FLAT). A gap at a slant past a face's edge (a lid's lip
 * past the rim's corner) counts only toward `near`, since the faces on either side of it have their own gaps. `level`
 * is the smallest gap over a face that lies dead level, as against one on the top of a round face drawn as facets. Infinity for what no point comes within reach of.
 */
function nearestGaps(from: Float64Array, to: Float64Array, reach: number): { near: number; side: number; over: number; level: number } {
  // the triangles of `to` in a grid of `reach` cells, each in every cell its box (grown by reach) crosses
  const cell = (v: number) => Math.floor(v / reach)
  const grid = new Map<string, number[]>()
  for (let t = 0; t < to.length; t += 9) {
    const lo = [0, 1, 2].map((k) => cell(Math.min(to[t + k]!, to[t + 3 + k]!, to[t + 6 + k]!) - reach))
    const hi = [0, 1, 2].map((k) => cell(Math.max(to[t + k]!, to[t + 3 + k]!, to[t + 6 + k]!) + reach))
    for (let i = lo[0]!; i <= hi[0]!; i++) for (let j = lo[1]!; j <= hi[1]!; j++) for (let k = lo[2]!; k <= hi[2]!; k++) {
      const key = `${i},${j},${k}`
      const list = grid.get(key)
      if (list) list.push(t)
      else grid.set(key, [t])
    }
  }
  // a face's unit normal
  const normal = (t: number): V3 | null => {
    const e1 = [0, 1, 2].map((k) => to[t + 3 + k]! - to[t + k]!)
    const e2 = [0, 1, 2].map((k) => to[t + 6 + k]! - to[t + k]!)
    const n: V3 = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const l = Math.hypot(n[0], n[1], n[2])
    return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : null
  }
  let near = Infinity
  let side = Infinity
  let over = Infinity
  let level = Infinity
  const seen = new Set<string>()
  const probe = (p: V3) => {
    const id = `${p[0]},${p[1]},${p[2]}`
    if (seen.has(id)) return
    seen.add(id)
    for (const t of grid.get(`${cell(p[0])},${cell(p[1])},${cell(p[2])}`) ?? []) {
      const q = nearestOnTriangle(p, to, t)
      const d: V3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
      const dist = Math.hypot(d[0], d[1], d[2])
      if (dist > reach) continue
      near = Math.min(near, dist)
      // straight across the face: the gap runs along its normal, not at a slant past its edge
      const n = normal(t)
      if (!n || Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) < SQUARE * dist) continue
      if (Math.abs(n[2]) >= LEVEL) level = Math.min(level, dist)
      if (Math.abs(n[2]) >= FLAT) over = Math.min(over, dist)
      else side = Math.min(side, dist)
    }
  }
  for (let t = 0; t < from.length; t += 9) {
    const c: V3[] = [0, 1, 2].map((j) => [from[t + j * 3]!, from[t + j * 3 + 1]!, from[t + j * 3 + 2]!] as V3)
    for (let j = 0; j < 3; j++) {
      const [a, b] = [c[j]!, c[(j + 1) % 3]!]
      probe(a)
      probe([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])
    }
  }
  return { near, side, over, level }
}

type Body = ReturnType<typeof bodyTriangles>[number]

/**
 * The box and its lid among the part's bodies: the largest body is the box, and the lid the next largest whose largest
 * side is near the box's (a pin or a loose knuckle is a rod or a stub, far smaller across its two largest sides). The
 * other bodies come with them, largest first. `why` says what is missing instead.
 */
function boxAndLid(parts: MeshPart[]): { bodies: Body[]; box: Body; lid: Body } | { why: string } {
  const bodies = bodyTriangles(parts).sort((a, b) => b.volumeMm3 - a.volumeMm3)
  if (bodies.length < 2) return { why: 'one body: the lid is not a piece of its own, so it cannot open' }
  const box = bodies[0]!
  const face = (b: { min: V3; max: V3 }) => {
    const [, m, l] = [0, 1, 2].map((k) => b.max[k]! - b.min[k]!).sort((x, y) => x - y)
    return m! * l!
  }
  const lid = bodies.slice(1).find((b) => face(b) >= LID_FACE_SHARE * face(box))
  if (!lid) return { why: 'no lid: no other body is near the size of the box, so the lid is part of the box or missing' }
  return { bodies, box, lid }
}

const r2z = (v: number): number => Math.round(v * 100) / 100

/**
 * The height of a box with its lid closed, when the lid is printed open beside it: the lid's lowest point under the
 * box's top, so it does not sit on the box. The box's height and the lid's added, as the lid closes onto the top. Null
 * when there is no box and lid, or the lid sits on the box already (its height is then read as it stands).
 */
export function closedHeight(parts: MeshPart[]): number | null {
  const found = boxAndLid(parts)
  if ('why' in found) return null
  const { box, lid } = found
  if (lid.min[2]! >= box.max[2]! - LID_ON_TOP_MM) return null
  return box.max[2]! - box.min[2]! + (lid.max[2]! - lid.min[2]!)
}

/** A lid whose lowest point is within this of the box's top, or above it, sits on the box. */
const LID_ON_TOP_MM = 1

/**
 * Whether the box's lid is joined to it and can open (cases.ts LidSpec): the largest body is the box and the next
 * largest whose largest side is near the box's is its lid; the lid must be a piece of its own, come within LID_REACH_MM of the box (a lid laid apart has no
 * hinge joining them), and keep the gap the fit rule says a print in place joint needs on this machine, side by side
 * and one over the other, so it neither fuses to the box nor binds. The gap is read from each corner and edge middle of
 * either body straight across to the faces of the other (nearestGaps).
 */
export function lidCheck(m: PilotMachine, parts: MeshPart[], stated: LidStated = 'assembled'): Check {
  const found = boxAndLid(parts)
  if ('why' in found) return { pass: false, detail: found.why }
  if (stated === 'apart') return lidApart(found)
  const { box, lid } = found
  const a = nearestGaps(lid.tri, box.tri, LID_REACH_MM)
  const b = nearestGaps(box.tri, lid.tri, LID_REACH_MM)
  const near = Math.min(a.near, b.near)
  const side = Math.min(a.side, b.side)
  const over = Math.min(a.over, b.over)
  if (!Number.isFinite(near)) return { pass: false, detail: `the lid lies apart from the box (nothing within ${LID_REACH_MM} mm), so no hinge joins them` }
  if (near < 0.0005) return { pass: false, detail: 'the lid touches the box, so they print as one piece' }
  const need = (gapMm: number, direction: 'xy' | 'z') => assessFit({ gapMm, feature: 'print_in_place', direction, layerHeight: m.nozzle / 2, lineWidth: m.nozzle * 1.05, nozzle: m.nozzle, material: m.material })
  const mm3 = (v: number) => Math.round(v * 1000) / 1000
  const level = Math.min(a.level, b.level)
  // over: a level face is held to the limit itself, a round one within FACET_MM of it; beside: within FACET_MM
  const judged: { mm: number; where: string; fit: ReturnType<typeof need>; pass: boolean }[] = []
  if (Number.isFinite(over)) {
    const fit = need(mm3(over), 'z')
    const levelOk = !Number.isFinite(level) || need(mm3(level), 'z').outcome === 'slides'
    judged.push({ mm: mm3(over), where: 'over', fit, pass: levelOk && need(mm3(over + FACET_MM), 'z').outcome === 'slides' })
  }
  if (Number.isFinite(side)) judged.push({ mm: mm3(side), where: 'beside', fit: need(mm3(side), 'xy'), pass: need(mm3(side + FACET_MM), 'xy').outcome === 'slides' })
  // only edges and corners face each other (knuckles side by side at a slant): the nearest gap is held as a side gap
  if (!judged.length) judged.push({ mm: mm3(near), where: 'from', fit: need(mm3(near), 'xy'), pass: need(mm3(near + FACET_MM), 'xy').outcome === 'slides' })
  return { pass: judged.every((g) => g.pass), detail: judged.map((g) => `lid ${g.mm} mm ${g.where} the box (want ${g.fit.suggestedGapMm} mm or more${g.pass && g.fit.outcome !== 'slides' ? `; within ${FACET_MM} mm counts, as facets of a round face` : ''})`).join(', ') }
}

/** How the run's plan says the lid prints: on its hinge (the default), or laid apart to be put on after. */
export type LidStated = 'assembled' | 'apart'

/** Words of an assumption that put the lid apart from its box to print. */
const APART_WORDS = /\b(apart|beside the box|next to the box|separately|side by side|laid flat)\b/i

/**
 * How the run's last plan says its lid prints: apart when printInPlace is false or an assumption puts it apart,
 * otherwise assembled on its hinge.
 */
export function lidStated(events: readonly PilotEvent[]): LidStated {
  let said: LidStated = 'assembled'
  const ok = new Set(events.flatMap((e) => (e.type === 'tool_result' && e.ok !== false ? [e.callId] : [])))
  for (const e of events) {
    if (e.type !== 'tool_call' || e.tool !== 'design.plan' || !ok.has(e.callId)) continue
    const plan = e.input as { printInPlace?: unknown; assumptions?: unknown } | null
    const assumed = Array.isArray(plan?.assumptions) && plan.assumptions.some((a) => typeof a === 'string' && APART_WORDS.test(a))
    said = plan?.printInPlace === false || (!Array.isArray(plan?.printInPlace) && assumed) ? 'apart' : 'assembled'
  }
  return said
}

/** How far a lid printed apart stands from its box at least, mm. */
const APART_MM = 2
/** How far above the lowest point of the part a body may start and still rest on the bed, mm. */
const ON_BED_MM = 0.05

/** A lid stated as printed apart: a piece of its own, at least APART_MM from the box, and every body on the bed. */
function lidApart({ bodies, box, lid }: { bodies: Body[]; box: Body; lid: Body }): Check {
  const near = Math.min(nearestGaps(lid.tri, box.tri, APART_MM).near, nearestGaps(box.tri, lid.tri, APART_MM).near)
  if (Number.isFinite(near)) return { pass: false, detail: `the lid is planned apart but comes within ${Math.round(near * 1000) / 1000} mm of the box (want ${APART_MM} mm or more)` }
  const bed = Math.min(...bodies.map((b) => b.min[2]!))
  const up = bodies.filter((b) => b.min[2]! > bed + ON_BED_MM)
  if (up.length) return { pass: false, detail: `the lid is planned apart, but ${up.length} of ${bodies.length} bodies do not rest on the bed (lowest ${Math.round((up[0]!.min[2]! - bed) * 100) / 100} mm up)` }
  return { pass: true, detail: `the lid lies apart, ${APART_MM} mm or more from the box, and every body rests on the bed` }
}

/**
 * The pass of the last design.check in the run that returned one, read from its result (`pass` on the check's output;
 * a check repeated after its fix round carries the same result). Null when no check returned a result.
 */
export function lastCheckPass(events: readonly PilotEvent[]): boolean | null {
  const checks = new Set(events.flatMap((e) => (e.type === 'tool_call' && e.tool === 'design.check' ? [e.callId] : [])))
  let last: boolean | null = null
  for (const e of events) {
    if (e.type !== 'tool_result' || !checks.has(e.callId) || e.ok === false) continue
    const pass = (e.output as { pass?: unknown } | undefined)?.pass
    if (typeof pass === 'boolean') last = pass
  }
  return last
}

// What a reply says of its own check, read only when the run has no check result to read. A failed check: the check
// as the subject of failed or stopped ("the design check failed twice", "the plan check failed on one item", "the
// design check stopped it"), or the part failing or not passing a check ("it fails the plan's size check", "it doesn't
// pass the print-in-place check yet", "it has not passed the check"). A passed check: the part passing a check
// ("passes the plan check", "passes all three plan checks"). Words of a check that may come later (a sentence with
// if, unless or whether) say nothing.
const WORD = "[\\w'’-]+"
const SAYS_FAILED = new RegExp(
  `\\bchecks? (?:${WORD} ){0,2}?(?:failed|stopped)\\b|\\bfail(?:s|ed)? (?:${WORD} ){0,3}?checks?\\b|\\b(?:do(?:es)?n['’]?t|didn['’]t|hasn['’]t|not) pass(?:ed)? (?:${WORD} ){0,3}?checks?\\b`,
  'i',
)
const SAYS_PASSED = new RegExp(`\\bpass(?:es|ed)? (?:${WORD} ){0,3}?checks?\\b`, 'i')
const CONDITIONAL = /\b(?:if|unless|whether)\b/i

/** Whether a reply says its part failed or passed its check, or says neither. A failed check anywhere wins. */
export function replyClaim(reply: string): 'pass' | 'fail' | null {
  const sentences = reply.split(/(?<=[.!?:])\s+|\n+/).filter((s) => !CONDITIONAL.test(s))
  if (sentences.some((s) => SAYS_FAILED.test(s))) return 'fail'
  if (sentences.some((s) => SAYS_PASSED.test(s))) return 'pass'
  return null
}

/**
 * The last design.check verdict in a run's call list (drive.ts calls, as a results line keeps them): true or false
 * from "design.check ok (part passed)" or "(part failed)", null when no check in the list says. Lists recorded before
 * checks said so read as null.
 */
export function checkFromCalls(calls: readonly string[]): boolean | null {
  let last: boolean | null = null
  for (const c of calls) {
    const m = /^design\.check ok \(part (passed|failed)\)$/.exec(c)
    if (m) last = m[1] === 'passed'
  }
  return last
}

/** What the run says of its own part: the last design.check result when there is one, else the reply's words. */
export interface Claim {
  said: 'pass' | 'fail' | null
  from: 'check' | 'reply' | null
}

export function runClaim(run: { check: boolean | null; reply: string }): Claim {
  if (run.check !== null) return { said: run.check ? 'pass' : 'fail', from: 'check' }
  const said = replyClaim(run.reply)
  return { said, from: said ? 'reply' : null }
}

/**
 * pass, fail, or disagree: the run says its part failed its check while the scorer passes it, or says it passed while
 * the scorer fails the part. Only the scorer's checks make a pass; a disagree is counted on its own, never as a pass.
 * A part the scorer passes that fails on turns alone does not disagree with a run that says its part passed.
 */
export type Verdict = 'pass' | 'fail' | 'disagree'

export function verdictOf(score: { pass: boolean; geometry: boolean }, claim: Claim): Verdict {
  if (claim.said === 'fail' && score.pass) return 'disagree'
  if (claim.said === 'pass' && !score.geometry) return 'disagree'
  return score.pass ? 'pass' : 'fail'
}

/** pass, fail and disagree counts over runs, per case id in the order first seen and overall. */
export function verdictCounts(rows: readonly { id: string; verdict: Verdict }[]): { byCase: Map<string, Record<Verdict, number>>; all: Record<Verdict, number> } {
  const byCase = new Map<string, Record<Verdict, number>>()
  const all: Record<Verdict, number> = { pass: 0, fail: 0, disagree: 0 }
  for (const r of rows) {
    const n = byCase.get(r.id) ?? { pass: 0, fail: 0, disagree: 0 }
    n[r.verdict]++
    all[r.verdict]++
    byCase.set(r.id, n)
  }
  return { byCase, all }
}

/** How far from the hinge's axis a knuckle's wall stands at most, mm: rays out from the axis must meet it within this. */
const KNUCKLE_MM = 8
/** Rays out from the axis at each station, evenly round it. */
const RAYS = 8
/** Stations along the axis, mm apart. */
const STATION_MM = 0.5
/** A rod: its two smaller sizes under this share of its length, and its length at least ROD_MM. */
const ROD_SHARE = 0.25
const ROD_MM = 10

type Axis = { at: V3; dir: V3; from: string }

/** Where a ray from o along d meets triangle `tri[t]` (Moller and Trumbore), as its distance, or -1. */
function rayTriangle(o: V3, d: V3, tri: Float64Array, t: number): number {
  const e1: V3 = [tri[t + 3]! - tri[t]!, tri[t + 4]! - tri[t + 1]!, tri[t + 5]! - tri[t + 2]!]
  const e2: V3 = [tri[t + 6]! - tri[t]!, tri[t + 7]! - tri[t + 1]!, tri[t + 8]! - tri[t + 2]!]
  const p: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
  if (Math.abs(det) < 1e-12) return -1
  const inv = 1 / det
  const sv: V3 = [o[0] - tri[t]!, o[1] - tri[t + 1]!, o[2] - tri[t + 2]!]
  const u = (sv[0] * p[0] + sv[1] * p[1] + sv[2] * p[2]) * inv
  if (u < 0 || u > 1) return -1
  const q: V3 = [sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]]
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv
  if (v < 0 || u + v > 1) return -1
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
}

/**
 * The lines a hinge's pin may run along: each rod among the bodies (a separate pin) along its long side through its
 * middle, and each round hole of the box or the lid (the bore of a knuckle, where a pin built into the other part runs)
 * along its axis. Lines that are one (parallel and within half a millimeter) are kept once.
 */
function hingeAxes(bodies: readonly Body[], box: Body, lid: Body): Axis[] {
  const out: Axis[] = []
  const add = (at: V3, dir: V3, from: string) => {
    const same = out.some((x) => {
      if (Math.abs(Math.abs(x.dir[0] * dir[0] + x.dir[1] * dir[1] + x.dir[2] * dir[2]) - 1) > 1e-3) return false
      const w: V3 = [at[0] - x.at[0], at[1] - x.at[1], at[2] - x.at[2]]
      const along = w[0] * x.dir[0] + w[1] * x.dir[1] + w[2] * x.dir[2]
      return Math.hypot(w[0] - along * x.dir[0], w[1] - along * x.dir[1], w[2] - along * x.dir[2]) < 0.5
    })
    if (!same) out.push({ at, dir, from })
  }
  for (const b of bodies) {
    if (b === box || b === lid) continue
    const size = [0, 1, 2].map((k) => b.max[k]! - b.min[k]!)
    const long = size.indexOf(Math.max(...size))
    const others = size.filter((_, k) => k !== long)
    if (size[long]! < ROD_MM || others.some((x) => x > ROD_SHARE * size[long]!)) continue
    add([0, 1, 2].map((k) => (b.min[k]! + b.max[k]!) / 2) as V3, [0, 1, 2].map((k) => (k === long ? 1 : 0)) as V3, 'a pin')
  }
  for (const [b, name] of [[lid, 'the lid'], [box, 'the box']] as const) {
    const n = b.tri.length / 3
    for (const h of holeLoops({ positions: Array.from(b.tri), indices: Array.from({ length: n }, (_, i) => i) })) add(h.at, h.axis, `a bore in ${name}`)
  }
  return out
}

/** Whether point p is inside body b: an odd number of its faces along a ray from p. */
function inside(b: Body, p: V3): boolean {
  // a slanted ray, so it meets no edge of a part drawn square to the axes
  const d: V3 = [0.2672612, 0.5345225, 0.8017837]
  let n = 0
  for (let t = 0; t < b.tri.length; t += 9) if (rayTriangle(p, d, b.tri, t) > 1e-9) n++
  return n % 2 === 1
}

/** Whether body b wraps the axis at p: every ray out from p, square to the axis, meets b within KNUCKLE_MM. */
function wraps(tri: Float64Array, p: V3, rays: readonly V3[]): boolean {
  return rays.every((d) => {
    for (let t = 0; t < tri.length; t += 9) {
      const h = rayTriangle(p, d, tri, t)
      if (h > 1e-9 && h <= KNUCKLE_MM) return true
    }
    return false
  })
}

/** The triangles of b that come within `reach` of the line through `at` along unit `dir`, by their boxes. */
function nearLine(b: Body, at: V3, dir: V3, reach: number): Float64Array {
  const keep: number[] = []
  for (let t = 0; t < b.tri.length; t += 9) {
    const c: V3 = [0, 1, 2].map((k) => (b.tri[t + k]! + b.tri[t + 3 + k]! + b.tri[t + 6 + k]!) / 3) as V3
    const r = Math.max(...[0, 3, 6].map((j) => Math.hypot(b.tri[t + j]! - c[0], b.tri[t + j + 1]! - c[1], b.tri[t + j + 2]! - c[2])))
    const w: V3 = [c[0] - at[0], c[1] - at[1], c[2] - at[2]]
    const along = w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2]
    if (Math.hypot(w[0] - along * dir[0], w[1] - along * dir[1], w[2] - along * dir[2]) <= reach + r) for (let k = 0; k < 9; k++) keep.push(b.tri[t + k]!)
  }
  return Float64Array.from(keep)
}

/**
 * Whether the box's lid turns on a hinge pin (cases.ts LidSpec): along some line, a pin runs through a knuckle of the
 * box and a knuckle of the lid. The line is a separate pin's, or the bore of a knuckle (hingeAxes). Along it, every
 * half millimeter, a body wraps the line where rays out from it all round meet that body within KNUCKLE_MM, and the
 * pin is the body the line runs inside. It passes when the lid wraps the line around the box's own pin, the box wraps it
 * around the lid's own pin, or one separate pin runs inside both a knuckle of the box and a knuckle of the lid. A lid
 * laid apart, with no pin, or with a pin through one part only, fails.
 */
export function hingeCheck(parts: MeshPart[], stated: LidStated = 'assembled', m?: PilotMachine): Check {
  const found = boxAndLid(parts)
  if ('why' in found) return { pass: false, detail: found.why }
  if (stated === 'apart') return pinMates(found, m)
  const { bodies, box, lid } = found
  const axes = hingeAxes(bodies, box, lid)
  if (!axes.length) return { pass: false, detail: 'no pin and no knuckle bore to read a hinge from' }
  const lo = [0, 1, 2].map((k) => Math.min(box.min[k]!, lid.min[k]!))
  const hi = [0, 1, 2].map((k) => Math.max(box.max[k]!, lid.max[k]!))
  type Seen = { axis: Axis; box: number; lid: number; pin: string | null; held: boolean }
  const seen: Seen[] = []
  for (const axis of axes) {
    const { at, dir } = axis
    // the axis must pass by both bodies, within a knuckle's reach of each box
    const by = (b: Body) => [0, 1, 2].every((k) => dir[k] !== 0 || (at[k]! >= b.min[k]! - KNUCKLE_MM && at[k]! <= b.max[k]! + KNUCKLE_MM))
    if (!by(box) || !by(lid)) continue
    const u0: V3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const uRaw: V3 = [dir[1] * u0[2] - dir[2] * u0[1], dir[2] * u0[0] - dir[0] * u0[2], dir[0] * u0[1] - dir[1] * u0[0]]
    const ul = Math.hypot(...uRaw)
    const u: V3 = [uRaw[0] / ul, uRaw[1] / ul, uRaw[2] / ul]
    const v: V3 = [dir[1] * u[2] - dir[2] * u[1], dir[2] * u[0] - dir[0] * u[2], dir[0] * u[1] - dir[1] * u[0]]
    // off the square directions a little, so no ray runs along a face drawn square to the axes
    const rays = Array.from({ length: RAYS }, (_, i) => {
      const a = 0.1 + (2 * Math.PI * i) / RAYS
      return [0, 1, 2].map((k) => Math.cos(a) * u[k]! + Math.sin(a) * v[k]!) as V3
    })
    const near = new Map(bodies.map((b) => [b, nearLine(b, at, dir, KNUCKLE_MM)] as const))
    // the stations: along the axis over the box and the lid together
    const ends = [0, 1, 2].flatMap((k) => (dir[k] === 0 ? [] : [((lo[k]! - at[k]!) / dir[k]!), ((hi[k]! - at[k]!) / dir[k]!)]))
    const [t0, t1] = [Math.min(...ends), Math.max(...ends)]
    const s: Seen = { axis, box: 0, lid: 0, pin: null, held: false }
    const boxOn = new Set<Body>()
    const lidOn = new Set<Body>()
    for (let t = t0 + STATION_MM / 2; t < t1; t += STATION_MM) {
      const p: V3 = [at[0] + dir[0] * t, at[1] + dir[1] * t, at[2] + dir[2] * t]
      const byBox = wraps(near.get(box)!, p, rays)
      const byLid = wraps(near.get(lid)!, p, rays)
      if (!byBox && !byLid) continue
      // the body the axis runs inside here: the pin, a separate one or one built into a part
      const pin = bodies.find((b) => near.get(b)!.length && inside(b, p))
      if (byBox) s.box += STATION_MM
      if (byLid) s.lid += STATION_MM
      if (pin && byLid && pin !== lid) lidOn.add(pin)
      if (pin && byBox && pin !== box) boxOn.add(pin)
    }
    const shared = [...lidOn].find((b) => boxOn.has(b))
    if (lidOn.has(box)) [s.held, s.pin] = [true, "the box's own pin"]
    else if (boxOn.has(lid)) [s.held, s.pin] = [true, "the lid's own pin"]
    else if (shared) [s.held, s.pin] = [true, 'a separate pin']
    else s.pin = lidOn.size || boxOn.size ? `a pin through the ${lidOn.size ? 'lid' : 'box'} only` : 'no pin'
    seen.push(s)
  }
  const along = (s: Seen) => `${s.axis.from} along ${['x', 'y', 'z'][s.axis.dir.map(Math.abs).indexOf(Math.max(...s.axis.dir.map(Math.abs)))] ?? 'a slant'}`
  const best = seen.find((s) => s.held) ?? [...seen].sort((a, b) => Math.min(b.box, b.lid) - Math.min(a.box, a.lid))[0]
  if (!best) return { pass: false, detail: 'no pin or knuckle bore runs by both the box and the lid' }
  const r = (v: number) => Math.round(v * 10) / 10
  const held = best.held ? `held by ${best.pin}` : best.pin === 'no pin' ? 'no pin runs through the knuckles' : best.pin
  return { pass: best.held, detail: `${along(best)}: the box wraps it over ${r(best.box)} mm and the lid over ${r(best.lid)} mm, ${held}` }
}

/** How much bigger than its pin a bore may be, mm across the gap, and still hold a hinge rather than rattle. */
const LOOSE_MM = 1

/**
 * A hinge whose lid prints apart: a separate pin (a rod among the bodies) that slides into a round bore of the box and
 * a round bore of the lid, each bore wider than the pin by the side gap the fit rule says a sliding fit needs and by no
 * more than LOOSE_MM. A lid with no pin, or a pin that fits only one part, cannot be put on its hinge.
 */
function pinMates({ bodies, box, lid }: { bodies: Body[]; box: Body; lid: Body }, m?: PilotMachine): Check {
  const pins = bodies
    .filter((b) => b !== box && b !== lid)
    .flatMap((b) => {
      const [thin, wide, long] = [0, 1, 2].map((k) => b.max[k]! - b.min[k]!).sort((x, y) => x - y) as [number, number, number]
      return long >= ROD_MM && wide <= ROD_SHARE * long && thin > 0 ? [wide] : []
    })
  if (!pins.length) return { pass: false, detail: 'the lid is planned apart but no separate pin was built, so nothing joins it to the box' }
  const bores = (b: Body) => {
    const n = b.tri.length / 3
    return holeLoops({ positions: Array.from(b.tri), indices: Array.from({ length: n }, (_, i) => i) }).map((h) => h.diameterMm)
  }
  const [inBox, inLid] = [bores(box), bores(lid)]
  const slides = (pin: number, bore: number) => {
    const gap = (bore - pin) / 2
    if (gap <= 0 || gap > LOOSE_MM) return false
    if (!m) return true
    return assessFit({ gapMm: gap + FACET_MM, feature: 'print_in_place', direction: 'xy', layerHeight: m.nozzle / 2, lineWidth: m.nozzle * 1.05, nozzle: m.nozzle, material: m.material }).outcome === 'slides'
  }
  const r = (v: number) => Math.round(v * 100) / 100
  const fits = pins.find((p) => inBox.some((d) => slides(p, d)) && inLid.some((d) => slides(p, d)))
  if (fits !== undefined) return { pass: true, detail: `a ${r(fits)} mm pin slides into a bore of the box and a bore of the lid` }
  const where = (ds: number[]) => (ds.length ? ds.map((d) => `${r(d)} mm`).join(', ') : 'none')
  return { pass: false, detail: `the lid is planned apart, but no pin (${pins.map((p) => `${r(p)} mm`).join(', ')}) slides into both a bore of the box (${where(inBox)}) and one of the lid (${where(inLid)})` }
}

/**
 * Whether a part that holds something is closed at the bottom, each part read as design.check reads a plan that sets a
 * floor (holder-floor.ts, floorItem): no opening through its bottom face but holes up to the size asked for.
 */
export function floorCheck(spec: FloorSpec, parts: readonly MeshPart[]): Check {
  const item = floorItem({ mm: spec.mm, from: 'as asked' }, floorFacts(parts, parts.map((p) => p.name), spec.holeMm ?? 0))
  return { pass: item.pass, detail: item.got }
}

/** One design.check call of a run, as its results row keeps it: the plan it checked, and how it came out. */
export interface CheckCall {
  /** The planId the call named, or null when it named none. */
  planId: string | null
  /** The design it checked, when the check said. */
  design?: string
  /** ok: the check measured the part (pass says how it came out); refused: it did not run, with the reason. */
  result: 'ok' | 'refused' | 'no result'
  pass?: boolean
  /** The names of the items that failed, in the check's order. */
  failed?: string[]
  /** The reason a refused call gave, cut short. */
  why?: string
}

/**
 * Every design.check call of a run in order, with the planId it named and the items that failed, so a run that checks
 * two plans, or one plan twice with different results, shows which plan each check was against.
 */
export function checkCalls(events: readonly PilotEvent[]): CheckCall[] {
  const results = new Map(events.flatMap((e) => (e.type === 'tool_result' ? [[e.callId, e] as const] : [])))
  return events.flatMap((e) => {
    if (e.type !== 'tool_call' || e.tool !== 'design.check') return []
    const planId = (e.input as { planId?: unknown } | null)?.planId
    const call: CheckCall = { planId: typeof planId === 'string' ? planId : null, result: 'no result' }
    const r = results.get(e.callId)
    if (!r) return [call]
    if (r.ok === false) return [{ ...call, result: 'refused' as const, why: (r.summary ?? '').slice(0, 160) }]
    const out = r.output as { design?: unknown; pass?: unknown; items?: { name?: unknown; pass?: unknown }[] } | undefined
    const failed = (out?.items ?? []).filter((i) => i.pass === false).map((i) => String(i.name))
    return [{ ...call, ...(typeof out?.design === 'string' ? { design: out.design } : {}), result: 'ok' as const, ...(typeof out?.pass === 'boolean' ? { pass: out.pass } : {}), failed }]
  })
}

export interface CaseScore {
  built: boolean
  /** The first reply turned the part down. */
  refused: boolean
  ops: Check
  watertight?: Check
  bodies?: Check
  minWall?: Check
  bedFit?: Check
  sizes?: Check
  hook?: Check
  lid?: Check
  hinge?: Check
  floor?: Check
  geometry: boolean
  extra: number
  turns: Check
  /** The scorer's own result: the part's checks and the turns. Only this makes a pass. */
  pass: boolean
  /** What the run said of its own part (the last design.check result, else the final reply's words). */
  claim: Claim
  verdict: Verdict
}

/**
 * Scores a run: `parts` already placed (see placed), `firstReply` the text of the reply to the person's message and
 * `reply` the last reply of the run (the first when not given), which the claim reads when no check returned a result.
 */
export function scoreCase(c: BuildCase, run: { events: readonly PilotEvent[]; turns: readonly UserTurn[]; parts: MeshPart[]; firstReply: string; reply?: string; firstBuilt: boolean; bed: BuildVolume; wallMm: number }): CaseScore {
  const steps = okSteps(run.events)
  const used = [...new Set(steps.filter((s) => s.tool.startsWith('geom.')).map((s) => s.tool))]
  const hit = c.ops.filter((m) => steps.some((s) => matches(s, m)))
  const ops: Check = { pass: hit.length > 0, detail: `${hit.length ? `used ${hit.join(', ')}` : `none of ${c.ops.join(', ')}`}; steps ${used.join(', ') || 'none'}` }
  const parts = c.parts ?? 1
  const extra = extraTurns(run.turns, parts)
  // the plan changes let through, named so a results row shows the run fixed its plan that way
  const changes = run.turns.filter((t) => t.kind === 'amend').length - extra.filter((t) => t.kind === 'amend').length
  const changed = changes ? `, and ${changes === 1 ? 'one plan change' : `${changes} plan changes`}` : ''
  const turns: Check = { pass: extra.length === 0, detail: extra.length ? extra.map((t) => (t.kind === 'nudge' ? `nudge (${t.why})` : t.kind === 'answer' ? `answer "${t.question.slice(0, 40)}"` : t.kind === 'amend' ? 'another plan change' : `another ${t.kind}`)).join(', ') : `${parts > 1 ? `one message, and a sheet and Go for each of ${parts} parts only` : 'one message, sheet and Go only'}${changed}` }
  const refused = !run.firstBuilt && classifyNoBuild(run.firstReply) === 'declined'
  const built = run.parts.length > 0
  const claim = runClaim({ check: lastCheckPass(run.events), reply: run.reply ?? run.firstReply })
  const out: CaseScore = { built, refused, ops, geometry: false, extra: extra.length, turns, pass: false, claim, verdict: 'fail' }
  if (!built) {
    out.verdict = verdictOf(out, claim)
    return out
  }
  const cl = closure(run.parts)
  out.watertight = { pass: cl.watertight, detail: cl.watertight ? 'closed' : `open ${cl.openEdges}, non-manifold ${cl.nonManifoldEdges}, flipped ${cl.flippedEdges}` }
  const n = bodyCount(run.parts)
  out.bodies = { pass: n >= c.bodies[0] && n <= c.bodies[1], detail: `${n} (want ${c.bodies[0]} to ${c.bodies[1]})` }
  const w = minWall(run.parts)
  out.minWall = { pass: w.samples > 0 && w.minWallMm >= run.wallMm, detail: `${w.minWallMm} mm (want ${run.wallMm} mm or more)` }
  const fit = bedFit(run.parts, run.bed)
  out.bedFit = { pass: fit.fits, detail: `${fit.sizeMm.join(' by ')} mm` }
  // each size is read on the largest assembly along it: the part must reach it, and no body or assembly may pass it
  const groups = assemblySizes(run.parts)
  // a hinged lid printed open beside its box is held to the box's height closed, the lid on top (owner, 2026-11-12,
  // the hinged-box case only): the box's height and the lid's added
  const closed = c.lid ? closedHeight(run.parts) : null
  const side = (axis: SizeCheck['axis']): number => (axis === 'z' && closed !== null ? closed : Math.max(0, ...groups.map((g) => sideOf(g, axis))))
  const off = c.sizes.filter((s) => {
    const v = side(s.axis)
    return v < s.minMm || v > s.maxMm
  })
  const shown = groups.length > 1 ? groups.map((g) => g.join(' by ')).join(', ') : sizeOf(run.parts).join(' by ')
  out.sizes = { pass: off.length === 0, detail: `${shown} mm${closed !== null ? `, ${r2z(closed)} mm high closed` : ''}${off.length ? `; off: ${off.map((s) => `${s.axis} ${side(s.axis)} (want ${s.minMm} to ${s.maxMm})`).join(', ')}` : ''}` }
  if (c.hook) out.hook = hookCheck(c.hook, run.parts)
  const stated = lidStated(run.events)
  if (c.lid) out.lid = lidCheck(c.machine, run.parts, stated)
  if (c.lid) out.hinge = hingeCheck(run.parts, stated, c.machine)
  if (c.floor) out.floor = floorCheck(c.floor, run.parts)
  out.geometry = [ops, out.watertight, out.bodies, out.minWall, out.bedFit, out.sizes, ...(out.hook ? [out.hook] : []), ...(out.lid ? [out.lid] : []), ...(out.hinge ? [out.hinge] : []), ...(out.floor ? [out.floor] : [])].every((x) => x.pass)
  out.pass = out.geometry && turns.pass
  out.verdict = verdictOf(out, claim)
  return out
}
