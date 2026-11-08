// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval's design host: designs kept in memory and replayed on the eval's geometry engine with the CAD
// history's replay (@slicerx/cad-history replayHistory), so the tab's design tools build real feature history here as
// they do on the app's plate. A step lands only when it goes through; a broken one is dropped with its reason, as in
// the app. Finished sketches go in a timeline of the host's own.
//
// Ids are counted, not timed: a design is d1, d2..., a step's id has the eval clock in it, a sketch's is that with a k,
// and a body revision is the design id and a count. A model's recorded reply names them (geom.extrude on design d1, a
// topology reference at revision d1:2), so a replay must hand out the same ones the live run did.
//
// A first body built off the bed lands on it, and an edit that takes a part off the bed lands it again, by the same
// rule as on the app's plate (@slicerx/cad-history landing.ts), so a step after it, given in plate millimeters, lands
// where it would in the app, and the tools say the same landed note. The bed is the eval machine's (plainBed): no brim
// or skirt around a part, no excluded areas, and a part that does not fit in the middle of the bed, clear of the other
// designs, stays where it was built (the app would look for the first free spot).
//
// Left out, and said so by the tools: exact designs (the developer exact-solids option, off in the app too) and sketch
// constraints (the app's own sketch solver).
import { appendStep, bakeMesh, designNamed, HISTORY_VERSION, IDENTITY, landEdit, landNew, noDesignMessage, placedAfter, placement, replayHistory, withSketch, type BedLanding, type Design, type DesignCommit, type DesignHost, type EngineCall, type History, type HistoryMesh, type Landed, type Mat4, type Step, type StepParams, type StepStatus, type Timeline } from '@slicerx/cad-history'
import { StaleBody } from '@slicerx/cad-history/body-revisions'
import type { Bed } from '@slicerx/contracts'
import { boxInBed, sepOf } from '@slicerx/settings/box-pack'

/** The eval clock's start (the eval harness's clock), for step ids. */
const EVAL_EPOCH = Date.parse('2026-09-30T14:00:00Z')

export interface HeadlessDesignOptions {
  /** Called after each change to a design's body: a step landed, a replay, a new design. */
  changed?: (d: Design) => void
  /** The bed design `id` lands on; without it a body stays where it was built. */
  bed?: (id: string) => BedLanding<HistoryMesh[]>
}

/** How close to the bed a part counts as on it, mm (the app's arrange). */
const ON_BED_TOL_MM = 0.01
/** The room a landed part keeps from the bed edge when nothing prints around it, mm (the app's arrange). */
const LAND_EDGE_MM = 5
/** The space between objects the app's arrange keeps, mm. */
const GAP_MM = 6

type Box = { min: [number, number, number]; max: [number, number, number] }

function boundsOf(parts: readonly HistoryMesh[], t: Mat4): Box | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    const w = bakeMesh(p, t).positions
    for (let i = 0; i + 2 < w.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, w[i + k]!)
      max[k] = Math.max(max[k]!, w[i + k]!)
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null
}

/**
 * The eval's bed as the landing rule reads it, as the app's arrange does with nothing printed around a part and no
 * excluded areas: a part prints where it stands when its footprint is on the bed and it stands between the bed and
 * the printable height; one that does not goes to the middle of the bed when it fits there LAND_EDGE_MM from the edge
 * and clear of `others` (the other designs' bodies, as placed). Otherwise it has no spot here, where the app's arrange
 * would look for the first free spot. On a round bed this checks the part's bounding box against the circle, where the
 * app checks how far its outline reaches, so a long part near the rim can count as off the bed here and on it there.
 */
export function plainBed(bed: Bed, others: () => readonly { parts: readonly HistoryMesh[]; transform: Mat4 }[]): BedLanding<HistoryMesh[]> {
  return {
    printsOnBed(parts, t) {
      const b = boundsOf(parts, t)
      if (!b) return true
      const xy = boxInBed(bed, b.min[0], b.min[1], b.max[0], b.max[1], -ON_BED_TOL_MM)
      return xy && b.min[2] >= -ON_BED_TOL_MM && b.max[2] <= bed.heightMm + ON_BED_TOL_MM
    },
    landOnBed(parts, t) {
      const b = boundsOf(parts, t)
      if (!b) return null
      const middle = [...t]
      middle[12] = (middle[12] ?? 0) + bed.widthMm / 2 - (b.min[0] + b.max[0]) / 2
      middle[13] = (middle[13] ?? 0) + bed.depthMm / 2 - (b.min[1] + b.max[1]) / 2
      const m = boundsOf(parts, middle)!
      const sep = sepOf(0, 0, GAP_MM)
      const clear = others().every((o) => {
        const ob = boundsOf(o.parts, o.transform)
        return !ob || m.min[0] >= ob.max[0] + sep || m.max[0] <= ob.min[0] - sep || m.min[1] >= ob.max[1] + sep || m.max[1] <= ob.min[1] - sep
      })
      return clear && boxInBed(bed, m.min[0], m.min[1], m.max[0], m.max[1], LAND_EDGE_MM) ? middle : null
    },
  }
}

/** A design host over `engine` with every design in memory. */
export function headlessDesignHost(engine: EngineCall, opts: HeadlessDesignOptions = {}): DesignHost {
  const all = new Map<string, Design>()
  let designs = 0
  let steps = 0
  let timeline: Timeline = { bodies: [], items: [], marker: 0 }
  // the body revisions, by design id: the same ledger the app keeps (body-revisions.ts), counted
  const revisions = new Map<string, number>()
  const register = (id: string): void => void revisions.set(id, (revisions.get(id) ?? 0) + 1)
  const current = (id: string): string => {
    const n = revisions.get(id)
    if (n === undefined) throw new StaleBody(id, null)
    return `${id}:${n}`
  }
  const guard = (id: string, expected: string | undefined): void => {
    if (expected === undefined) return
    const now = revisions.has(id) ? current(id) : null
    if (now !== expected) throw new StaleBody(id, now)
  }
  // a step id as cad-history's stepId makes it (s, the time in base 36, a count), from the eval clock
  const nextStepId = (): string => `s${EVAL_EPOCH.toString(36)}${(++steps).toString(36)}`

  const noExact = (): never => {
    throw new Error('Exact designs require the developer exact-solids option.')
  }

  const run = (history: History) => replayHistory(engine, { history })

  /**
   * Lands the body design `d` now has, as the app's plate does: its first body, or one an edit took off the bed. Every
   * step undone back to a base the design started from only puts the base back, as in the app. Returns what happened,
   * for the reply of the call that did it.
   */
  function land(d: Design, before: { parts: HistoryMesh[]; transform: Mat4 }): Landed | undefined {
    if (!opts.bed || !d.parts.length) return undefined
    if (!d.history.steps.length && before.parts.length) return undefined
    const bed = opts.bed(d.id)
    // the bed reads where the design stands; a landing moves that and keeps the design's frame (cad-history landing.ts)
    const at = placement(d)
    if (!before.parts.length) {
      const l = landNew(d.parts, at, bed)
      if (l.moved && 'dxMm' in l.moved) d.placed = placedAfter(d.placed, at, l.transform)
      return l.moved
    }
    const r = landEdit({ parts: before.parts, transform: placement({ transform: before.transform, placed: d.placed }) }, d.parts, bed)
    if (r.to) d.placed = placedAfter(d.placed, at, r.to)
    return r.landed
  }

  /** Keeps a replay on the stored design `s` and lands it; what the landing did. */
  function keep(s: Design, history: History, r: Awaited<ReturnType<typeof replayHistory>>): Landed | undefined {
    const before = { parts: s.parts, transform: s.transform }
    // a step that broke keeps its sentence, as the app shows it
    Object.assign(s, { history: { ...history, steps: history.steps.map((st, i) => withBroken(st, r.status[i])) }, parts: r.parts, status: r.status, madeBy: r.madeBy ?? {} })
    const landed = land(s, before)
    register(s.id)
    opts.changed?.(s)
    return landed
  }

  // The stored designs never hold `landed`: as in the app, where every read builds the design again from the plate,
  // the note is only in the reply of the call that moved the part. A caller gets copies (get, list), and a call that
  // changes a design changes the stored one and then the caller's copy, with this call's landing on the copy alone.
  const stored = (d: Design): Design => all.get(d.id) ?? d
  const copy = (s: Design, landed?: Landed): Design => {
    const { landed: _l, ...rest } = s
    return { ...rest, ...(landed ? { landed } : {}) }
  }
  function give(d: Design, s: Design, landed: Landed | undefined): void {
    Object.assign(d, s)
    if (landed) d.landed = landed
    else delete d.landed
  }

  async function addStep(d: Design, part: number, params: StepParams, label: string | undefined, o: { sketch?: string; expectedRevision?: string } | undefined, receipt: boolean): Promise<DesignCommit> {
    guard(d.id, o?.expectedRevision)
    const s = stored(d)
    const step: Step = { id: nextStepId(), part, transform: [...s.transform], params, ...(label ? { label } : {}), ...(o?.sketch ? { sketch: o.sketch } : {}) }
    const history = appendStep(d.history, step)
    const r = await run(history)
    const st = r.status[r.status.length - 1]
    if (st?.state !== 'done') throw new Error(`The step did not go through: ${st?.message ?? 'the steps before it are broken'}. The design is unchanged.`)
    guard(d.id, o?.expectedRevision)
    const landed = keep(s, history, r)
    s.redo = []
    give(d, s, landed)
    // a receipt is the design as this step left it, which a later step does not change
    const committed = receipt ? structuredClone(d) : d
    return { step: committed.history.steps.at(-1)!, revision: current(d.id), design: committed }
  }

  const host: DesignHost = {
    call: (op, request) => engine(op, request),
    revision(id) {
      return current(host.get(id).id)
    },
    get(id) {
      // a design given by its name where its id goes: the one design of that name, as the app and MCP hosts take it
      const d = all.get(id) ?? designNamed([...all.values()], id)
      if (!d) throw Object.assign(new Error(noDesignMessage(id, [...all.values()], { start: 'design.new', list: 'design.list' })), { code: 'not_found' })
      return copy(d)
    },
    list: () => [...all.values()].map((d) => copy(d)),
    async create(name, base, history, transform: Mat4 = [...IDENTITY], options) {
      if (history?.exact || options?.exact) noExact()
      const id = `d${++designs}`
      const s: Design = { id, name, history: history ?? { version: HISTORY_VERSION, base, steps: [] }, transform, parts: [], status: [], madeBy: {}, redo: [] }
      all.set(id, s)
      if (s.history.steps.length) {
        const landed = keep(s, s.history, await run(s.history))
        // as in the app: a history that builds no body opens nothing
        if (!s.parts.length) {
          all.delete(id)
          revisions.delete(id)
          throw new Error('The design has no body yet.')
        }
        return copy(s, landed)
      }
      s.parts = base
      const landed = land(s, { parts: [], transform })
      register(id)
      opts.changed?.(s)
      return copy(s, landed)
    },
    async add(d, part, params, label, o) {
      return (await addStep(d, part, params, label, o, false)).step
    },
    addWithReceipt: (d, part, params, label, o) => addStep(d, part, params, label, o, true),
    async replay(d, o) {
      guard(d.id, o?.expectedRevision)
      const s = stored(d)
      // what the caller changed: its steps (edited, undone, put back) and what undo keeps to redo
      s.redo = d.redo
      const r = await run(d.history)
      guard(d.id, o?.expectedRevision)
      give(d, s, keep(s, d.history, r))
    },
    sketch(id) {
      const k = timeline.items.find((i) => i.kind === 'sketch' && i.id === id)
      if (k?.kind !== 'sketch') throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
      return k
    },
    addSketch(s) {
      timeline = withSketch(timeline, { id: `${nextStepId()}k`, ...(s.frame ? { frame: s.frame } : {}), loops: s.loops, ...(s.constraints?.length ? { constraints: s.constraints } : {}) })
      return timeline.items[timeline.marker - 1] as ReturnType<NonNullable<DesignHost['sketch']>>
    },
  }
  return host
}

function withBroken(s: Step, st: StepStatus | undefined): Step {
  const { broken: _b, note: _n, ...rest } = s
  return { ...rest, ...(st?.state === 'broken' ? { broken: st.message ?? 'The step failed.' } : {}), ...(st?.note ? { note: st.note } : {}) }
}
