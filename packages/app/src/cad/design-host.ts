// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: a design is an object on the plate, and a step made through the host lands in its history
// the way a person's edit does, in one store update, undoable and editable in Model's tree and timeline. An empty
// design waits off the plate until its first step makes a body. A first body built off the bed (around the origin, the
// bed's front left corner), or with its brim or skirt off it or in an excluded area, moves once to the middle of the
// plate, or the first free spot, like a person's move, and the call that made it says how far it moved. When no spot is
// free, the other designs this host landed move over as a whole to make room, and the call says which and how far. A
// later step or replay that takes a part that printed on the bed, or what prints around it, off the bed or into an
// excluded area lands it again the same way, in the same undo step, and says so. A part that still prints where it
// stands stays put; one parked off the bed before the step, or a locked one, stays where it is, and the step says it
// is off the bed.
//
// Every landing moves the design as a whole: the history keeps the move (History.placed), so the design's coordinates
// stay the ones it was built in. Steps and timeline sketches are stored in plate coordinates; a step is moved into them
// as it is recorded, and a sketch is read in a design's frame through the move of the body that owns it and that
// design's landing (cad-history design-frame.ts). Nothing about frames is kept in the host itself, so the mimir tab's
// host and the app link's read the same.
import { BED_FRAME, HISTORY_VERSION, appendStep, designFrame, designNamed, invert, landEdit, landNew, landShift, movedBy, movedFrame, movedParams, movedSketch, multiply, noDesignMessage, placedAfter, sketchMove, stepId, storedToDesign, translation, withPlaced, type BedLanding, type Design, type DesignCommit, type DesignHost, type FaceFrame, type History, type HistoryMesh, type Landed, type Mat4, type RoomMove, type SketchItem, type Step, type StepParams } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { brandAccent } from '../edition'
import { geom } from '../geom/client'
import { getArrangeOptions } from '../plate/edit'
import { landOnBed, printsOnBed } from '../plate/arrange'
import { nestArrange } from '../plate/nest'
import { identity } from '../plate/transform'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { applyHistory, runReplay } from './history/ops'
import { exactSolids } from './history/exact-flag'
import { finishSketch, sketchById } from './sketches'
import { addProjection, changeProjection } from './project-sketch'
import { settle } from './sketch-dimension'
import { splineCurveRefs, toSolver } from './sketch-constraints'
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
  // Designs with no body yet, by id: their history and where the object stands on the plate. Their first step puts
  // them on the plate under the same id.
  const empty = new Map<string, { name: string; history: History; transform: Mat4 }>()
  // What undo took off each design, for redo; the plate's own undo is separate.
  const redo = new Map<string, Step[]>()

  const fromEntry = (e: PlateEntry): Design => {
    const history: History = e.history ?? { version: HISTORY_VERSION, base: e.parts, steps: [] }
    return {
      id: e.id,
      name: e.name,
      history,
      transform: designFrame(e.transform, history),
      ...(history.placed ? { placed: [...history.placed] as [number, number] } : {}),
      parts: e.parts,
      status: history.steps.map((s) => (s.broken !== undefined ? { state: 'broken', message: s.broken } : { state: 'done' })),
      madeBy: {},
      redo: redo.get(e.id) ?? [],
    }
  }

  /** Where a body stands on the plate now, for the move of the sketches it owns. */
  const plateOf = (body: string): Mat4 | undefined => get().plate.find((p) => p.id === body)?.transform

  const host: DesignHost = {
    call: (op, request) => geom().call(op, request),
    revision(id) {
      return bodyRevisions.current(host.get(id).id)
    },

    get(id) {
      const e = get().plate.find((p) => p.id === id)
      if (e) return fromEntry(e)
      const w = empty.get(id)
      if (w) return { id, name: w.name, history: w.history, transform: designFrame(w.transform, w.history), ...(w.history.placed ? { placed: [...w.history.placed] as [number, number] } : {}), parts: [], status: [], madeBy: {}, redo: redo.get(id) ?? [] }
      // a design given by its name where its id goes: the one design of that name, else the ids there are
      const all = host.list()
      const named = designNamed(all, id)
      if (named) return named
      throw new DesignNotFound(noDesignMessage(id, all, { start: 'design.new', list: 'design.list' }))
    },

    list() {
      return [...get().plate.filter((e) => e.history).map(fromEntry), ...[...empty.keys()].map((id) => host.get(id))]
    },

    // `transform` is where the object stands on the plate; a history from a file brings the landing moves it had
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
      const w = empty.get(d.id)
      if (w) {
        if (d.history.steps.length) {
          const moved = await place(d.id, d.name, d.history, w.transform, undefined, guard)
          empty.delete(d.id)
          redo.set(d.id, d.redo)
          Object.assign(d, host.get(d.id), moved ? { landed: moved } : {})
          return
        } else {
          empty.set(d.id, { name: d.name, history: d.history, transform: w.transform })
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
        // Every step undone: the object goes back to its base parts, or off the plate while it has none. It waits
        // where it stood, with its landing moves, so its frame and a redo stay where they were.
        const base = d.history.base
        if (!base.length) {
          const stood = get().plate.find((p) => p.id === d.id)?.transform ?? movedBy(d.transform, d.placed)
          set((s) => ({ plate: s.plate.filter((p) => p.id !== d.id) }))
          empty.set(d.id, { name: d.name, history: d.history, transform: stood })
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

    sketch(id, design) {
      const k = sketchById(get().timeline, id)
      if (!k) throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
      if (design === undefined) return k
      // in plate coordinates where its owning feature ran: moved as its body moved since, then into the design's frame
      return movedSketch(k, storedToDesign(sketchMove(get().timeline, id, plateOf), host.get(design).placed))
    },

    addSketch(s, design) {
      const d = design === undefined ? undefined : host.get(design)
      const waits = d ? (empty.has(d.id) ? [d.id] : []) : [...empty.keys()]
      // drawn in a design's frame: stored in the plate's, by that design's landing
      const by = d?.placed ? translation([d.placed[0], d.placed[1], 0]) : undefined
      const k = finishSketch(by ? { ...s, frame: movedFrame(s.frame, by) } : s)
      // drawn for designs that wait for a body: the first to land takes it along (takeSketches)
      if (waits.length) set((st) => ({ timeline: { ...st.timeline, items: st.timeline.items.map((i) => (i.kind === 'sketch' && i.id === k.id ? { ...i, drawnFor: waits } : i)) } }))
      return d ? host.sketch!(k.id, d.id) : k
    },

    bed() {
      const { widthMm, depthMm } = get().bed
      return { widthMm, depthMm }
    },

    project(sketch, source, mode) {
      return addProjection(loader, sketch, source, mode)
    },

    changeProjection(sketch, projection, change) {
      return changeProjection(loader, sketch, projection, change)
    },

    async settleSketch(s) {
      const drawn = fromLoops(s.loops)
      if (!drawn) throw Object.assign(new Error('The loops could not be read as lines, arcs, splines and circles.'), { code: 'invalid_input' })
      const onSpline = splineCurveRefs(drawn, s.constraints)
      if (onSpline.length) throw Object.assign(new Error(`constraints ${JSON.stringify(onSpline)} name a spline as a curve; a spline's points take point constraints, its curve none yet`), { code: 'invalid_input' })
      // a constraint the solve would leave out is refused rather than kept unenforced
      const gone = toSolver(drawn, s.constraints).map.dropped
      if (gone.length) throw Object.assign(new Error(`constraints ${JSON.stringify(gone)} name points or curves the sketch does not have`), { code: 'invalid_input' })
      const r = await settle(drawn, s.constraints)
      return { loops: toLoops(r.sketch), constraints: r.constraints, status: r.solved.status, dof: r.solved.dof }
    },
  }

  /**
   * The step a tool asks for on design `d`, as the history keeps it: in plate coordinates, at the transform the object
   * stands at on the plate. A step drawn on a timeline sketch is kept where that sketch is stored, so recording it
   * leaves the sketch's frame as it was, and with the sketch's own plane when the tool took it unchanged.
   */
  function recorded(d: Design, plate: Mat4, part: number, params: StepParams, label: string | undefined, sketch: string | undefined, feature: string | undefined): Step {
    const placed = d.placed ? translation([d.placed[0], d.placed[1], 0]) : undefined
    let p = placed ? movedParams(params, placed) : params
    let transform = [...plate]
    const k = sketch !== undefined ? sketchById(get().timeline, sketch) : null
    if (k && (p.op === 'shape.extrude' || p.op === 'sketch.revolve')) {
      const back = invert(sketchMove(get().timeline, k.id, plateOf))
      p = keepPlane(movedParams(p, back), k)
      transform = multiply(back, plate)
    }
    return { id: stepId(), part, transform, params: p, ...(label ? { label } : {}), ...(sketch ? { sketch } : {}), ...(feature ? { feature } : {}) }
  }

  async function add(d: Design, part: number, params: StepParams, label: string | undefined, opts: { sketch?: string; expectedRevision?: string; feature?: string } | undefined, receipt: boolean): Promise<DesignCommit> {
    const guard = opts?.expectedRevision === undefined ? undefined : () => bodyRevisions.assert(d.id, opts.expectedRevision!)
    guard?.()
    delete d.landed
    const w = empty.get(d.id)
    const plate = w ? w.transform : (get().plate.find((p) => p.id === d.id)?.transform ?? identity())
    const step = recorded(d, plate, part, params, label, opts?.sketch, opts?.feature)
    const next = appendStep(d.history, step)
    let committed: DesignCommit | undefined
    const capture = receipt ? () => {
      empty.delete(d.id)
      redo.delete(d.id)
      const current = host.get(d.id)
      committed = { step: structuredClone(current.history.steps.at(-1)!), revision: bodyRevisions.current(d.id), design: structuredClone(current) }
    } : undefined
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
   * Replays a history with a body and puts it on the plate as a new object standing at `transform`; throws the step's
   * reason when `need` fails. Returns how the body landed when it was built off the bed: the move joins the history's
   * landing moves, and so does the move of any design moved over to make room for it.
   */
  async function place(id: string, name: string, history: History, transform: Mat4, need?: string, guard?: () => void, committed?: () => void): Promise<Landed | undefined> {
    guard?.()
    const r = await runReplay({ history })
    const k = need === undefined ? -1 : history.steps.findIndex((s) => s.id === need)
    if (k >= 0 && r.status[k]?.state !== 'done') throw new Error(`The step did not go through: ${r.status[k]?.message ?? 'the steps before it are broken'}. The design is unchanged.`)
    if (!r.parts.length) throw new Error('The design has no body yet.')
    const parts = r.parts.map(toPart)
    const handle = await loader.loadParts(name, parts)
    let { transform: landedAt, moved } = landing(id, parts, transform)
    let room: Map<string, Mat4> | undefined
    if (moved && 'offBed' in moved) {
      const made = await makeRoom(id, parts, transform)
      if (made) {
        landedAt = made.at
        room = made.others
        const names = new Map(get().plate.map((e) => [e.id, e.name]))
        const moves: RoomMove[] = [...made.others].map(([o, t]) => ({ design: o, name: names.get(o) ?? o, ...landShift(get().plate.find((e) => e.id === o)!.transform, t) }))
        moved = { ...landShift(transform, landedAt), room: moves }
      }
    }
    const placed = moved && 'dxMm' in moved ? placedAfter(history.placed, transform, landedAt) : history.placed
    const entry: PlateEntry = { id, name, handle, parts, colors: [brandAccent()], transform: landedAt, history: withPlaced(history, placed) }
    guard?.()
    set((s) => ({
      plate: [
        ...s.plate.map((e) => {
          const t = room?.get(e.id)
          return t && e.history ? { ...e, transform: t, history: withPlaced(e.history, placedAfter(e.history.placed, e.transform, t)) } : e
        }),
        entry,
      ],
      selection: id,
      selectedIds: [id],
    }))
    takeSketches(id, moved && 'dxMm' in moved ? moved : undefined)
    committed?.()
    markStale()
    return moved
  }

  /**
   * Room for new body `id` (its parts standing at `transform`) when no spot on the bed is free: first beside the other
   * objects on their true outlines, then with the other designs this host landed (a landing move in their history,
   * not locked) moved over as wholes, nested together without turning. Each must print where it goes. Null when
   * neither works or the geometry engine cannot run.
   */
  async function makeRoom(id: string, parts: PlateEntry['parts'], transform: Mat4): Promise<{ at: Mat4; others: Map<string, Mat4> } | null> {
    const s = get()
    const opts = { ...getArrangeOptions(), rotate: false }
    const item = { id, parts, transform }
    // a part with no spot even on an empty bed gets none by moving others
    if (!landOnBed(item, [], s.bed, opts)) return null
    const others = s.plate.filter((e) => e.id !== id)
    const movable = others.filter((e) => e.history?.placed && !e.locked)
    const prints = (e: { parts: PlateEntry['parts']; transform: Mat4 }) => printsOnBed(e, s.bed)
    const tries: { moving: { id: string; parts: PlateEntry['parts']; transform: Mat4 }[]; fixed: PlateEntry[] }[] = [
      { moving: [item], fixed: others },
      ...(movable.length ? [{ moving: [item, ...movable], fixed: others.filter((e) => !movable.includes(e)) }] : []),
    ]
    for (const t of tries) {
      try {
        const r = await nestArrange(t.moving, t.fixed, s.bed, { ...opts, center: t.fixed.length === 0 })
        if (r.leftOver.length) continue
        const at = r.transforms[id]
        if (!at || !prints({ parts, transform: at })) continue
        const moved = new Map<string, Mat4>()
        let ok = true
        for (const e of t.moving.slice(1)) {
          const to = r.transforms[e.id]
          if (!to || !prints({ parts: e.parts, transform: to })) ok = false
          else if (to[12] !== e.transform[12] || to[13] !== e.transform[13]) moved.set(e.id, to)
        }
        if (ok) return { at, others: moved }
      } catch {
        // no engine for true outlines: the part stays where it was built, as before
        return null
      }
    }
    return null
  }

  /**
   * As design `id` gets its body: the sketches drawn for it while it waited (SketchItem.drawnFor) that no feature has
   * used move by its landing move, if it moved, so they stay with the body. Either way they are no longer drawn for
   * any waiting design, so none moves twice.
   */
  function takeSketches(id: string, moved: { dxMm: number; dyMm: number } | undefined): void {
    const t = get().timeline
    const used = new Set(t.items.flatMap((i) => (i.kind === 'feature' && i.sketch !== undefined ? [i.sketch] : [])))
    if (!t.items.some((i) => i.kind === 'sketch' && i.drawnFor?.includes(id))) return
    const shift = (f: FaceFrame | undefined): FaceFrame => movedFrame(f, translation([moved!.dxMm, moved!.dyMm, 0]))
    set({
      timeline: {
        ...t,
        items: t.items.map((i) => {
          if (i.kind !== 'sketch' || !i.drawnFor?.includes(id)) return i
          // claimed once: by this design's body, whether it moved or not
          const { drawnFor: _for, ...k } = i
          return moved && !used.has(i.id) ? { ...k, frame: shift(i.frame) } : k
        }),
      },
    })
  }

  /**
   * Where a new body goes on the shown plate: where it was built when it prints there (printsOnBed: on the bed, and its
   * brim and skirt too), else the middle of the bed or the first free spot. A body with no room anywhere stays where it
   * was built, and says so. The rule is cad-history's landNew, which the creative eval's design host runs too.
   */
  function landing(id: string, parts: PlateEntry['parts'], transform: Mat4): { transform: Mat4; moved?: Landed } {
    return landNew(parts, transform, onPlate(id))
  }

  /** The shown plate as the landing rule (@slicerx/cad-history landing.ts) reads it for design `id`. */
  function onPlate(id: string): BedLanding<PlateEntry['parts']> {
    const s = get()
    return {
      printsOnBed: (parts, transform) => printsOnBed({ parts, transform }, s.bed),
      landOnBed: (parts, transform) => landOnBed({ id, parts, transform }, s.plate.filter((p) => p.id !== id), s.bed, getArrangeOptions()),
    }
  }

  /**
   * For an edit of design `id` on the plate: the land hook applyHistory asks at the commit, and what it did. The part
   * lands again, with the landing a new part gets, only when it printed on the bed before the edit (printsOnBed, with
   * its old parts where it stands now) and with its new shape it, or what prints around it, no longer does. A part
   * already off the bed before the edit was parked there, so it stays; so does a locked part, or one with no room
   * anywhere. Each says so in the edit's result. The move joins the design's landing moves.
   */
  function afterEdit(id: string): { land: (latest: PlateEntry, parts: PlateEntry['parts']) => { transform: Mat4; placed: [number, number] | undefined } | undefined; landed: () => Landed | undefined } {
    let out: Landed | undefined
    const land = (latest: PlateEntry, parts: PlateEntry['parts']) => {
      const r = landEdit({ parts: latest.parts, transform: latest.transform, locked: latest.locked }, parts, onPlate(id))
      out = r.landed
      return r.to ? { transform: r.to, placed: placedAfter(latest.history?.placed, latest.transform, r.to) } : undefined
    }
    return { land, landed: () => out }
  }

  return host
}

/** A step drawn on sketch `k`, its plane put back exactly as the sketch keeps it when the move left it the same. */
function keepPlane(p: StepParams, k: SketchItem): StepParams {
  if (p.op !== 'shape.extrude' && p.op !== 'sketch.revolve') return p
  const same = (a: FaceFrame, b: FaceFrame) => (['origin', 'normal', 'u', 'v'] as const).every((f) => a[f].every((v, i) => Math.abs(v - b[f][i]!) < 1e-6))
  const f = p.frame ?? BED_FRAME
  if (!same(f, k.frame ?? BED_FRAME)) return p
  const { frame: _f, ...rest } = p
  return (k.frame ? { ...rest, frame: k.frame } : rest) as StepParams
}
