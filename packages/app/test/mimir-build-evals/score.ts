// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores one build eval run on two counts. Geometry: the steps a good build uses ran, the part is one closed solid (or
// the bodies the case allows), its walls print, it fits the bed and its main sizes are near the request, read on each
// body or assembly rather than on the plate, since parts are laid out apart to print. Turns: the
// person sends one message, confirms the dimension sheet once and presses Go on the plan once (once for each part
// when the message asks for separate parts); any other answer, question card or nudge is an extra turn, and one extra
// turn fails the run however good the part is. The run's verdict is pass or fail from those checks alone, or disagree
// when what the run says of its own part (its last design.check result, else its reply) contradicts them.
import type { MeshPart, PilotEvent } from '@slicerx/contracts'
import { bedFit, bodyBoxes, bodyCount, closure, minWall, type BuildVolume } from '../../../mcp/evals/creative/mesh-checks'
import type { BuildCase, HookSpec, OpMatch, SizeCheck } from './cases'

export interface Check {
  pass: boolean
  detail: string
}

/**
 * Something the person did in the run, in order. The first message, one sheet confirm and one Go are free, or one sheet
 * and one Go for each part when the message asks for separate parts. A Go names the plan it approved, and the design
 * that plan was built in once a step built it (the drive reads the tie after the run).
 */
export type UserTurn =
  | { kind: 'message'; text: string }
  | { kind: 'sheet'; title: string }
  | { kind: 'go'; part: string; plan: string; design?: string }
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
 */
export function extraTurns(turns: readonly UserTurn[], parts = 1): UserTurn[] {
  const extra = new Set<number>()
  const gos = new Set<string>()
  turns.forEach((t, i) => {
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
  return turns.filter((t, i) => (t.kind === 'message' ? i > 0 : t.kind === 'sheet' || t.kind === 'go' ? extra.has(i) : true))
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

type V3 = [number, number, number]
type Ring = { z: number; c: [number, number]; r: number }

/** Sectors around the stem's axis that a ring of its side must reach, so a hook reaching out one side is not read as stem. */
const SECTORS = 12
/** Height of each ring read off the stem, mm: more than the spacing of surfacePoints along a long side (up to 60 a side). */
const RING_MM = 5

/**
 * The stem read from the part itself, whatever made it (a loft, a revolve, an extrude): rings of its outer side at
 * each height around a vertical axis through the middle of the part halfway up. A ring's radius is the median of its
 * farthest points in each sector, so a hook or arm on one side does not widen it; the stem is the run of round rings
 * that go all the way round and are no wider than half again its width halfway up, which leaves out a wide base under
 * it and whatever stands on its top. `hollow` when its side has a bore inside it halfway up. Null when there is no such column.
 */
function stemOf(pts: readonly V3[]): { rings: Ring[]; hollow: boolean } | null {
  const z0 = least(pts, (q) => q[2])
  const z1 = most(pts, (q) => q[2])
  const h = z1 - z0
  if (h < 20) return null
  const mid = pts.filter((q) => q[2] > z0 + 0.4 * h && q[2] < z0 + 0.6 * h)
  if (!mid.length) return null
  const c: [number, number] = [(least(mid, (q) => q[0]) + most(mid, (q) => q[0])) / 2, (least(mid, (q) => q[1]) + most(mid, (q) => q[1])) / 2]
  const d = (q: V3) => Math.hypot(q[0] - c[0], q[1] - c[1])
  const sector = (q: V3) => Math.min(SECTORS - 1, Math.floor(((Math.atan2(q[1] - c[1], q[0] - c[0]) + Math.PI) / (2 * Math.PI)) * SECTORS))
  // each ring: the median of the farthest point in each sector, or null when a sector has none
  const bins = Math.ceil(h / RING_MM)
  const far: number[][] = Array.from({ length: bins }, () => new Array<number>(SECTORS).fill(-1))
  for (const q of pts) {
    const b = Math.min(bins - 1, Math.floor((q[2] - z0) / RING_MM))
    const k = sector(q)
    far[b]![k] = Math.max(far[b]![k]!, d(q))
  }
  // a ring is round: its lower and upper quartile sectors agree, so an arm out one side does not spoil it, while a
  // part across the axis (an arm laid over the stem's top) is not read as stem
  const radius = far.map((f) => {
    if (f.some((r) => r < 0)) return null
    const o = [...f].sort((a, b) => a - b)
    return o[(3 * SECTORS) / 4 - 1]! <= o[SECTORS / 4 - 1]! * 1.25 ? o[SECTORS / 2]! : null
  })
  const half = Math.floor(bins / 2)
  const width = radius[half]
  if (width == null) return null
  const isStem = (r: number | null) => r !== null && r <= width * 1.5
  let lo = half
  let hi = half
  while (lo > 0 && isStem(radius[lo - 1]!)) lo--
  while (hi < bins - 1 && isStem(radius[hi + 1]!)) hi++
  // the end rings are cut through by the base's top and the stem's own top: read the rings inside them
  const rings: Ring[] = []
  for (let b = Math.min(lo + 1, hi); b <= Math.max(hi - 1, lo); b++) rings.push({ z: z0 + (b + 0.5) * RING_MM, c, r: radius[b]! })
  if (rings.length < 2) return null
  // a bore: points of the side well inside the stem's outer radius, all the way round, halfway up
  const ring = pts.filter((q) => Math.floor((q[2] - z0) / RING_MM) === half)
  const inner = new Set(ring.filter((q) => d(q) < width - 1 && d(q) > 0.5).map(sector))
  return { rings, hollow: inner.size === SECTORS }
}

/** Points over every triangle of the parts, about 1.5 mm apart, so a long straight side is read along its length too. */
function surfacePoints(parts: readonly MeshPart[]): V3[] {
  const out: V3[] = []
  for (const p of parts) {
    const at = (i: number): V3 => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!]
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const [a, b, c] = [at(p.indices[t]!), at(p.indices[t + 1]!), at(p.indices[t + 2]!)]
      const edge = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]))
      const n = Math.min(60, Math.max(1, Math.ceil(edge / 1.5)))
      for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) out.push([0, 1, 2].map((k) => a[k]! + ((b[k]! - a[k]!) * i) / n + ((c[k]! - a[k]!) * j) / n) as V3)
    }
  }
  return out
}
const round1 = (v: number): number => Math.round(v * 10) / 10
/** The largest and smallest of `of` over `xs`, without spreading a large array into arguments. */
const most = <T,>(xs: readonly T[], of: (x: T) => number): number => xs.reduce((m, x) => Math.max(m, of(x)), -Infinity)
const least = <T,>(xs: readonly T[], of: (x: T) => number): number => xs.reduce((m, x) => Math.min(m, of(x)), Infinity)

/**
 * Whether the part's hook holds what hangs on it (cases.ts HookSpec). lip reads the stem from the part itself (stemOf),
 * so a revolved, lofted or extruded stem is judged by its shape, and says whether it tapers and is hollow; leg reads the
 * rod from the part itself.
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
  const stem = stemOf(pts)
  if (!stem) return { pass: false, detail: 'no round column to read the stem from' }
  const rings = stem.rings
  const bottom = rings[0]!
  const top = rings.at(-1)!
  // the stem's outer radius at a height, between its profiles and held at the ends
  const radius = (z: number): number => {
    if (z <= bottom.z) return bottom.r
    for (let k = 1; k < rings.length; k++) if (z <= rings[k]!.z) return rings[k - 1]!.r + ((rings[k]!.r - rings[k - 1]!.r) * (z - rings[k - 1]!.z)) / (rings[k]!.z - rings[k - 1]!.z)
    return top.r
  }
  const d = (q: V3) => Math.hypot(q[0] - top.c[0], q[1] - top.c[1])
  const hook = pts.filter((q) => q[2] > bottom.z + 5 && d(q) > radius(q[2]) + 1.5)
  if (!hook.length) return { pass: false, detail: 'nothing reaches out past the stem' }
  const side = hook.some((q) => q[2] < top.z - 3 && d(q) < radius(q[2]) + 6)
  // the top of the hook along its reach: a lip is a tip that rises again past the lowest top in the outer half
  const near = least(hook, d)
  const far = most(hook, d)
  const tops = new Map<number, number>()
  for (const q of hook) {
    const r = d(q)
    if (r < (near + far) / 2) continue
    const bin = Math.floor(r / 2)
    tops.set(bin, Math.max(tops.get(bin) ?? -Infinity, q[2]))
  }
  // the top at the very end of the reach against the lowest top on the way out to it
  const tip = tops.get(Math.floor(far / 2)) ?? -Infinity
  const rise = tip - Math.min(...tops.values())
  const lip = rise >= 3
  const across = (r: number) => Math.round(2 * r)
  const shape = `stem ${across(bottom.r) > across(top.r) ? 'tapers' : 'runs'} from ${across(bottom.r)} to ${across(top.r)} mm across, ${stem.hollow ? 'hollow' : 'solid'}`
  return { pass: side && lip, detail: `${shape}; ${side ? 'leaves the stem side below its top' : 'meets the stem only at its top'}; tip ${lip ? 'rises' : 'rises only'} ${round1(rise)} mm above the hook's lowest point near the end (want 3 mm or more)` }
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
  const turns: Check = { pass: extra.length === 0, detail: extra.length ? extra.map((t) => (t.kind === 'nudge' ? `nudge (${t.why})` : t.kind === 'answer' ? `answer "${t.question.slice(0, 40)}"` : `another ${t.kind}`)).join(', ') : parts > 1 ? `one message, and a sheet and Go for each of ${parts} parts only` : 'one message, sheet and Go only' }
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
  const side = (axis: SizeCheck['axis']): number => Math.max(0, ...groups.map((g) => sideOf(g, axis)))
  const off = c.sizes.filter((s) => {
    const v = side(s.axis)
    return v < s.minMm || v > s.maxMm
  })
  const shown = groups.length > 1 ? groups.map((g) => g.join(' by ')).join(', ') : sizeOf(run.parts).join(' by ')
  out.sizes = { pass: off.length === 0, detail: `${shown} mm${off.length ? `; off: ${off.map((s) => `${s.axis} ${side(s.axis)} (want ${s.minMm} to ${s.maxMm})`).join(', ')}` : ''}` }
  if (c.hook) out.hook = hookCheck(c.hook, run.parts)
  out.geometry = [ops, out.watertight, out.bodies, out.minWall, out.bedFit, out.sizes, ...(out.hook ? [out.hook] : [])].every((x) => x.pass)
  out.pass = out.geometry && turns.pass
  out.verdict = verdictOf(out, claim)
  return out
}
