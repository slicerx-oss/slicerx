// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's design host: a design is an object on the plate, and a step made through the host lands in its history
// the way a person's edit does, in one store update, undoable and editable in Model's tree and timeline. An empty
// design waits off the plate until its first step makes a body. A first body built off the bed (around the origin, the
// bed's front left corner), or with its brim or skirt off it or in an excluded area, moves once to the middle of the
// plate, or the first free spot, like a person's move, and the call that made it says how far it moved. When no spot is
// free, the other designs a host landed, and the person has not moved since, move over as a whole to make room, and the
// call says which and how far; undoing the new design's step through the design tools moves them back. A
// later step or replay that takes a part that printed on the bed, or what prints around it, off the bed or into an
// excluded area lands it again the same way, in the same undo step, and says so. A part that still prints where it
// stands stays put; one parked off the bed before the step, or a locked one, stays where it is, and the step says it
// is off the bed.
//
// Every landing moves the design as a whole: the history keeps the move (History.placed), so the design's coordinates
// stay the ones it was built in. Steps and timeline sketches are stored in plate coordinates; a step is moved into them
// as it is recorded, one drawn on a timeline sketch where the sketch is stored, and a sketch is read where it stands
// now, moved with the design it was drawn for or the first feature drawn on it, then into a design's frame by that
// design's landing (cad-history design-frame.ts). Where a body stands comes from one place for every reader
// (sketch-place.ts), waiting designs included, so the mimir tab's host, the app link's and Model read the same.
import { HISTORY_VERSION, appendStep, claimSketches, designFrame, designNamed, landEdit, landNew, landShift, movedBy, movedFrame, movedParams, movedSketch, noDesignMessage, placedAfter, recordedOn, sketchMove, stepId, storedToDesign, translation, unstopped, withPlaced, type AddOptions, type BedLanding, type Design, type DesignCommit, type DesignHost, type DrawnFor, type History, type HistoryMesh, type Landed, type Mat4, type RoomMove, type Step, type StepParams, type StepStatus } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { brandAccent } from '../edition'
import { geom } from '../geom/client'
import { getArrangeOptions } from '../plate/edit'
import { landOnBed, printsOnBed } from '../plate/arrange'
import { nestArrange } from '../plate/nest'
import { identity } from '../plate/transform'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { applyHistory, runReplay } from './history/ops'
import { newStep, type UndoStep } from '../plate/history'
import { exactSolids } from './history/exact-flag'
import { finishSketch, sketchById } from './sketches'
import { addProjection, changeProjection } from './project-sketch'
import { settle } from './sketch-dimension'
import { splineCurveRefs, toSolver } from './sketch-constraints'
import { fromLoops, toLoops } from './sketch-model'
import { bodyRevisions } from './body-revisions'
import { placeOf } from './sketch-place'
import { ownWaiting, projectGeneration, setWaiting } from './waiting'
import { paintOf, withPaint } from './history/paint'
import { historyPart as toPart } from '@slicerx/cad-history/mesh-part'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** A tool's error for a design id that names nothing. */
export class DesignNotFound extends Error {
  readonly code = 'not_found'
}

let seq = 0
/** The paint a replay's parts carry, as a plate object's own. */
const withReplayPaint = (parts: Parameters<typeof paintOf>[0]): Pick<PlateEntry, 'paint'> => {
  const paint = paintOf(parts)
  return paint ? { paint } : {}
}

const withoutPaint = ({ paint: _p, ...rest }: PlateEntry): PlateEntry => rest

const newId = () => `obj_${Date.now().toString(36)}d${(++seq).toString(36)}`

/** A design host on the app's plate, and how to let it go (dispose). */
export type AppDesignHost = DesignHost & {
  /**
   * Lets the host go: the designs it keeps waiting for a first body can never get one now, so they stop waiting
   * everywhere (waiting.ts). A sketch drawn for one then reads where it is stored, and goes with the last body that
   * uses it. Called when the app link is hosted again and when the mimir tab's tools are made again.
   */
  dispose(): void
}

export function appDesignHost(loader: Loader): AppDesignHost {
  // The step statuses of the last replay this host ran of each design, by the history it wrote: a step's answer reads
  // its note and a pattern's copies from them, as the server's own designs do. A history written any other way (a
  // person's edit) has only what the saved steps keep.
  const ran = new WeakMap<History, StepStatus[]>()
  const remember = (id: string, status: StepStatus[]) => {
    const h = get().plate.find((p) => p.id === id)?.history
    if (h) ran.set(h, status)
  }
  // Designs with no body yet, by id: their history and where the object stands on the plate. Their first step puts
  // them on the plate under the same id. Where each waits is shared, so a sketch drawn for it reads the same anywhere.
  const empty = new Waiting()
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
      // each part with its paint, so the paint tools paint over what is there and read it back
      parts: withPaint(e),
      status: (e.history && ran.get(e.history)) ?? history.steps.map((s) => (s.broken !== undefined ? { state: 'broken', message: s.broken } : s.note ? { state: 'done', note: s.note } : { state: 'done' })),
      madeBy: {},
      redo: redo.get(e.id) ?? [],
    }
  }

  const host: AppDesignHost = {
    dispose() {
      empty.dispose()
      redo.clear()
    },

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
        await applyHistory(loader, d.id, d.history, undefined, guard, (status) => remember(d.id, status), after.land)
        landed = after.landed()
      } else {
        // Every step undone: the object goes back to its base parts, or off the plate while it has none. It waits
        // where it stood, with its landing moves, so its frame and a redo stay where they were.
        const base = d.history.base
        if (!base.length) {
          const was = get().plate.find((p) => p.id === d.id)
          const stood = was?.transform ?? movedBy(d.transform, d.placed)
          // the step that landed it is undone: the designs its landing moved over go back, in the same write
          const room = was?.roomMoves && !d.history.steps.some((x) => x.id === was.roomMoves!.step) ? was.roomMoves : undefined
          // with the room taken back it waits where it was built, so a redo lands it again and makes room again. It
          // waits before it leaves the plate, so the timeline keeps the sketches drawn for it, under their ids.
          if (room) empty.set(d.id, { name: d.name, history: withPlaced(d.history, room.placed), transform: [...room.built] })
          else empty.set(d.id, { name: d.name, history: d.history, transform: stood })
          set((s) => ({ plate: movedBack(s.plate.filter((p) => p.id !== d.id), room?.moves ?? []) }))
          bodyRevisions.register(d.id)
        } else {
          const parts = base.map(toPart)
          const handle = await loader.loadParts(d.name, parts)
          guard?.()
          // the base parts' own paint, and none of what the undone steps painted
          set((s) => ({ plate: s.plate.map((p) => (p.id === d.id ? { ...withoutPaint(p), handle, parts, history: d.history, ...withReplayPaint(base) } : p)) }))
        }
        markStale()
      }
      redo.set(d.id, d.redo)
      Object.assign(d, host.get(d.id), landed ? { landed } : {})
    },

    sketch(id, design) {
      const k = sketchById(get().timeline, id)
      if (!k) throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
      // where it stands on the plate now, as Model draws it, then into the design's frame by that design's landing
      const move = sketchMove(get().timeline, id, placeOf)
      return movedSketch(k, design === undefined ? move : storedToDesign(move, host.get(design).placed))
    },

    addSketch(s, design) {
      const d = design === undefined ? undefined : host.get(design)
      // drawn for the design named, or for every design that waits for a body: it moves with that design, where it
      // stands now (SketchItem.drawnFor), and of waiting designs the first to land claims it
      const standing = (id: string): DrawnFor => ({ design: id, transform: [...(placeOf(id) ?? identity())] })
      const drawnFor = d ? [standing(d.id)] : [...empty.keys()].map(standing)
      // drawn in a design's frame: stored in the plate's, by that design's landing
      const by = d?.placed ? translation([d.placed[0], d.placed[1], 0]) : undefined
      // one write, so one undo step takes the sketch back with what it is drawn for
      const k = finishSketch({ ...s, ...(by ? { frame: movedFrame(s.frame, by) } : {}), drawnFor })
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
   * stands at on the plate. A step drawn on a timeline sketch is kept where that sketch is stored (cad-history
   * recordedOn), as Model's own Extrude and Revolve keep theirs, so recording it leaves the sketch's frame as it was.
   */
  function recorded(d: Design, plate: Mat4, part: number, params: StepParams, label: string | undefined, sketch: string | undefined, feature: string | undefined, group?: string): Step {
    const placed = d.placed ? translation([d.placed[0], d.placed[1], 0]) : undefined
    const given = placed ? movedParams(params, placed) : params
    const { transform, params: p } = sketch !== undefined ? recordedOn(get().timeline, sketch, plate, given, placeOf) : { transform: [...plate], params: given }
    return { id: stepId(), part, transform, params: p, ...(label ? { label } : {}), ...(sketch ? { sketch } : {}), ...(feature ? { feature } : {}), ...(group ? { group } : {}) }
  }

  /** The undo step of the last group a call added to each design: the steps of one call land in one undo step. */
  const groupSteps = new Map<string, { group: string; step: UndoStep }>()
  const undoStepOf = (design: string, group: string | undefined): UndoStep | undefined => {
    if (!group) return undefined
    const had = groupSteps.get(design)
    if (had?.group === group) return had.step
    const step = newStep()
    groupSteps.set(design, { group, step })
    return step
  }

  async function add(d: Design, part: number, params: StepParams, label: string | undefined, opts: AddOptions | undefined, receipt: boolean): Promise<DesignCommit> {
    const guard = opts?.expectedRevision === undefined ? undefined : () => bodyRevisions.assert(d.id, opts.expectedRevision!)
    guard?.()
    delete d.landed
    const w = empty.get(d.id)
    const plate = w ? w.transform : (get().plate.find((p) => p.id === d.id)?.transform ?? identity())
    const step = recorded(d, plate, part, params, label, opts?.sketch, opts?.feature, opts?.group)
    const next = appendStep(d.history, step)
    let committed: DesignCommit | undefined
    // the replay's own statuses go with the history it wrote, before anything reads the design back
    const capture = (status: StepStatus[]) => {
      remember(d.id, status)
      if (receipt) take()
    }
    const take = () => {
      empty.delete(d.id)
      redo.delete(d.id)
      const current = host.get(d.id)
      committed = { step: structuredClone(current.history.steps.at(-1)!), revision: bodyRevisions.current(d.id), design: structuredClone(current) }
    }
    let moved: Landed | undefined
    if (w) {
      moved = await place(d.id, d.name, next, w.transform, step.id, guard, capture)
      if (!committed) empty.delete(d.id)
    } else {
      const after = afterEdit(d.id)
      await applyHistory(loader, d.id, next, step.id, guard, capture, after.land, undoStepOf(d.id, opts?.group)).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'stale_body') throw e
        throw new Error(`The step did not go through: ${unstopped(e instanceof Error ? e.message : String(e))}. The design is unchanged.`)
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
  async function place(id: string, name: string, history: History, transform: Mat4, need?: string, guard?: () => void, committed?: (status: StepStatus[]) => void): Promise<Landed | undefined> {
    guard?.()
    // built for the project the plate holds as this starts: a new project, or one opened in its place, meanwhile gets
    // no body from it
    const project = projectGeneration()
    const r = await runReplay({ history })
    const k = need === undefined ? -1 : history.steps.findIndex((s) => s.id === need)
    if (k >= 0 && r.status[k]?.state !== 'done') throw new Error(`The step did not go through: ${unstopped(r.status[k]?.message ?? 'the steps before it are broken')}. The design is unchanged.`)
    if (!r.parts.length) throw new Error('The design has no body yet.')
    const parts = r.parts.map(toPart)
    const handle = await loader.loadParts(name, parts)
    let { transform: landedAt, moved } = landing(id, parts, transform)
    let room: Map<string, { from: Mat4; to: Mat4 }> | undefined
    if (moved && 'offBed' in moved) {
      // the room is worked out against the plate as it stands when the nest starts; when anything on it moved, came or
      // went, was locked or unlocked, or changed shape, while the nest ran, that room may no longer be free or allowed
      // (or a better one is), so it is worked out again, and after a few tries the new design stays where it was built
      for (let tries = 0; tries < 3; tries++) {
        const before = new Map(get().plate.map((e) => [e.id, { transform: e.transform, locked: !!e.locked, parts: e.parts }]))
        const made = await makeRoom(id, parts, transform)
        if (!made) break
        const now = get().plate
        const stale = (e: PlateEntry) => {
          const b = before.get(e.id)
          return !b || !same(b.transform, e.transform) || b.locked !== !!e.locked || b.parts !== e.parts
        }
        if (now.length !== before.size || now.some(stale)) continue
        landedAt = made.at
        room = made.others
        moved = landShift(transform, landedAt)
        break
      }
    }
    const placed = moved && 'dxMm' in moved ? placedAfter(history.placed, transform, landedAt) : history.placed
    const step = history.steps.at(-1)?.id
    guard?.()
    if (projectGeneration() !== project) throw new Error('The project changed while this design was built, so it was not put on the plate.')
    // the room moves are worked out against the plate as it was before the nest; one deleted meanwhile is gone
    const applied: { id: string; name: string; from: Mat4; to: Mat4 }[] = []
    set((s) => {
      applied.length = 0
      const plate = s.plate.map((e) => {
        const r = room?.get(e.id)
        if (!r || !e.history || e.locked || !same(e.transform, r.from)) return e
        applied.push({ id: e.id, name: e.name, from: r.from, to: r.to })
        return { ...e, transform: r.to, landedAt: [...r.to], history: withPlaced(e.history, placedAfter(e.history.placed, e.transform, r.to)) }
      })
      const entry: PlateEntry = {
        id,
        name,
        handle,
        parts,
        colors: [brandAccent()],
        transform: landedAt,
        history: withPlaced(history, placed),
        ...withReplayPaint(r.parts),
        ...(moved && 'dxMm' in moved ? { landedAt: [...landedAt] } : {}),
        ...(applied.length && step ? { roomMoves: { step, moves: applied.map((a) => ({ id: a.id, from: [...a.from], to: [...a.to] })), built: [...transform], ...(history.placed ? { placed: history.placed } : {}) } } : {}),
      }
      // sketches drawn for it while it and other designs waited are its own now
      return { plate: [...plate, entry], timeline: claimSketches(s.timeline, id), selection: id, selectedIds: [id] }
    })
    if (moved && 'dxMm' in moved && room) {
      const moves: RoomMove[] = applied.map((a) => ({ design: a.id, name: a.name, ...landShift(a.from, a.to) }))
      moved = { ...moved, room: moves }
    }
    remember(id, r.status)
    committed?.(r.status)
    markStale()
    return moved
  }

  /**
   * Room for new body `id` (its parts standing at `transform`) when no spot on the bed is free: first beside the other
   * objects on their true outlines, then with the other designs a host landed (a landing move in their history, not
   * locked) and the person has not moved since (they stand where their landing put them, PlateEntry.landedAt) moved
   * over as wholes, nested together without turning. Each must print where it goes. Null when neither works or the
   * geometry engine cannot run.
   */
  async function makeRoom(id: string, parts: PlateEntry['parts'], transform: Mat4): Promise<{ at: Mat4; others: Map<string, { from: Mat4; to: Mat4 }> } | null> {
    const s = get()
    const opts = { ...getArrangeOptions(), rotate: false }
    const item = { id, parts, transform }
    // a part with no spot even on an empty bed gets none by moving others
    if (!landOnBed(item, [], s.bed, opts)) return null
    const others = s.plate.filter((e) => e.id !== id)
    const movable = others.filter((e) => e.history?.placed && !e.locked && e.landedAt && same(e.landedAt, e.transform))
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
        const moved = new Map<string, { from: Mat4; to: Mat4 }>()
        let ok = true
        for (const e of t.moving.slice(1)) {
          const to = r.transforms[e.id]
          if (!to || !prints({ parts: e.parts, transform: to })) ok = false
          else if (to[12] !== e.transform[12] || to[13] !== e.transform[13]) moved.set(e.id, { from: [...e.transform], to })
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
   * anywhere. Each says so in the edit's result. The move joins the design's landing moves, and the part stands where
   * a host landed it (PlateEntry.landedAt).
   */
  function afterEdit(id: string): { land: (latest: PlateEntry, parts: PlateEntry['parts']) => Pick<PlateEntry, 'transform' | 'landedAt'> & { placed: [number, number] | undefined } | undefined; landed: () => Landed | undefined } {
    let out: Landed | undefined
    const land = (latest: PlateEntry, parts: PlateEntry['parts']) => {
      const r = landEdit({ parts: latest.parts, transform: latest.transform, locked: latest.locked }, parts, onPlate(id))
      out = r.landed
      return r.to ? { transform: r.to, landedAt: [...r.to], placed: placedAfter(latest.history?.placed, latest.transform, r.to) } : undefined
    }
    return { land, landed: () => out }
  }

  return host
}

/** The designs a host keeps waiting for their first body; where each waits is shared with every reader (waiting.ts). */
class Waiting extends Map<string, { name: string; history: History; transform: Mat4 }> {
  /** Set once the host goes away: a call still under way on it then keeps its designs to itself, never shared. */
  private gone = false
  /** Lets every waiting design go when the project is cleared (waiting.ts forgetWaiting). */
  private readonly release = ownWaiting(() => this.clear())
  override set(id: string, w: { name: string; history: History; transform: Mat4 }): this {
    if (!this.gone) setWaiting(id, w.transform)
    return super.set(id, w)
  }
  /** Lets every waiting design go, and keeps any later one from being shared. */
  dispose(): void {
    this.clear()
    this.gone = true
    this.release()
  }
  override delete(id: string): boolean {
    setWaiting(id, null)
    return super.delete(id)
  }
  override clear(): void {
    for (const id of this.keys()) setWaiting(id, null)
    super.clear()
  }
}

/** Two transforms the same, to float noise. */
function same(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-9)
}

/**
 * The plate with the designs a landing moved over to make room moved back where they stood, each with its landing
 * moves as they were, when it still stands where the room move put it; one the person moved or locked since stays.
 */
function movedBack(plate: PlateEntry[], moves: readonly { id: string; from: number[]; to: number[] }[]): PlateEntry[] {
  if (!moves.length) return plate
  return plate.map((e) => {
    const m = moves.find((x) => x.id === e.id)
    if (!m || !e.history || e.locked || !same(e.transform, m.to)) return e
    return { ...e, transform: [...m.from], landedAt: [...m.from], history: withPlaced(e.history, placedAfter(e.history.placed, e.transform, m.from)) }
  })
}
