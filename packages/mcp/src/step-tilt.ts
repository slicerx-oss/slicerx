// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's tilt: what an extrude or a loft made leans one way about its foot, kept on the step (Step.tilt)
// so the timeline shows the same step edited. Before it is kept, what the step makes alone, with each copy a pattern
// of it makes, is measured against what each other step makes alone with its copies: a lean that pushes the step or a
// copy into another step's shape, or lifts it off everything it stood on, is refused with the step it hits by name.
import { direction, invert, multiply, replayHistory, stepCopyMoves, stepName, withTilt, type Design, type DesignHost, type HistoryMesh, type Step, type StepParams, type StepTilt, type Vec3 } from '@slicerx/cad-history'
import { z } from 'zod'

export const TILT_TOWARD = ['x', '-x', 'y', '-y'] as const
export type TiltToward = (typeof TILT_TOWARD)[number]
const TOWARD: Record<TiltToward, Vec3> = { x: [1, 0, 0], '-x': [-1, 0, 0], y: [0, 1, 0], '-y': [0, -1, 0] }

export const tiltInput = z
  .object({
    toward: z.enum(TILT_TOWARD).describe('The way its top leans, along the design axes: x, -x, y or -y'),
    degrees: z.number().min(-60).max(60).optional().describe('Its lean from upright that way, degrees; 0 stands it upright'),
    by: z.number().min(-60).max(60).optional().describe('Degrees more than it leans that way now (negative: less)'),
  })
  .refine((t) => (t.degrees === undefined) !== (t.by === undefined), { message: 'give degrees or by, one of them' })

export type TiltInput = z.infer<typeof tiltInput>

const LEANS = new Set<StepParams['op']>(['shape.extrude', 'sketch.loft'])
const SOLID = new Set<StepParams['op']>(['shape.extrude', 'sketch.loft', 'sketch.revolve', 'sketch.sweep'])
const r1 = (n: number): number => Math.round(n * 10) / 10

/** How far the step leans toward `t` now, degrees: its lean that way, minus it when it leans the other way, 0 across. */
function leanNow(s: Step, t: Vec3): number {
  if (!s.tilt) return 0
  const k = s.tilt.toward[0] * t[0] + s.tilt.toward[1] * t[1] + s.tilt.toward[2] * t[2]
  return Math.abs(k) > 0.999 ? Math.sign(k) * s.tilt.degrees : 0
}

/** The step with its lean set as asked, and what to say; or why it cannot lean. */
export function tiltedStep(s: Step, t: TiltInput): { step: Step; said: string } | string {
  if (!LEANS.has(s.params.op)) return 'tilt: only what an extrude or a loft made leans; change this step another way'
  const toward = direction(s.transform, TOWARD[t.toward])
  const up = direction(s.transform, [0, 0, 1])
  const was = leanNow(s, toward)
  const deg = t.degrees ?? was + (t.by ?? 0)
  if (Math.abs(deg) > 60) return `tilt: ${r1(deg)} degrees is past the 60 a step leans`
  const { tilt: _old, ...rest } = s
  const tilt: StepTilt = { degrees: deg, up, toward }
  const other = s.tilt && was === 0 ? ` (its lean the other way, ${r1(s.tilt.degrees)} degrees, is replaced)` : ''
  return { step: deg === 0 ? rest : { ...rest, tilt }, said: `it leans ${r1(deg)} degrees toward ${t.toward} (was ${r1(was)})${other}` }
}

/**
 * What the step makes on its own, as new bodies: its own, and one for each copy every live pattern of it on its part
 * makes, so a leaning step leans its copies too and another step's copies stand where they stand. Null when one does
 * not go through alone.
 */
async function alone(host: DesignHost, s: Step, steps: readonly Step[]): Promise<HistoryMesh[] | null> {
  const p = withTilt(s).params
  const params = (p.op === 'shape.extrude' ? { ...p, spec: { ...p.spec, operation: 'new' } } : { ...p, operation: 'new' }) as StepParams
  const at = [s.transform]
  for (const x of steps) {
    if (x.params.op !== 'pattern' || x.suppressed || x.part !== s.part || !x.params.steps.includes(s.id)) continue
    const fromWorld = invert(x.transform)
    // each copy as the pattern lands it: the step's own frame moved by the copy's move (cad-history patternStep)
    for (const move of stepCopyMoves(x.params.spec)) at.push(multiply(s.transform, invert(multiply(fromWorld, multiply(move, x.transform)))))
  }
  const out: HistoryMesh[] = []
  for (const [k, transform] of at.entries()) {
    try {
      const r = await replayHistory((op, request) => host.call(op, request), { history: { version: 1, base: [], steps: [{ id: `${s.id}~${k}`, part: 0, transform, params }] } })
      if (r.status[0]?.state !== 'done' || !r.parts[0]) return null
      out.push(r.parts[0])
    } catch {
      return null
    }
  }
  return out
}

type Box = [Vec3, Vec3]
function boxOf(m: HistoryMesh): Box {
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.positions.length; i++) {
    const v = m.positions[i]!
    const a = i % 3
    if (v < lo[a]!) lo[a] = v
    if (v > hi[a]!) hi[a] = v
  }
  return [lo, hi]
}
const near = (a: Box, b: Box, gap: number): boolean => [0, 1, 2].every((i) => a[0][i]! - gap <= b[1][i]! && b[0][i]! - gap <= a[1][i]!)

function volume(m: HistoryMesh): number {
  let v = 0
  const p = m.positions
  const ix = m.indices
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = ix[t]! * 3
    const b = ix[t + 1]! * 3
    const c = ix[t + 2]! * 3
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return Math.abs(v / 6)
}

/** How two bodies meet: the volume they share, and whether they touch at all. */
async function meet(host: DesignHost, a: HistoryMesh, b: HistoryMesh): Promise<{ shared: number; touch: boolean }> {
  const mesh = (m: HistoryMesh) => ({ positions: Array.from(m.positions), indices: Array.from(m.indices) })
  const r = (await host.call('interference', { a: { mesh: mesh(a) }, b: { mesh: mesh(b) } })) as Record<string, unknown>
  const shared = r['interferes'] === true ? Number(r['overlapMm3'] ?? 0) : 0
  return { shared, touch: r['interferes'] === true || Number(r['clearanceMm'] ?? 1) < 0.05 }
}

/**
 * Why the lean cannot be kept: the steps whose shapes the leaning one now runs into, or that it no longer stands on;
 * null when it can. `was` is the step before the edit, `now` after it.
 */
export async function tiltProblem(host: DesignHost, d: Design, k: number, was: Step, now: Step): Promise<string | null> {
  const all = d.history.steps
  const [before, after] = await Promise.all([alone(host, was, all), alone(host, now, all)])
  if (!after) return 'tilt: leaning that far, the step no longer goes through on its own; lean it less'
  if (!before || before.length !== after.length) return null
  const reach = after.map(boxOf)
  const hits: string[] = []
  for (const [c, mine] of before.entries()) {
    const own = volume(mine)
    let stood = 0
    let stands = 0
    for (const [j, x] of all.entries()) {
      if (j === k || x.suppressed || x.part !== was.part || !SOLID.has(x.params.op) || d.status[j]?.state === 'broken') continue
      const cut = x.params.op === 'shape.extrude' ? x.params.spec.operation === 'cut' : (x.params as { operation?: string }).operation === 'cut'
      if (cut) continue
      for (const them of (await alone(host, x, all)) ?? []) {
        const was0 = near(boxOf(them), boxOf(mine), 0.05)
        if (!near(boxOf(them), reach[c]!, 1)) {
          if (was0) stood++
          continue
        }
        const [m0, m1] = await Promise.all([meet(host, mine, them), meet(host, after[c]!, them)])
        if (m0.touch) stood++
        if (m1.touch) stands++
        // what it stood on takes the dip of its foot as it turns; anything else takes next to nothing
        const more = m1.shared - m0.shared
        const name = `step ${j + 1}, ${stepName(x)}`
        if (more > 0.5 && more > own * (m0.touch ? 0.25 : 0.02) && !hits.some((h) => h.startsWith(name))) hits.push(`${name}${c ? ` (copy ${c + 1})` : ''}`)
      }
    }
    if (!hits.length && stood > 0 && stands === 0) return `tilt: leaning that way lifts ${c ? `copy ${c + 1}` : 'it'} off what it stood on; lean it less`
  }
  if (hits.length) return `tilt: leaning that way runs it into ${hits.join(' and ')}; lean it less, the other way, or move it first`
  return null
}

/** A leaning step's lean for the steps list: degrees and the way it leans, as the tilt edit takes them. */
export function leanRow(s: Step): { leans: { degrees: number; toward: TiltToward | 'across' } } | Record<string, never> {
  if (!s.tilt) return {}
  const way = TILT_TOWARD.find((w) => {
    const t = direction(s.transform, TOWARD[w])
    return t[0] * s.tilt!.toward[0] + t[1] * s.tilt!.toward[1] + t[2] * s.tilt!.toward[2] > 0.999
  })
  return { leans: { degrees: r1(s.tilt.degrees), toward: way ?? 'across' } }
}
