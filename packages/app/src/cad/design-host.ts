// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: a design is an object on the plate, and a step made through the host lands in its history
// the way a person's edit does, in one store update, undoable and editable in Model's tree and timeline. An empty
// design waits off the plate until its first step makes a body.
import { HISTORY_VERSION, appendStep, stepId, type Design, type DesignCommit, type DesignHost, type History, type HistoryMesh, type Mat4, type Step, type StepParams } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { brandAccent } from '../edition'
import { geom } from '../geom/client'
import { identity } from '../plate/transform'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { applyHistory, runReplay } from './history/ops'
import { exactSolids } from './history/exact-flag'
import { finishSketch, sketchById } from './sketches'
import { settle } from './sketch-dimension'
import { fromLoops, toLoops } from './sketch-model'
import { bodyRevisions } from './body-revisions'
import { historyPart as toPart } from '@slicerx/cad-history/mesh-part'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** A tool's error for a design id that names nothing. */
export class DesignNotFound extends Error {
  readonly code = 'not_found'
}

let seq = 0
const newId = () => `obj_${Date.now().toString(36)}d${(++seq).toString(36)}`

export function appDesignHost(loader: Loader): DesignHost {
  // Designs with no body yet, by id; their first step puts them on the plate under the same id.
  const empty = new Map<string, { name: string; history: History; transform: Mat4 }>()
  // What undo took off each design, for redo; the plate's own undo is separate.
  const redo = new Map<string, Step[]>()

  const fromEntry = (e: PlateEntry): Design => {
    const history: History = e.history ?? { version: HISTORY_VERSION, base: e.parts, steps: [] }
    return {
      id: e.id,
      name: e.name,
      history,
      transform: [...e.transform],
      parts: e.parts,
      status: history.steps.map((s) => (s.broken !== undefined ? { state: 'broken', message: s.broken } : { state: 'done' })),
      madeBy: {},
      redo: redo.get(e.id) ?? [],
    }
  }

  const host: DesignHost = {
    call: (op, request) => geom().call(op, request),
    revision(id) {
      host.get(id)
      return bodyRevisions.current(id)
    },

    get(id) {
      const e = get().plate.find((p) => p.id === id)
      if (e) return fromEntry(e)
      const w = empty.get(id)
      if (w) return { id, name: w.name, history: w.history, transform: [...w.transform], parts: [], status: [], madeBy: {}, redo: redo.get(id) ?? [] }
      throw new DesignNotFound(`design: no design ${id}; design.list lists them`)
    },

    list() {
      return [...get().plate.filter((e) => e.history).map(fromEntry), ...[...empty.keys()].map((id) => host.get(id))]
    },

    async create(name, base, history, transform = identity(), options) {
      const exact = history?.exact || options?.exact
      if (exact) {
        if (!exactSolids()) throw new Error('Exact designs require the developer exact-solids option.')
        if ((history?.base ?? base).length) throw new Error('Exact designs start from native features. Imported meshes cannot be converted by this option.')
        await geom().call('brep.count', {})
      }
      const id = newId()
      const source = history ?? { version: HISTORY_VERSION, base, steps: [] }
      const h: History = exact ? { ...source, exact: true } : source
      if (!base.length && !h.steps.length) {
        empty.set(id, { name, history: h, transform })
        bodyRevisions.register(id)
        return host.get(id)
      }
      await place(id, name, h, transform)
      return host.get(id)
    },

    async add(d, part, params, label, opts) {
      return (await add(d, part, params, label, opts, false)).step
    },

    async addWithReceipt(d, part, params, label, opts) {
      return add(d, part, params, label, opts, true)
    },
    async replay(d, opts) {
      const guard = opts?.expectedRevision === undefined ? undefined : () => bodyRevisions.assert(d.id, opts.expectedRevision!)
      guard?.()
      if (empty.has(d.id)) {
        if (d.history.steps.length) {
          await place(d.id, d.name, d.history, d.transform, undefined, guard)
          empty.delete(d.id)
        } else {
          empty.set(d.id, { name: d.name, history: d.history, transform: d.transform })
          bodyRevisions.committed(d.id)
        }
        redo.set(d.id, d.redo)
        Object.assign(d, host.get(d.id))
        return
      }
      if (d.history.steps.length) await applyHistory(loader, d.id, d.history, undefined, guard)
      else {
        // Every step undone: the object goes back to its base parts, or off the plate while it has none.
        const base = d.history.base
        if (!base.length) {
          set((s) => ({ plate: s.plate.filter((p) => p.id !== d.id) }))
          empty.set(d.id, { name: d.name, history: d.history, transform: d.transform })
          bodyRevisions.register(d.id)
        } else {
          const parts = base.map(toPart)
          const handle = await loader.loadParts(d.name, parts)
          guard?.()
          set((s) => ({ plate: s.plate.map((p) => (p.id === d.id ? { ...p, handle, parts, history: d.history } : p)) }))
        }
        markStale()
      }
      redo.set(d.id, d.redo)
      Object.assign(d, host.get(d.id))
    },

    sketch(id) {
      const k = sketchById(get().timeline, id)
      if (!k) throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
      return k
    },

    addSketch(s) {
      return finishSketch(s)
    },

    async settleSketch(s) {
      const drawn = fromLoops(s.loops)
      if (!drawn) throw Object.assign(new Error('The loops could not be read as lines, arcs and circles.'), { code: 'invalid_input' })
      const r = await settle(drawn, s.constraints)
      return { loops: toLoops(r.sketch), constraints: r.constraints, status: r.solved.status, dof: r.solved.dof }
    },
  }

  async function add(d: Design, part: number, params: StepParams, label: string | undefined, opts: { sketch?: string; expectedRevision?: string } | undefined, receipt: boolean): Promise<DesignCommit> {
    const guard = opts?.expectedRevision === undefined ? undefined : () => bodyRevisions.assert(d.id, opts.expectedRevision!)
    guard?.()
    const step: Step = { id: stepId(), part, transform: [...d.transform], params, ...(label ? { label } : {}), ...(opts?.sketch ? { sketch: opts.sketch } : {}) }
    const next = appendStep(d.history, step)
    let committed: DesignCommit | undefined
    const capture = receipt ? () => {
      empty.delete(d.id)
      redo.delete(d.id)
      const current = host.get(d.id)
      committed = { step: structuredClone(current.history.steps.at(-1)!), revision: bodyRevisions.current(d.id), design: structuredClone(current) }
    } : undefined
    const w = empty.get(d.id)
    if (w) {
      await place(d.id, d.name, next, w.transform, step.id, guard, capture)
      if (!committed) empty.delete(d.id)
    } else {
      await applyHistory(loader, d.id, next, step.id, guard, capture).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'stale_body') throw e
        throw new Error(`The step did not go through: ${e instanceof Error ? e.message : String(e)}. The design is unchanged.`)
      })
    }
    if (committed) { Object.assign(d, committed.design); return committed }
    redo.delete(d.id)
    Object.assign(d, host.get(d.id))
    return { step: d.history.steps.at(-1)!, revision: bodyRevisions.current(d.id), design: d }
  }

  /** Replays a history with a body and puts it on the plate as a new object; throws the step's reason when `need` fails. */
  async function place(id: string, name: string, history: History, transform: Mat4, need?: string, guard?: () => void, committed?: () => void): Promise<void> {
    guard?.()
    const r = await runReplay({ history })
    const k = need === undefined ? -1 : history.steps.findIndex((s) => s.id === need)
    if (k >= 0 && r.status[k]?.state !== 'done') throw new Error(`The step did not go through: ${r.status[k]?.message ?? 'the steps before it are broken'}. The design is unchanged.`)
    if (!r.parts.length) throw new Error('The design has no body yet.')
    const parts = r.parts.map(toPart)
    const handle = await loader.loadParts(name, parts)
    const entry: PlateEntry = { id, name, handle, parts, colors: [brandAccent()], transform: [...transform], history }
    guard?.()
    set((s) => ({ plate: [...s.plate, entry], selection: id, selectedIds: [id] }))
    committed?.()
    markStale()
  }

  return host
}
