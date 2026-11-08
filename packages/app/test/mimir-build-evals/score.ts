// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores one build eval run on two counts. Geometry: the steps a good build uses ran, the part is one closed solid (or
// the bodies the case allows), its walls print, it fits the bed and its main sizes are near the request, read on each
// body or assembly rather than on the plate, since parts are laid out apart to print. Turns: the
// person sends one message, confirms the dimension sheet once and presses Go on the plan once; any other answer,
// question card or nudge is an extra turn, and one extra turn fails the run however good the part is.
import type { MeshPart, PilotEvent } from '@slicerx/contracts'
import { bedFit, bodyBoxes, bodyCount, closure, minWall, type BuildVolume } from '../../../mcp/evals/creative/mesh-checks'
import { frameFor } from '../../../mcp/src/cad'
import type { BuildCase, HookSpec, OpMatch, SizeCheck } from './cases'

export interface Check {
  pass: boolean
  detail: string
}

/** Something the person did in the run, in order. The first message, one sheet confirm and one Go are free. */
export type UserTurn =
  | { kind: 'message'; text: string }
  | { kind: 'sheet'; title: string }
  | { kind: 'go'; part: string }
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

/** Every extra turn: answers to questions, nudges, and any sheet or Go after the first. */
export function extraTurns(turns: readonly UserTurn[]): UserTurn[] {
  let sheets = 0
  let gos = 0
  return turns.filter((t, i) => {
    if (t.kind === 'message') return i > 0
    if (t.kind === 'sheet') return ++sheets > 1
    if (t.kind === 'go') return ++gos > 1
    return true
  })
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

type Box = { min: [number, number, number]; max: [number, number, number] }
/**
 * Bodies whose boxes come this close count as one assembly (a lid sitting on its box, a hook on its stem), mm; parts
 * laid out to print sit further apart.
 */
const TOUCH_MM = 0.1

/**
 * The size of each assembly on the plate: bodies whose boxes touch or overlap go together, as a lid sitting on its box
 * or a hook joined onto a stem do, while a part laid flat apart for printing (a lid beside its box) is its own.
 */
export function assemblySizes(parts: readonly MeshPart[]): [number, number, number][] {
  const boxes = bodyBoxes([...parts]) as Box[]
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const near = (a: Box, b: Box) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + TOUCH_MM && b.min[k]! <= a.max[k]! + TOUCH_MM)
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

/** A loft profile on a level plane as a ring: its height, center and half its widest side, else null. */
function ringOf(p: unknown): Ring | null {
  const prof = p as { frame?: { origin?: V3; normal?: V3; u?: V3 }; loops?: unknown[] } | null
  const loop = prof?.loops?.[0] as { type?: string; center?: [number, number]; diameterMm?: number; points?: [number, number][]; start?: [number, number]; segments?: { to?: [number, number] }[] } | undefined
  if (!loop) return null
  const f = prof?.frame?.origin && prof.frame.normal ? frameFor(prof.frame.origin, prof.frame.normal, prof.frame.u) : { origin: [0, 0, 0] as V3, normal: [0, 0, 1] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3 }
  if (Math.abs(f.normal[2]) < 0.99) return null
  const at = ([a, b]: [number, number]): [number, number] => [f.origin[0] + a * f.u[0] + b * f.v[0], f.origin[1] + a * f.u[1] + b * f.v[1]]
  if (loop.type === 'circle' && loop.center && loop.diameterMm) return { z: f.origin[2], c: at(loop.center), r: loop.diameterMm / 2 }
  const pts = (loop.points ?? (loop.start ? [loop.start, ...(loop.segments ?? []).flatMap((g) => (g.to ? [g.to] : []))] : [])).map(at)
  if (pts.length < 3) return null
  const xs = pts.map((q) => q[0])
  const ys = pts.map((q) => q[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return { z: f.origin[2], c: [(x0 + x1) / 2, (y0 + y1) / 2], r: Math.max(x1 - x0, y1 - y0) / 2 }
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
 * Whether the part's hook holds what hangs on it (cases.ts HookSpec). lip reads the stem from the tallest loft that ran
 * on level profiles and added material, so it needs one; leg reads the rod from the part itself.
 */
export function hookCheck(spec: HookSpec, steps: readonly { tool: string; input: unknown }[], parts: readonly MeshPart[]): Check {
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
  // the stem is a loft that adds material: a lofted cut (a bore) is not it
  const lofts = steps.filter((s) => s.tool === 'geom.loft' && (s.input as { operation?: string } | null)?.operation !== 'cut').map((s) => ((s.input as { profiles?: unknown[] } | null)?.profiles ?? []).map(ringOf))
  const rings = lofts.filter((l) => l.length >= 2 && l.every((r) => r)).map((l) => (l as Ring[]).sort((a, b) => a.z - b.z)).sort((a, b) => b.at(-1)!.z - b[0]!.z - (a.at(-1)!.z - a[0]!.z))[0]
  if (!rings) return { pass: false, detail: 'no loft on level profiles to read the stem from' }
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
  return { pass: side && lip, detail: `${side ? 'leaves the stem side below its top' : 'meets the stem only at its top'}; tip ${lip ? 'rises' : 'rises only'} ${round1(rise)} mm above the hook's lowest point near the end (want 3 mm or more)` }
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
  pass: boolean
}

/** Scores a run: `parts` already placed (see placed), `firstReply` the text of the reply to the person's message. */
export function scoreCase(c: BuildCase, run: { events: readonly PilotEvent[]; turns: readonly UserTurn[]; parts: MeshPart[]; firstReply: string; firstBuilt: boolean; bed: BuildVolume; wallMm: number }): CaseScore {
  const steps = okSteps(run.events)
  const used = [...new Set(steps.filter((s) => s.tool.startsWith('geom.')).map((s) => s.tool))]
  const hit = c.ops.filter((m) => steps.some((s) => matches(s, m)))
  const ops: Check = { pass: hit.length > 0, detail: `${hit.length ? `used ${hit.join(', ')}` : `none of ${c.ops.join(', ')}`}; steps ${used.join(', ') || 'none'}` }
  const extra = extraTurns(run.turns)
  const turns: Check = { pass: extra.length === 0, detail: extra.length ? extra.map((t) => (t.kind === 'nudge' ? `nudge (${t.why})` : t.kind === 'answer' ? `answer "${t.question.slice(0, 40)}"` : `another ${t.kind}`)).join(', ') : 'one message, sheet and Go only' }
  const refused = !run.firstBuilt && classifyNoBuild(run.firstReply) === 'declined'
  const built = run.parts.length > 0
  const out: CaseScore = { built, refused, ops, geometry: false, extra: extra.length, turns, pass: false }
  if (!built) return out
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
  if (c.hook) out.hook = hookCheck(c.hook, steps, run.parts)
  out.geometry = [ops, out.watertight, out.bodies, out.minWall, out.bedFit, out.sizes, ...(out.hook ? [out.hook] : [])].every((x) => x.pass)
  out.pass = out.geometry && turns.pass
  return out
}
