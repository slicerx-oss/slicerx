// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: a design is an object on the plate, and a step made through the host lands in its history
// the way a person's edit does, in one store update, undoable and editable in Model's tree and timeline. An empty
// design waits off the plate until its first step makes a body. A first body built off the bed (around the origin, the
// bed's front left corner), or with its brim or skirt off it or in an excluded area, moves once to the middle of the
// plate, or the first free spot, like a person's move: from then on the design's coordinates are the plate's, and the
// call that made it says how far it moved. A later step or replay that takes a part that printed on the bed, or what
// prints around it, off the bed or into an excluded area lands it again the same way, in the same undo step, and says
// so. A part that still prints where it stands stays put; one parked off the bed before the step, or a locked one,
// stays where it is, and the step says it is off the bed.
import { HISTORY_VERSION, appendStep, stepId, type Design, type DesignCommit, type DesignHost, type FaceFrame, type History, type HistoryMesh, type Landed, type Mat4, type Step, type StepParams } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { brandAccent } from '../edition'
import { geom } from '../geom/client'
import { getArrangeOptions } from '../plate/edit'
import { landOnBed, printsOnBed } from '../plate/arrange'
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

/** The bed as a sketch plane, for a sketch drawn with no frame. */
const BED_FRAME: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

let seq = 0
const newId = () => `obj_${Date.now().toString(36)}d${(++seq).toString(36)}`

export function appDesignHost(loader: Loader): DesignHost {
  // Finished sketches this host drew while designs waited for their first body, by sketch id: the designs they may be
  // for. The first body of one of those designs takes them along when it lands, once; a body placing ends the claim.
  const sketches = new Map<string, Set<string>>()

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
      const moved = await place(id, name, h, transform)
      return { ...host.get(id), ...(moved ? { landed: moved } : {}) }
    },

    async add(d, part, params, label, opts) {
      return (await add(d, part, params, label, opts, false)).step
    },

    async addWithReceipt(d, part, params, label, opts) {
      return add(d, part, params, label, opts, true)
    },
    async replay(d, opts) {
      // `landed` is only ever this call's news
      delete d.landed
      const guard = opts?.expectedRevision === undefined ? undefined : () => bodyRevisions.assert(d.id, opts.expectedRevision!)
      guard?.()
      if (empty.has(d.id)) {
        if (d.history.steps.length) {
          const moved = await place(d.id, d.name, d.history, d.transform, undefined, guard)
          empty.delete(d.id)
          redo.set(d.id, d.redo)
          Object.assign(d, host.get(d.id), moved ? { landed: moved } : {})
          return
        } else {
          empty.set(d.id, { name: d.name, history: d.history, transform: d.transform })
          bodyRevisions.committed(d.id)
        }
        redo.set(d.id, d.redo)
        Object.assign(d, host.get(d.id))
        return
      }
      let landed: Landed | undefined
      if (d.history.steps.length) {
        const after = afterEdit(d.id)
        await applyHistory(loader, d.id, d.history, undefined, guard, undefined, after.land)
        landed = after.landed()
      } else {
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
      Object.assign(d, host.get(d.id), landed ? { landed } : {})
    },

    sketch(id) {
      const k = sketchById(get().timeline, id)
      if (!k) throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
      return k
    },

    addSketch(s) {
      const k = finishSketch(s)
      // drawn while no design waits for a body: in the plate's coordinates already, so no landing moves it
      if (empty.size) sketches.set(k.id, new Set(empty.keys()))
      return k
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
    delete d.landed
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
    let moved: Landed | undefined
    if (w) {
      moved = await place(d.id, d.name, next, w.transform, step.id, guard, capture)
      if (!committed) empty.delete(d.id)
    } else {
      const after = afterEdit(d.id)
      await applyHistory(loader, d.id, next, step.id, guard, capture, after.land).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'stale_body') throw e
        throw new Error(`The step did not go through: ${e instanceof Error ? e.message : String(e)}. The design is unchanged.`)
      })
      moved = after.landed()
    }
    if (committed) {
      if (moved) (committed as DesignCommit).design.landed = moved
      Object.assign(d, (committed as DesignCommit).design)
      return committed
    }
    redo.delete(d.id)
    Object.assign(d, host.get(d.id), moved ? { landed: moved } : {})
    return { step: d.history.steps.at(-1)!, revision: bodyRevisions.current(d.id), design: d }
  }

  /**
   * Replays a history with a body and puts it on the plate as a new object; throws the step's reason when `need` fails.
   * Returns how the body landed when it was built off the bed.
   */
  async function place(id: string, name: string, history: History, transform: Mat4, need?: string, guard?: () => void, committed?: () => void): Promise<Landed | undefined> {
    guard?.()
    const r = await runReplay({ history })
    const k = need === undefined ? -1 : history.steps.findIndex((s) => s.id === need)
    if (k >= 0 && r.status[k]?.state !== 'done') throw new Error(`The step did not go through: ${r.status[k]?.message ?? 'the steps before it are broken'}. The design is unchanged.`)
    if (!r.parts.length) throw new Error('The design has no body yet.')
    const parts = r.parts.map(toPart)
    const handle = await loader.loadParts(name, parts)
    const { transform: onPlate, moved } = landing(id, parts, transform)
    const entry: PlateEntry = { id, name, handle, parts, colors: [brandAccent()], transform: onPlate, history }
    guard?.()
    set((s) => ({ plate: [...s.plate, entry], selection: id, selectedIds: [id] }))
    takeSketches(id, moved && 'dxMm' in moved ? moved : undefined)
    committed?.()
    markStale()
    return moved
  }

  /**
   * As design `id` gets its body: the sketches drawn for it that no feature has used move by its landing move, if it
   * moved, so they stay with the body. Either way they are no longer its to move, so none moves twice.
   */
  function takeSketches(id: string, moved: { dxMm: number; dyMm: number } | undefined): void {
    const t = get().timeline
    const used = new Set(t.items.flatMap((i) => (i.kind === 'feature' && i.sketch !== undefined ? [i.sketch] : [])))
    const mine = new Set<string>()
    for (const [k, owners] of sketches) {
      if (!owners.has(id)) continue
      // claimed once: by this design's body, whether it moved or not
      sketches.delete(k)
      if (!used.has(k)) mine.add(k)
    }
    if (!moved || !mine.size) return
    const shift = (f: FaceFrame): FaceFrame => ({ ...f, origin: [f.origin[0] + moved.dxMm, f.origin[1] + moved.dyMm, f.origin[2]] })
    set({ timeline: { ...t, items: t.items.map((i) => (i.kind === 'sketch' && mine.has(i.id) ? { ...i, frame: shift(i.frame ?? BED_FRAME) } : i)) } })
  }

  /**
   * Where a new body goes on the shown plate: where it was built when it prints there (printsOnBed: on the bed, and its
   * brim and skirt too), else the middle of the bed or the first free spot. A body with no room anywhere stays where it
   * was built, and says so.
   */
  function landing(id: string, parts: PlateEntry['parts'], transform: Mat4): { transform: Mat4; moved?: Landed } {
    const s = get()
    const item = { id, parts, transform: [...transform] }
    if (printsOnBed(item, s.bed)) return { transform: item.transform }
    const to = landOnBed(item, s.plate.filter((p) => p.id !== id), s.bed, getArrangeOptions())
    if (!to) return { transform: item.transform, moved: { offBed: true } }
    return { transform: to, moved: shiftOf(transform, to) }
  }

  /**
   * For an edit of design `id` on the plate: the land hook applyHistory asks at the commit, and what it did. The part
   * lands again, with the landing a new part gets, only when it printed on the bed before the edit (printsOnBed, with
   * its old parts where it stands now) and with its new shape it, or what prints around it, no longer does. A part
   * already off the bed before the edit was parked there, so it stays; so does a locked part, or one with no room
   * anywhere. Each says so in the edit's result.
   */
  function afterEdit(id: string): { land: (latest: PlateEntry, parts: PlateEntry['parts']) => Mat4 | undefined; landed: () => Landed | undefined } {
    let out: Landed | undefined
    const land = (latest: PlateEntry, parts: PlateEntry['parts']): Mat4 | undefined => {
      out = undefined
      const s = get()
      const item = { id, parts, transform: [...latest.transform] }
      if (printsOnBed(item, s.bed)) return undefined
      if (!printsOnBed({ parts: latest.parts, transform: latest.transform }, s.bed)) {
        out = { offBed: true, edit: true, parked: true }
        return undefined
      }
      if (latest.locked) {
        out = { offBed: true, edit: true, locked: true }
        return undefined
      }
      const to = landOnBed(item, s.plate.filter((p) => p.id !== id), s.bed, getArrangeOptions())
      out = to ? { ...shiftOf(latest.transform, to), edit: true } : { offBed: true, edit: true }
      return to ?? undefined
    }
    return { land, landed: () => out }
  }

  return host
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** How far a landing moved a part, mm, in X and Y. */
const shiftOf = (from: Mat4, to: Mat4) => ({ dxMm: r2((to[12] ?? 0) - (from[12] ?? 0)), dyMm: r2((to[13] ?? 0) - (from[13] ?? 0)) })
