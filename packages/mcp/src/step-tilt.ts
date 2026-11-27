// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.edit_step's tilt: what an extrude, a revolve, a sweep, a loft or an added part (a post, a cylinder) made leans
// one way about its foot (each separate piece of an added part about its own), kept on the step (Step.tilt) so the timeline shows the
// same step edited. The steps built on it (standing on its upper half) lean with it about its foot, in the same edit;
// one that a turn cannot carry (a box cut, a band of paint, a rounded edge) refuses the lean by name. Before it is kept, what the leaning steps make alone, with each copy
// a pattern of them makes, is measured against what each other step makes alone with its copies: a lean that pushes
// one of them into another step's shape, or lifts it off everything it stood on, is refused with that step by name.
// Asked of a pattern or an array step, the lean turns the steps it repeats or the step that made the part it copies.
import { bakeMesh, direction, invert, multiply, nearestFoot, partFeet, partThrough, replayOn, stepCopyMoves, stepName, tiltFoot, withTilt, type Design, type DesignHost, type HistoryMesh, type Mat4, type Step, type StepParams, type StepTilt, type Vec3 } from '@slicerx/cad-history'
import { z } from 'zod'
import { makers } from './part-form'

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

const LEANS = new Set<StepParams['op']>(['shape.extrude', 'sketch.revolve', 'sketch.sweep', 'sketch.loft', 'parts.add'])
const SOLID = new Set<StepParams['op']>(['shape.extrude', 'sketch.loft', 'sketch.revolve', 'sketch.sweep', 'parts.add'])
const r1 = (n: number): number => Math.round(n * 10) / 10

/** How far the step leans toward `t` now, degrees: its lean that way, minus it when it leans the other way, 0 across. */
function leanNow(s: Step, t: Vec3): number {
  if (!s.tilt) return 0
  const k = s.tilt.toward[0] * t[0] + s.tilt.toward[1] * t[1] + s.tilt.toward[2] * t[2]
  return Math.abs(k) > 0.999 ? Math.sign(k) * s.tilt.degrees : 0
}

/** The step with its lean set as asked, and what to say; or why it cannot lean. */
export function tiltedStep(s: Step, t: TiltInput): { step: Step; said: string } | string {
  if (!LEANS.has(s.params.op)) return 'tilt: only what an extrude, a revolve, a sweep, a loft or an added part made leans; change this step another way'
  const toward = direction(s.transform, TOWARD[t.toward])
  const up = direction(s.transform, [0, 0, 1])
  if (s.params.op !== 'parts.add' && !tiltFoot(s.params, up)) return `tilt: ${s.params.op === 'sketch.revolve' ? 'this revolve turns about an axis lying over, so it' : 'this step'} has no foot to lean about; change this step another way`
  const was = leanNow(s, toward)
  const deg = t.degrees ?? was + (t.by ?? 0)
  if (Math.abs(deg) > 60) return `tilt: ${r1(deg)} degrees is past the 60 a step leans`
  const { tilt: _old, ...rest } = s
  const tilt: StepTilt = { degrees: deg, up, toward }
  const other = s.tilt && was === 0 ? ` (its lean the other way, ${r1(s.tilt.degrees)} degrees, is replaced)` : ''
  return { step: deg === 0 ? rest : { ...rest, tilt }, said: `it leans ${r1(deg)} degrees toward ${t.toward} (was ${r1(was)})${other}` }
}

/**
 * Each copy of step s, as the move that lands it in the design's frame: one for each copy every live pattern of it
 * makes, and every merged array of the part it works on or made after it (the array copies the whole part, the step
 * with it), as cad-history patternStep moves them.
 */
function copyMoves(d: Design, s: Step): Mat4[] {
  const steps = d.history.steps
  const i = steps.findIndex((x) => x.id === s.id)
  const out: Mat4[] = []
  for (const [j, x] of steps.entries()) {
    const p = x.params
    if (x.suppressed || (p.op !== 'pattern' && p.op !== 'array.merged')) continue
    const copies = p.op === 'pattern' ? x.part === s.part && p.steps.includes(s.id) : i >= 0 && j > i && (x.part === -1 || (s.part >= 0 ? partThrough(steps, i, j, s.part) === x.part : makers(d, j)[x.part]?.id === s.id))
    if (copies) for (const move of stepCopyMoves(p.spec)) out.push(multiply(invert(x.transform), multiply(move, x.transform)))
  }
  return out
}

/**
 * What the step makes on its own, as new bodies: its own and, with the design, one for each copy a pattern of it or an
 * array of its part makes (copyMoves), so a leaning step leans its copies too and another step's copies stand where
 * they stand. Null when one does not go through alone.
 */
async function alone(host: DesignHost, s: Step, d: Design | null): Promise<HistoryMesh[] | null> {
  const p = withTilt(s).params
  const params = (p.op === 'shape.extrude' ? { ...p, spec: { ...p.spec, operation: 'new' } } : { ...p, operation: 'new' }) as StepParams
  // a copy of an added part is its meshes moved; of any other step, the step run in its own frame moved
  const copies = (d ? copyMoves(d, s) : []).map((m) => (params.op === 'parts.add' ? { transform: s.transform, params: { ...params, parts: params.parts.map((q) => bakeMesh(q, m)) } } : { transform: multiply(s.transform, invert(m)), params }))
  const out: HistoryMesh[] = []
  for (const [k, at] of [{ transform: s.transform, params }, ...copies].entries()) {
    try {
      const r = await replayOn(host, { version: 1, base: [], steps: [{ id: `${s.id}~${k}`, part: 0, ...at }] })
      if (r.status[0]?.state !== 'done' || !r.parts.length) return null
      out.push(...r.parts)
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

/** Whether two steps can meet: on one part, or one of them adds parts of its own. */
const samePart = (a: Step, b: Step): boolean => a.part === b.part || a.part < 0 || b.part < 0

/** One step of a lean: its index, as it was, and as the edit leaves it. */
export interface Leaning {
  k: number
  was: Step
  now: Step
}

const isCut = (x: Step): boolean => (x.params.op === 'shape.extrude' ? x.params.spec.operation === 'cut' : (x.params as { operation?: string }).operation === 'cut')

const spot = (q: Vec3): Box => [q, q]
const span = (a: Vec3, b: Vec3, r = 0): Box => [[Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r], [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r]]

/** Where a step that is not a shape of its own works, as boxes, to tell whether it sits on a leaning step; null for none. */
function workBoxes(x: Step): Box[] | null {
  const p = x.params
  switch (p.op) {
    case 'subtract':
      return p.solids.map((q) => (q.type === 'box' ? span(q.min, q.max) : span(q.origin, [q.origin[0] + q.axis[0] * q.heightMm, q.origin[1] + q.axis[1] * q.heightMm, q.origin[2] + q.axis[2] * q.heightMm], q.diameterMm / 2)))
    case 'edge.fillet':
    case 'edge.chamfer':
      return p.edges.map((e) => span(e.a, e.b))
    case 'face.push':
      return [spot(p.at)]
    case 'hole.apply':
      return [spot(p.hole.entry)]
    case 'paint':
      return p.target.kind === 'seed' ? [spot(p.target.point)] : null
    default:
      return null
  }
}

/**
 * The steps built on step k (standing on its upper half, or on a step that does), each with the lean step k gets,
 * turned about k's foot; or why the lean cannot carry them, naming the step.
 */
export async function carriedSteps(host: DesignHost, d: Design, k: number, now: Step): Promise<Leaning[] | string> {
  const all = d.history.steps
  const was = all[k]!
  const up0 = (now.tilt ?? was.tilt)?.up
  if (!up0) return []
  // steps an earlier lean of this one carried turn about one of its feet: they follow the new lean, or stand up with it
  const feet0: Vec3[] = was.params.op === 'parts.add' ? was.params.parts.flatMap((p) => partFeet(p, up0)) : [tiltFoot(was.params, up0)].filter((f): f is Vec3 => f !== null)
  const carriedBefore = (x: Step): boolean => !!x.tilt?.about && feet0.some((f) => Math.hypot(f[0] - x.tilt!.about![0], f[1] - x.tilt!.about![1], f[2] - x.tilt!.about![2]) < 1e-6)
  const before: Leaning[] = []
  for (let j = k + 1; j < all.length; j++) {
    const x = all[j]!
    if (!carriedBefore(x)) continue
    const { tilt: _t, ...upright } = x
    before.push({ k: j, was: x, now: now.tilt ? { ...x, tilt: { ...now.tilt, about: x.tilt!.about!, ...(x.tilt!.feet ? { feet: x.tilt!.feet } : {}) } } : upright })
  }
  if (!now.tilt) return before
  const base = await alone(host, was, null)
  if (!base?.length) return []
  const up = now.tilt.up
  const height = (m: HistoryMesh): [number, number] => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const h = m.positions[i]! * up[0] + m.positions[i + 1]! * up[1] + m.positions[i + 2]! * up[2]
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
    return [lo, hi]
  }
  // the bodies the carried steps stand on: step k's, then each carried step's, with the middle height above which a
  // step counts as standing on it
  const holders: { body: HistoryMesh; mid: number; box: Box }[] = base.map((b) => {
    const [lo, hi] = height(b)
    return { body: b, mid: (lo + hi) / 2, box: boxOf(b) }
  })
  // the foot each carried step turns about: step k's own, or of the separate pieces of its added parts (each leans
  // about its own foot) the one under what it stood on, nearest the step
  const feet: Vec3[] = was.params.op === 'parts.add' ? was.params.parts.flatMap((p) => partFeet(p, up)) : [tiltFoot(was.params, up)].filter((f): f is Vec3 => f !== null)
  if (!feet.length) return []
  const footFor = (on: Box, mine: Box): Vec3 => {
    const under = feet.filter((f) => near(spot(f), on, 0.05))
    const c: Vec3 = [(mine[0][0] + mine[1][0]) / 2, (mine[0][1] + mine[1][1]) / 2, (mine[0][2] + mine[1][2]) / 2]
    return nearestFoot(under.length ? under : feet, c, up)!
  }
  const out: Leaning[] = [...before]
  for (let j = k + 1; j < all.length; j++) {
    const x = all[j]!
    if (before.some((b) => b.k === j)) continue
    if (x.suppressed || !samePart(x, was) || x.params.op === 'pattern' || x.params.op === 'array.merged' || d.status[j]?.state === 'broken') continue
    if (SOLID.has(x.params.op) && !isCut(x)) {
      const bodies = await alone(host, x, null)
      if (!bodies?.length) continue
      let on: { holder: Box; mine: Box } | null = null
      for (const b of bodies) {
        const [lo] = height(b)
        for (const h of holders) {
          if (lo < h.mid || !near(boxOf(b), h.box, 0.05)) continue
          if ((await meet(host, b, h.body)).touch) on = { holder: h.box, mine: boxOf(b) }
        }
      }
      if (!on) continue
      if (x.tilt) return `tilt: step ${j + 1}, ${stepName(x)}, stands on it and leans on its own; stand it upright first, or lean it with its own step`
      // an added part carried by separate pieces: each of its pieces turns about the foot it stands over
      const each = x.params.op === 'parts.add' && feet.length > 1 ? { feet } : {}
      out.push({ k: j, was: x, now: { ...x, tilt: { ...now.tilt!, about: footFor(on.holder, on.mine), ...each } } })
      for (const b of bodies) {
        const [lo, hi] = height(b)
        holders.push({ body: b, mid: (lo + hi) / 2, box: boxOf(b) })
      }
      continue
    }
    // a step that is not a shape of its own (a cut, paint, a rounded edge) on a leaning step cannot turn with it
    // it works on the upper half of what leans: its box meets that half
    const boxes = workBoxes(x)
    const sits = !!boxes?.length && holders.some((h) => boxes.some((b) => b[1][2] >= h.mid && near(b, [[h.box[0][0], h.box[0][1], h.mid], h.box[1]], 0.3)))
    // a band of paint by height on what leans: the band stays level while the part turns under it
    const t = x.params.op === 'paint' && x.params.target.kind === 'height' ? x.params.target : null
    const banded = !!t && holders.some((h) => (t.to ?? t.below ?? Infinity) > h.mid && (t.from ?? t.above ?? -Infinity) < h.box[1][2])
    if (sits || banded) return `tilt: step ${j + 1}, ${stepName(x)}, works on it and cannot lean with it; remove or change that step first, or lean another way`
  }
  return out
}

/**
 * Why the lean cannot be kept: the steps whose shapes the leaning ones now run into, or that they no longer stand on;
 * null when it can.
 */
export async function tiltProblem(host: DesignHost, d: Design, group: readonly Leaning[]): Promise<string | null> {
  const all = d.history.steps
  const members = new Set(group.map((g) => g.k))
  const lead = group[0]!
  const before: HistoryMesh[] = []
  const after: HistoryMesh[] = []
  for (const g of group) {
    const [b, a] = await Promise.all([alone(host, g.was, d), alone(host, g.now, d)])
    if (!a) return `tilt: leaning that far, step ${g.k + 1} no longer goes through on its own; lean it less`
    if (!b || b.length !== a.length) return null
    before.push(...b)
    after.push(...a)
  }
  const reach = after.map(boxOf)
  const hits: string[] = []
  for (const [c, mine] of before.entries()) {
    const own = volume(mine)
    let stood = 0
    let stands = 0
    for (const [j, x] of all.entries()) {
      if (members.has(j) || x.suppressed || !samePart(x, lead.was) || !SOLID.has(x.params.op) || isCut(x) || d.status[j]?.state === 'broken') continue
      for (const them of (await alone(host, x, d)) ?? []) {
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
    if (!hits.length && stood > 0 && stands === 0 && c === 0) return 'tilt: leaning that way lifts it off what it stood on; lean it less'
  }
  if (hits.length) return `tilt: leaning that way runs it into ${hits.join(' and ')}; lean it less, the other way, or move it first`
  return null
}

/**
 * The steps a lean asked of step k turns, with how they stand to it: the step itself; for a pattern, the steps it
 * repeats that lean (each copy then leans about its own foot, as a pattern of a leaning step does); for a merged array,
 * the step that made the part it copies; for separate copies, they and the step that made the part they copy (copy 1).
 * Or why none can lean.
 */
function leanLeads(d: Design, k: number): { k: number; how?: string }[] | string {
  const all = d.history.steps
  const s = all[k]!
  const p = s.params
  if (p.op === 'pattern') {
    const leads = p.steps.map((id) => all.findIndex((x) => x.id === id)).filter((j) => j >= 0 && !all[j]!.suppressed && LEANS.has(all[j]!.params.op))
    return leads.length ? leads.map((j) => ({ k: j, how: 'which it repeats' })) : 'tilt: none of the steps this pattern repeats can lean; change it another way'
  }
  const made = p.op === 'array.merged' ? s.part : p.op === 'parts.add' && p.copyOf ? p.copyOf.part : null
  if (made === null) return [{ k }]
  const own = p.op === 'parts.add' ? [{ k }] : []
  const maker = made >= 0 ? makers(d, k)[made] : null
  const j = maker ? all.findIndex((x) => x.id === maker.id) : -1
  if (j < 0) return own.length ? own : 'tilt: this array copies a part no step made (it came in as a mesh), so nothing in it leans; change it another way'
  return [...own, { k: j, how: 'which made the part it copies' }]
}

/**
 * design.edit_step's tilt of step k, as `next` (step k with this edit's other changes so far): every step it leans
 * (leanLeads) with the lean asked, the steps built on each, and what to say; or why it cannot be kept.
 */
export async function leanEdit(host: DesignHost, d: Design, k: number, next: Step, t: TiltInput): Promise<{ group: Leaning[]; said: string[] } | string> {
  const leads = leanLeads(d, k)
  if (typeof leads === 'string') return leads
  const all = d.history.steps
  const group: Leaning[] = []
  const said: string[] = []
  const carried: number[] = []
  for (const lead of leads) {
    if (group.some((g) => g.k === lead.k)) continue
    const was = lead.k === k ? next : all[lead.k]!
    const r = tiltedStep(was, t)
    const name = `step ${lead.k + 1}, ${stepName(was)}`
    if (typeof r === 'string') return lead.how ? `tilt: ${name}, ${lead.how}, cannot lean: ${r.replace(/^tilt: /, '')}` : r
    const c = await carriedSteps(host, d, lead.k, r.step)
    if (typeof c === 'string') return c
    group.push({ k: lead.k, was, now: r.step }, ...c.filter((x) => !group.some((g) => g.k === x.k)))
    said.push(lead.how ? `${name}, ${lead.how}, ${r.said.replace(/^it /, '')}` : r.said)
    carried.push(...c.map((x) => x.k).filter((j) => !carried.includes(j)))
  }
  const why = await tiltProblem(host, d, group)
  if (why) return why
  if (carried.length) said.push(`${carried.length === 1 ? 'step' : 'steps'} ${carried.map((j) => j + 1).join(', ')} built on it ${carried.length === 1 ? 'leans' : 'lean'} with it`)
  return { group, said }
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
