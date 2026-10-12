// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: a design is an object on the plate, and a step made through the host lands in its history
// the way a person's edit does, in one store update, undoable and editable in Model's tree and timeline. An empty
// design waits off the plate until its first step makes a body.
import { HISTORY_VERSION, appendStep, stepId, type Design, type DesignHost, type History, type HistoryMesh, type Mat4, type Step, type StepParams } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { brandAccent } from '../edition'
import { geom } from '../geom/client'
import { identity } from '../plate/transform'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { applyHistory, runReplay } from './history/ops'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** A tool's error for a design id that names nothing. */
export class DesignNotFound extends Error {
  readonly code = 'not_found'
}

let seq = 0
const newId = () => `obj_${Date.now().toString(36)}d${(++seq).toString(36)}`

const toPart = (m: HistoryMesh): MeshPart => ({ name: m.name, slot: m.slot, positions: m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions), indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices) })

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

    async create(name, base, history, transform = identity()) {
      const id = newId()
      const h = history ?? { version: HISTORY_VERSION, base, steps: [] }
      if (!base.length && !h.steps.length) {
        empty.set(id, { name, history: h, transform })
        return host.get(id)
      }
      await place(id, name, h, transform)
      return host.get(id)
    },

    async add(d, part, params, label) {
      const step: Step = { id: stepId(), part, transform: [...d.transform], params, ...(label ? { label } : {}) }
      const next = appendStep(d.history, step)
      const w = empty.get(d.id)
      if (w) {
        await place(d.id, d.name, next, w.transform, step.id)
        empty.delete(d.id)
      } else {
        await applyHistory(loader, d.id, next, step.id).catch((e: unknown) => {
          throw new Error(`The step did not go through: ${e instanceof Error ? e.message : String(e)}. The design is unchanged.`)
        })
      }
      redo.delete(d.id)
      Object.assign(d, host.get(d.id))
      return host.get(d.id).history.steps.at(-1)!
    },

    async replay(d) {
      redo.set(d.id, d.redo)
      if (empty.has(d.id)) {
        empty.set(d.id, { name: d.name, history: d.history, transform: d.transform })
        return
      }
      if (d.history.steps.length) await applyHistory(loader, d.id, d.history)
      else {
        // Every step undone: the object goes back to its base parts, or off the plate while it has none.
        const base = d.history.base
        if (!base.length) {
          set((s) => ({ plate: s.plate.filter((p) => p.id !== d.id) }))
          empty.set(d.id, { name: d.name, history: d.history, transform: d.transform })
        } else {
          const parts = base.map(toPart)
          const handle = await loader.loadParts(d.name, parts)
          set((s) => ({ plate: s.plate.map((p) => (p.id === d.id ? { ...p, handle, parts, history: d.history } : p)) }))
        }
        markStale()
      }
      Object.assign(d, host.get(d.id))
    },
  }

  /** Replays a history with a body and puts it on the plate as a new object; throws the step's reason when `need` fails. */
  async function place(id: string, name: string, history: History, transform: Mat4, need?: string): Promise<void> {
    const r = await runReplay({ history })
    const k = need === undefined ? -1 : history.steps.findIndex((s) => s.id === need)
    if (k >= 0 && r.status[k]?.state !== 'done') throw new Error(`The step did not go through: ${r.status[k]?.message ?? 'the steps before it are broken'}. The design is unchanged.`)
    if (!r.parts.length) throw new Error('The design has no body yet.')
    const parts = r.parts.map(toPart)
    const handle = await loader.loadParts(name, parts)
    const entry: PlateEntry = { id, name, handle, parts, colors: [brandAccent()], transform: [...transform], history }
    set((s) => ({ plate: [...s.plate, entry], selection: id, selectedIds: [id] }))
    markStale()
  }

  return host
}
