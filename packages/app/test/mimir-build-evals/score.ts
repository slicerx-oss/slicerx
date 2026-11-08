// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores one build eval run on two counts. Geometry: the steps a good build uses ran, the part is one closed solid (or
// the bodies the case allows), its walls print, it fits the bed and its main sizes are near the request. Turns: the
// person sends one message, confirms the dimension sheet once and presses Go on the plan once; any other answer,
// question card or nudge is an extra turn, and one extra turn fails the run however good the part is.
import type { MeshPart, PilotEvent } from '@slicerx/contracts'
import { bedFit, bodyCount, closure, minWall, type BuildVolume } from '../../../pilot/evals/creative/mesh-checks'
import type { BuildCase, OpMatch, SizeCheck } from './cases'

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

// the same reading as the creative eval (packages/pilot evals/creative/run.ts classifyNoBuild), plus the ways a reply
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
  const size = sizeOf(run.parts)
  const off = c.sizes.filter((s) => {
    const v = sideOf(size, s.axis)
    return v < s.minMm || v > s.maxMm
  })
  out.sizes = { pass: off.length === 0, detail: `${size.join(' by ')} mm${off.length ? `; off: ${off.map((s) => `${s.axis} ${sideOf(size, s.axis)} (want ${s.minMm} to ${s.maxMm})`).join(', ')}` : ''}` }
  out.geometry = [ops, out.watertight, out.bodies, out.minWall, out.bedFit, out.sizes].every((x) => x.pass)
  out.pass = out.geometry && turns.pass
  return out
}
