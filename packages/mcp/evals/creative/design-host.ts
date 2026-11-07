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
// Left out, and said so by the tools: exact designs (the developer exact-solids option, off in the app too) and sketch
// constraints (the app's own sketch solver). A body built off the bed is not moved onto it: the eval scores a part's
// size against the bed, not where it stands.
import { appendStep, HISTORY_VERSION, IDENTITY, replayHistory, withSketch, type Design, type DesignCommit, type DesignHost, type EngineCall, type History, type Mat4, type Step, type StepParams, type StepStatus, type Timeline } from '@slicerx/cad-history'
import { StaleBody } from '@slicerx/cad-history/body-revisions'

/** The eval clock's start (the eval harness's clock), for step ids. */
const EVAL_EPOCH = Date.parse('2026-09-30T14:00:00Z')

export interface HeadlessDesignOptions {
  /** Called after each change to a design's body: a step landed, a replay, a new design. */
  changed?: (d: Design) => void
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

  function keep(d: Design, history: History, r: Awaited<ReturnType<typeof replayHistory>>): void {
    // a step that broke keeps its sentence, as the app shows it
    Object.assign(d, { history: { ...history, steps: history.steps.map((s, i) => withBroken(s, r.status[i])) }, parts: r.parts, status: r.status, madeBy: r.madeBy ?? {} })
    register(d.id)
    opts.changed?.(d)
  }

  async function addStep(d: Design, part: number, params: StepParams, label: string | undefined, o: { sketch?: string; expectedRevision?: string } | undefined, receipt: boolean): Promise<DesignCommit> {
    guard(d.id, o?.expectedRevision)
    const step: Step = { id: nextStepId(), part, transform: [...d.transform], params, ...(label ? { label } : {}), ...(o?.sketch ? { sketch: o.sketch } : {}) }
    const history = appendStep(d.history, step)
    const r = await run(history)
    const st = r.status[r.status.length - 1]
    if (st?.state !== 'done') throw new Error(`The step did not go through: ${st?.message ?? 'the steps before it are broken'}. The design is unchanged.`)
    guard(d.id, o?.expectedRevision)
    keep(d, history, r)
    d.redo = []
    // a receipt is the design as this step left it, which a later step does not change
    const committed = receipt ? structuredClone(d) : d
    return { step: committed.history.steps.at(-1)!, revision: current(d.id), design: committed }
  }

  const host: DesignHost = {
    call: (op, request) => engine(op, request),
    revision(id) {
      host.get(id)
      return current(id)
    },
    get(id) {
      const d = all.get(id)
      if (!d) throw Object.assign(new Error(`design: no design ${id}; design.list lists them`), { code: 'not_found' })
      return d
    },
    list: () => [...all.values()],
    async create(name, base, history, transform: Mat4 = [...IDENTITY], options) {
      if (history?.exact || options?.exact) noExact()
      const id = `d${++designs}`
      const d: Design = { id, name, history: history ?? { version: HISTORY_VERSION, base, steps: [] }, transform, parts: base, status: [], madeBy: {}, redo: [] }
      all.set(id, d)
      if (d.history.steps.length) await host.replay(d)
      else {
        register(id)
        opts.changed?.(d)
      }
      return d
    },
    async add(d, part, params, label, o) {
      return (await addStep(d, part, params, label, o, false)).step
    },
    addWithReceipt: (d, part, params, label, o) => addStep(d, part, params, label, o, true),
    async replay(d, o) {
      guard(d.id, o?.expectedRevision)
      const r = await run(d.history)
      guard(d.id, o?.expectedRevision)
      keep(d, d.history, r)
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
