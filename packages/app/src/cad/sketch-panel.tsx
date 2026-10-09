// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sketch mode. Pick the bed or a flat face, draw lines, rectangles, circles and three point arcs on
// it with snaps and typed sizes, fix what sketch.check reports, then extrude or revolve. The camera
// stays free; "Look at the sketch" turns it square on. There is no solver. Finishing records the
// sketch as a step of the object's history, where it opens again in this panel to be changed.
//
// Speed: the view reports the cursor at most once a frame (viewport cadtools.ts). The hover path
// here snaps, moves the rubber band in its fixed buffer and writes one text node; it renders no
// React. React renders on clicks, drags of points and edits only.
import { patternFromFields, patternProblem, type Pattern, type PatternFields } from './pattern'
import { fieldsOf, PatternSection } from './pattern-fields'
import type { PickEvent, SketchEvent, SketchScene, SketchTone } from '@slicerx/viewport'
import { Button, Field, Icon, Seg, Select, Switch } from '@slicerx/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { checkSketch, offsetSketch, pickFace, sketchSnaps, type FaceFrame, type MeshItem, type Polygon, type SketchCheck } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { get, set, toast, useApp } from '../state/store'
import { applyExtrude, applyRevolve, BED_FRAME, extrudeParams, frameToBed, revolveParams, wholeMesh, type ExtrudeInput, type RevolveInput } from './cad-ops'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext } from './history/record'
import { chamferSketch, filletSketch } from './edge-api'
import { flipFor, goesIntoFace } from './extrude-direction'
import { close, errorText, num, Num, pickWords, Shell, useProbe, ToolFooter } from './panel-kit'
import { useDraft, useDraftObject } from './park'
import {
  axisOf,
  axisSegment,
  click,
  straightCorners,
  deleteSegment,
  emptyDraft,
  entityPaths,
  extent,
  fieldsFor,
  fromLoops,
  handles,
  hitTest,
  moveHandle,
  polylineToChain,
  preview,
  readout,
  SNAP_NAMES,
  sketchTargets,
  snap,
  toLoops,
  typedPoint,
  type Draft,
  type DrawTool,
  type Entity,
  type SnapTargets,
  type V2,
} from './sketch-model'

interface Plane {
  frame: FaceFrame
  outline: Polygon[]
  target?: { objectId: string; partIndex: number }
  label: string
  /** The area worth a grid, in plane coordinates. */
  min: V2
  max: V2
}

const TOOLS: { value: DrawTool; label: string }[] = [
  { value: 'select', label: 'Select' },
  { value: 'line', label: 'Line' },
  { value: 'rect', label: 'Rectangle' },
  { value: 'circle', label: 'Circle' },
  { value: 'arc', label: 'Arc' },
]

/** Pixels around the cursor that count for snaps and picks. */
const SNAP_PX = 8

/** A sketch step opened from the history, as the editor's starting state. */
interface SketchInit {
  index: number
  sketch: Entity[]
  finish: 'extrude' | 'revolve'
  fields: { distance: string; extent: 'oneSide' | 'symmetric' | 'twoSides'; distance2: string; taper: string; flip: boolean; angle: string }
  operation: 'new' | 'join' | 'cut'
  axis: { e: number; seg: number } | null
  pattern?: Pattern
}

function sketchEdit(bed: { widthMm: number; depthMm: number }): { plane: Plane; init: SketchInit } | { note: string } | null {
  const ed = editing()
  const p = ed?.step.params
  if (!ed || !p || !((p.op === 'shape.extrude' && p.shape.type === 'sketch') || p.op === 'sketch.revolve')) return null
  const loops = p.op === 'sketch.revolve' ? p.loops : p.shape.type === 'sketch' ? p.shape.loops : []
  const sketch = fromLoops(loops)
  if (!sketch) return { note: 'This sketch has segments given by length and angle, which sketch mode cannot show. Its numbers can still change in the history list.' }
  const now = nowOf(ed.step, ed.entry.transform)
  const frame = p.frame ? now.frame(p.frame) : BED_FRAME
  const operation = p.op === 'sketch.revolve' ? (p.operation ?? 'new') : (p.spec.operation ?? 'new')
  const ext = extent(sketch)
  const r = ext ? ext.radius + 20 : 50
  const c = ext?.center ?? [0, 0]
  const onBed = !p.frame
  const plane: Plane = {
    frame,
    outline: [],
    ...(operation !== 'new' ? { target: { objectId: ed.entry.id, partIndex: ed.step.part } } : {}),
    label: `Editing step ${ed.index + 1}`,
    min: onBed ? [0, 0] : [c[0] - r, c[1] - r],
    max: onBed ? [bed.widthMm, bed.depthMm] : [c[0] + r, c[1] + r],
  }
  const spec = p.op === 'shape.extrude' ? p.spec : null
  return {
    plane,
    init: {
      index: ed.index,
      sketch,
      finish: p.op === 'sketch.revolve' ? 'revolve' : 'extrude',
      fields: { distance: String(spec?.distanceMm ?? 5), extent: spec?.extent ?? 'oneSide', distance2: String(spec?.distance2Mm ?? 5), taper: String(spec?.taperDeg ?? 0), flip: Boolean(spec?.flip), angle: String(p.op === 'sketch.revolve' ? (p.angleDeg ?? 360) : 360) },
      operation,
      axis: p.op === 'sketch.revolve' ? axisSegment(sketch, p.axis) : null,
      ...(p.op === 'shape.extrude' && p.pattern ? { pattern: p.pattern } : {}),
    },
  }
}

export function SketchTool() {
  const bedSize = useApp((s) => s.bed)
  const [edit] = useState(() => sketchEdit(bedSize))
  // A plane on a part that moved in Slice moves with it.
  const [plane, setPlane] = useDraft<Plane | null>('plane', edit && 'plane' in edit ? edit.plane : null, (p, now) => (p && now ? { ...p, frame: now.frame(p.frame) } : p))
  useDraftObject(plane?.target?.objectId)
  const [note, setNote] = useState<string | null>(edit && 'note' in edit ? edit.note : null)
  const bed = useApp((s) => s.bed)

  const onPick = useCallback(
    (hit: PickEvent) => {
      setNote(null)
      const e = hit.objectId ? get().plate.find((p) => p.id === hit.objectId) : undefined
      const part = e?.parts[hit.partIndex ?? 0]
      if (e && part && hit.point && hit.triangle !== null) {
        void pickFace({ mesh: toGeom(part), transform: e.transform }, { triangle: hit.triangle, at: hit.point }).then(
          (f) => setPlane({ frame: f.frame, outline: f.outline, target: { objectId: e.id, partIndex: hit.partIndex ?? 0 }, label: `A face of ${e.name}`, min: [f.min[0] - 10, f.min[1] - 10], max: [f.max[0] + 10, f.max[1] + 10] }),
          (err: unknown) => setNote(pickWords(err, true)),
        )
      } else if (hit.bed) setPlane({ frame: BED_FRAME, outline: [], label: 'The bed', min: [0, 0], max: [bed.widthMm, bed.depthMm] })
    },
    [bed],
  )
  useProbe(onPick, plane === null)

  if (!plane) {
    return (
      <Shell title="Sketch" aside="No plane yet">
        <p className="cad-hint"><Icon name="mouse-left" size={15} /> Click the bed or a flat face to sketch on.</p>
        {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
        <div className="cad-actions">
          <Button variant="ghost" onClick={close}>Cancel</Button>
        </div>
      </Shell>
    )
  }
  return <SketchEditor plane={plane} onRestart={() => setPlane(null)} {...(edit && 'init' in edit ? { init: edit.init } : {})} />
}

function SketchEditor({ plane, onRestart, init }: { plane: Plane; onRestart: () => void; init?: SketchInit }) {
  const host = useHost()
  const view = cameraBus()?.cad
  const [sketch, setSketch] = useDraft<Entity[]>('sketch', init?.sketch ?? [])
  const [draft, setDraft] = useDraft<Draft>('draft', emptyDraft(init ? 'select' : 'line'))
  const [selected, setSelected] = useDraft<{ e: number; seg: number } | null>('selected', init?.axis ?? null)
  const [grid, setGrid] = useDraft('grid', '1')
  const [check, setCheck] = useState<SketchCheck | null>(null)
  const [engineSnaps, setEngineSnaps] = useState<SnapTargets>({ points: [], edges: [] })
  const [field, setField] = useState<{ x: number; y: number; values: string[]; focus: number } | null>(null)
  const [finish, setFinish] = useDraft<'extrude' | 'revolve'>('finish', init?.finish ?? 'extrude')
  const [distance, setDistance] = useDraft('distance', init?.fields.distance ?? '5')
  const [extentKind, setExtentKind] = useDraft<'oneSide' | 'symmetric' | 'twoSides'>('extentKind', init?.fields.extent ?? 'oneSide')
  const [distance2, setDistance2] = useDraft('distance2', init?.fields.distance2 ?? '5')
  const [taper, setTaper] = useDraft('taper', init?.fields.taper ?? '0')
  const [flip, setFlip] = useDraft('flip', init?.fields.flip ?? false)
  const [angle, setAngle] = useDraft('angle', init?.fields.angle ?? '360')
  const [patternFields, setPatternFields] = useDraft<PatternFields>('patternFields', fieldsOf(init?.pattern))
  const [operation, setOperation] = useDraft<'new' | 'join' | 'cut'>('operation', init?.operation ?? (plane.target ? 'join' : 'new'))
  const [offset, setOffset] = useDraft('offset', '1')
  const [corner, setCorner] = useDraft('corner', '2')
  const [cornerKind, setCornerKind] = useDraft<'fillet' | 'chamfer'>('cornerKind', 'fillet')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const readoutRef = useRef<HTMLSpanElement | null>(null)
  const gridMm = grid === 'off' ? 0 : Number(grid)

  // What the hover path reads without a render.
  const live = useRef({ sketch, draft, selected, gridMm, engineSnaps, cursor: [0, 0] as V2, screen: [0, 0] as [number, number] })
  live.current = { ...live.current, sketch, draft, selected, gridMm, engineSnaps }

  // Snap targets on the plane: the picked face's outline, and edges of bodies lying in the plane.
  useEffect(() => {
    const ac = new AbortController()
    const meshes: MeshItem[] = get()
      .plate.filter((e) => !plane.target || e.id === plane.target.objectId)
      .filter((e) => e.parts.reduce((n, p) => n + p.indices.length / 3, 0) < 300_000)
      .map((e) => ({ mesh: wholeMesh(e), transform: e.transform }))
    sketchSnaps(plane.frame, plane.outline, meshes, undefined, ac.signal).then(
      (s) => !ac.signal.aborted && setEngineSnaps({ points: s.points.map((p) => ({ at: p.at, kind: p.kind })), edges: s.edges }),
      () => undefined,
    )
    return () => ac.abort()
  }, [plane])

  // sketch.check runs a moment after each change.
  useEffect(() => {
    if (!sketch.length) return void setCheck(null)
    const ac = new AbortController()
    const t = setTimeout(() => {
      checkSketch(toLoops(sketch), ac.signal).then(
        (c) => !ac.signal.aborted && setCheck(c),
        (e: unknown) => !ac.signal.aborted && setNote(errorText(e)),
      )
    }, 100)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [sketch])

  // The chain being drawn is open on purpose; its open end is not a problem yet.
  const issues = useMemo(() => (check?.issues ?? []).filter((i) => !(i.kind === 'open' && i.loop === draft.chain)), [check, draft.chain])
  const hs = useMemo(() => handles(sketch), [sketch])
  const axis = finish === 'revolve' ? axisOf(sketch, selected) : null

  // The drawn sketch to the view: on edits, never per cursor move.
  useEffect(() => {
    if (!view) return
    const paths: SketchScene['paths'][number][] = engineSnaps.edges.map((e) => ({ points: [e.a, e.b], tone: 'soft' as SketchTone }))
    const bad = new Set(issues.map((i) => `${i.loop}:${i.segment ?? -1}`))
    sketch.forEach((e, i) => {
      for (const p of entityPaths(e)) {
        const isSel = selected?.e === i && selected.seg === p.seg
        const tone: SketchTone = bad.has(`${i}:${p.seg}`) || bad.has(`${i}:-1`) ? 'issue' : isSel ? (finish === 'revolve' && axis ? 'axis' : 'selected') : 'normal'
        paths.push({ points: p.points, ...(p.closed ? { closed: true } : {}), tone })
      }
    })
    view.setSketch({
      frame: plane.frame,
      paths,
      handles: draft.tool === 'select' ? hs.points : [...hs.points, ...draft.points],
      dragHandles: draft.tool === 'select',
      ...(gridMm > 0 ? { grid: { stepMm: gridMm * 10, min: plane.min, max: plane.max } } : {}),
      marks: issues.flatMap((i) => (i.at ? [i.at] : [])),
    })
  }, [view, plane, sketch, draft, selected, issues, hs, gridMm, engineSnaps, finish, axis])
  useEffect(() => () => view?.setSketch(null), [view])

  const targets = (skip?: Parameters<typeof sketchTargets>[1]): SnapTargets[] => [live.current.engineSnaps, sketchTargets(live.current.sketch, skip)]

  // Events from the view.
  useEffect(() => {
    if (!view) return
    return view.on('sketch', (ev: SketchEvent) => {
      const l = live.current
      const tol = SNAP_PX * ev.mmPerPx
      const anchor = l.draft.points.length ? l.draft.points[l.draft.points.length - 1]! : null
      if (ev.kind === 'hover' || ev.kind === 'click') {
        const s = ev.alt ? { at: ev.at, kind: null } : snap(ev.at, targets(), { anchor: l.draft.tool === 'line' || l.draft.tool === 'arc' ? anchor : null, gridMm: l.gridMm, tolMm: tol })
        l.cursor = s.at
        l.screen = ev.screen
        if (ev.kind === 'hover') {
          view.setSketchCursor({ path: preview(l.draft, s.at), at: s.at, guide: 'guide' in s && s.guide ? s.guide : null })
          const r = readoutRef.current
          if (r) r.textContent = `${l.draft.tool === 'select' ? '' : readout(l.draft, s.at)}${s.kind ? `${l.draft.tool === 'select' ? '' : ', '}snap: ${SNAP_NAMES[s.kind].toLowerCase()}` : ''}`
          return
        }
        if (l.draft.tool === 'select') {
          setSelected(hitTest(l.sketch, ev.at, tol))
          return
        }
        const r = click(l.sketch, l.draft, s.at)
        setSketch(r.sketch)
        setDraft(r.draft)
        setField(null)
        return
      }
      if (ev.kind === 'context') {
        // A right click ends the line being drawn.
        setDraft(emptyDraft(l.draft.tool))
        view.setSketchCursor(null)
        return
      }
      if (ev.kind === 'drag' && ev.handle !== undefined) {
        const ref = handles(l.sketch).refs[ev.handle]
        if (!ref) return
        const s = ev.alt ? { at: ev.at } : snap(ev.at, targets(ref), { gridMm: l.gridMm, tolMm: tol })
        setSketch(moveHandle(l.sketch, ref, s.at))
      }
    })
  }, [view])

  // Typing a number with a drawing tool opens the field at the cursor; Delete removes the picked segment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const l = live.current
      if (/^[0-9.\-]$/.test(e.key) && l.draft.tool !== 'select' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setField({ x: l.screen[0], y: l.screen[1], values: [e.key, ''], focus: 0 })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && l.draft.tool === 'select') {
        const sel = l.selected
        if (sel) {
          setSketch(deleteSegment(l.sketch, sel.e, sel.seg))
          setSelected(null)
        }
      } else if (e.key === 'Escape' || e.key === 'Enter') {
        if (l.draft.points.length) {
          // the line being drawn ends; the tool's own Esc and Enter wait for the next press
          e.preventDefault()
          setDraft(emptyDraft(l.draft.tool))
          view?.setSketchCursor(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const commitField = () => {
    if (!field) return
    const values = field.values.map((v) => (v.trim() === '' ? null : Number.isFinite(num(v)) ? num(v) : NaN))
    if (values.some((v) => Number.isNaN(v))) return setNote('Type numbers only.')
    const p = typedPoint(draft, values, live.current.cursor)
    if (typeof p === 'string') return setNote(p)
    setNote(null)
    const r = click(sketch, draft, p)
    setSketch(r.sketch)
    setDraft(r.draft)
    setField(null)
  }

  const pickTool = (t: DrawTool) => {
    setDraft(emptyDraft(t))
    setField(null)
    view?.setSketchCursor(null)
    if (t !== 'select') setSelected(null)
  }

  const look = () => {
    const ext = extent(sketch)
    const c: V2 = ext ? ext.center : [(plane.min[0] + plane.max[0]) / 2, (plane.min[1] + plane.max[1]) / 2]
    const r = ext ? ext.radius * 1.4 : Math.hypot(plane.max[0] - plane.min[0], plane.max[1] - plane.min[1]) / 2
    view?.lookAtPlane(frameToBed(plane.frame, c), plane.frame.normal, r)
  }

  const doOffset = async () => {
    if (!selected) return
    const d = num(offset)
    if (!Number.isFinite(d) || d === 0) return setNote('The offset must be a number other than 0 mm; negative shrinks.')
    setNote(null)
    try {
      const r = await offsetSketch({ loops: toLoops([sketch[selected.e]!]) }, d)
      const added = r.polygons.flatMap((p) => [p.outer, ...p.holes]).map(polylineToChain).filter((c): c is NonNullable<typeof c> => c !== null)
      setSketch((s) => [...s, ...added])
    } catch (e) {
      setNote(errorText(e))
    }
  }

  /** Rounds or bevels the picked line's corners, or every corner of its loop, with the engine's sketch corner ops. */
  const doCorners = async (whole: boolean) => {
    if (!selected) return
    const c = sketch[selected.e]
    const d = num(corner)
    if (!c || c.kind !== 'chain') return setNote('Pick a line of a drawn loop; circles have no corners.')
    if (!(d > 0)) return setNote('The corner size must be more than 0 mm.')
    const vertices = straightCorners(c, whole ? undefined : selected.seg)
    if (!vertices.length) return setNote(whole ? 'This loop has no corner between two straight lines.' : 'Neither end of this line is a corner between two straight lines.')
    setNote(null)
    try {
      const corners = vertices.map((vertex) => ({ loop: selected.e, vertex }))
      const r = cornerKind === 'fillet' ? await filletSketch(toLoops(sketch), corners, d) : await chamferSketch(toLoops(sketch), corners, d)
      const next = fromLoops(r.loops)
      if (!next) throw new Error('The rounded sketch could not be shown.')
      setSketch(next)
      setSelected(null)
    } catch (e) {
      setNote(errorText(e))
    }
  }

  const op = plane.target ? operation : 'new'
  // The switch shows where the extrusion goes; the engine's flip is relative to the operation.
  const intoFace = goesIntoFace(flip, op)
  const setIntoFace = (on: boolean) => setFlip(flipFor(on, op))
  const loops = toLoops(sketch)
  // A sketch step opened from the history saves into its place; the steps after it run again.
  const saveSketch = async (params: Parameters<typeof saveEdit>[1]) => {
    await saveEdit(host.slicer, params)
    return { message: `Changed step ${(init?.index ?? 0) + 1} and ran the steps after it.`, warn: false }
  }
  const ready = sketch.length > 0 && check?.ok === true && draft.points.length === 0 && issues.length === 0
  const go = async () => {
    if (!ready) return
    setBusy(true)
    setNote(null)
    try {
      const target = op !== 'new' && plane.target ? { target: plane.target } : {}
      let r: { message: string; warn: boolean }
      if (finish === 'extrude') {
        const d = num(distance)
        if (!(d > 0)) throw new Error('The distance must be more than 0 mm.')
        const d2 = num(distance2)
        if (extentKind === 'twoSides' && !(d2 > 0)) throw new Error('The second distance must be more than 0 mm.')
        const tp = num(taper)
        if (!Number.isFinite(tp) || Math.abs(tp) > 45) throw new Error('The draft is between -45 and 45 degrees.')
        const pattern = patternFromFields(patternFields)
        const bad = pattern ? patternProblem(pattern) : null
        if (bad) throw new Error(bad)
        bindNext(distance)
        const input: ExtrudeInput = { frame: plane.frame, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm: d, extent: extentKind, ...(extentKind === 'twoSides' ? { distance2Mm: d2 } : {}), ...(flip ? { flip } : {}), ...(tp ? { taperDeg: tp } : {}), operation: op }, ...target, name: 'Sketch body', ...(pattern ? { pattern } : {}) }
        r = init ? await saveSketch(extrudeParams(input)) : await applyExtrude(host.slicer, input)
      } else {
        if (!axis) throw new Error('Pick a straight line of the sketch as the axis.')
        const a = num(angle)
        if (!(a > 0 && a <= 360)) throw new Error('The angle is more than 0 and at most 360 degrees.')
        bindNext(angle)
        const input: RevolveInput = { frame: plane.frame, loops, axis, angleDeg: a, operation: op, ...target, name: 'Revolved body' }
        r = init ? await saveSketch(revolveParams(input)) : await applyRevolve(host.slicer, input)
      }
      toast(r.message, r.warn ? 'warn' : 'ok')
      set({ objectTool: null })
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const fields = fieldsFor(draft)
  const sel = selected ? sketch[selected.e] : undefined
  return (
    <Shell title="Sketch" aside={plane.label}>
      <Seg label="Drawing tool" size="sm" full value={draft.tool} onChange={pickTool} options={TOOLS} />
      <p className="cad-hint" role="status">
        <Icon name="mouse-left" size={15} />{' '}
        <span>
          {draft.tool === 'select' ? 'Click a line to pick it, drag a point to move it. Delete removes the picked line.' : draft.tool === 'line' ? 'Click point after point. Click the first point to close, right click to stop.' : draft.tool === 'rect' ? 'Click two opposite corners.' : draft.tool === 'circle' ? 'Click the center, then a point on the rim.' : 'Click the start, the end, then a point on the arc.'}{' '}
          {draft.tool !== 'select' ? 'Type a number to give exact sizes.' : ''}
        </span>
      </p>
      <p className="cad-hint sketch-readout"><span ref={readoutRef} className="sx-mono" aria-live="off" /></p>
      <div className="cad-pair">
        <Field htmlFor="sk-grid" label="Grid snap">
          <Select id="sk-grid" value={grid} onChange={(e) => setGrid(e.target.value)}>
            <option value="off">Off</option>
            <option value="0.5">0.5 mm</option>
            <option value="1">1 mm</option>
            <option value="5">5 mm</option>
          </Select>
        </Field>
        <Button size="sm" variant="ghost" icon="top-view" data-tip="sketch.look" onClick={look}>Look at the sketch</Button>
      </div>
      {issues.length ? (
        <ul className="cad-issues" role="status">
          {issues.slice(0, 6).map((i, k) => (
            <li key={k}><Icon name="alert" size={14} /> {i.message}</li>
          ))}
        </ul>
      ) : null}
      {draft.tool === 'select' && sel ? (
        <div className="cad-row">
          <Num id="sk-offset" label="Offset this loop" unit="mm" value={offset} onChange={setOffset} onEnter={() => void doOffset()} />
          <Button size="sm" variant="ghost" onClick={() => void doOffset()}>Offset</Button>
          <Button size="sm" variant="ghost" icon="delete" onClick={() => { setSketch((s) => s.filter((_, i) => i !== selected!.e)); setSelected(null) }}>Delete loop</Button>
        </div>
      ) : null}
      {draft.tool === 'select' && sel?.kind === 'chain' ? (
        <>
          <div className="cad-row">
            <Seg label="Corner shape" size="sm" value={cornerKind} onChange={setCornerKind} options={[{ value: 'fillet', label: 'Round' }, { value: 'chamfer', label: 'Bevel' }]} />
            <Num id="sk-corner" label={cornerKind === 'fillet' ? 'Radius' : 'Distance'} unit="mm" value={corner} onChange={setCorner} onEnter={() => void doCorners(false)} />
          </div>
          <div className="cad-row">
            <Button size="sm" variant="ghost" data-tip="sketch.corners" onClick={() => void doCorners(false)}>Corners of this line</Button>
            <Button size="sm" variant="ghost" onClick={() => void doCorners(true)}>Every corner of the loop</Button>
          </div>
        </>
      ) : null}
      <Seg label="Finish with" size="sm" full value={finish} onChange={setFinish} options={[{ value: 'extrude', label: 'Extrude' }, { value: 'revolve', label: 'Revolve' }]} />
      {finish === 'extrude' ? (
        <>
          <div className="cad-row">
            <span>Direction</span>
            <Seg label="Direction" size="sm" value={extentKind} onChange={setExtentKind} options={[{ value: 'oneSide', label: 'One side' }, { value: 'symmetric', label: 'Symmetric' }, { value: 'twoSides', label: 'Two sides' }]} />
          </div>
          <div className="cad-pair">
            <Num id="sk-dist" label={extentKind === 'symmetric' ? 'Total distance' : 'Distance'} unit="mm" value={distance} onChange={setDistance} onEnter={() => void go()} />
            {extentKind === 'twoSides' ? <Num id="sk-dist2" label="Other side" unit="mm" value={distance2} onChange={setDistance2} /> : <Num id="sk-taper" label="Draft" unit="°" value={taper} onChange={setTaper} />}
          </div>
          <div className="cad-row">
            <label htmlFor="sk-flip">Extrude into the face</label>
            <Switch id="sk-flip" checked={intoFace} onChange={setIntoFace} label="Extrude into the face" />
          </div>
          <PatternSection value={patternFields} onChange={setPatternFields} />
        </>
      ) : (
        <>
          <p className="cad-hint"><Icon name="info" size={15} /> {axis ? 'The picked line is the axis.' : 'Pick a straight line of the sketch with Select: it becomes the axis.'}</p>
          <Num id="sk-angle" label="Angle" unit="°" value={angle} onChange={setAngle} onEnter={() => void go()} />
        </>
      )}
      <div className="cad-row">
        <span>Result</span>
        <Seg label="Result" size="sm" value={op} onChange={setOperation} options={[{ value: 'join', label: 'Join', disabled: !plane.target }, { value: 'cut', label: 'Cut', disabled: !plane.target }, { value: 'new', label: 'New body' }]} />
      </div>
      <p className="cad-hint"><Icon name="info" size={15} /> {init ? 'Applying changes this step; the steps after it run again.' : 'Finishing turns the sketch into a solid. The sketch stays in the object\'s history, so you can open it again there.'}</p>
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <ToolFooter
        verb={finish === 'extrude' ? 'Extrude' : 'Revolve'}
        onApply={go}
        busy={busy}
        disabled={!ready}
        extra={<Button variant="ghost" onClick={onRestart} disabled={busy}>Other plane</Button>}
      />
      {field && fields.length
        ? createPortal(
            <CursorField
              x={field.x}
              y={field.y}
              labels={fields.map((f) => `${f.label} ${f.unit}`)}
              values={field.values}
              onChange={(values) => setField({ ...field, values })}
              onCommit={commitField}
              onCancel={() => setField(null)}
            />,
            document.body,
          )
        : null}
    </Shell>
  )
}

/** The small field at the cursor: one or two numbers, Tab between them, Enter to place, Escape to drop. */
function CursorField({ x, y, labels, values, onChange, onCommit, onCancel }: { x: number; y: number; labels: string[]; values: string[]; onChange: (v: string[]) => void; onCommit: () => void; onCancel: () => void }) {
  const first = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const el = first.current
    if (!el) return
    el.focus()
    // The key that opened the field is already in it; the caret goes after it.
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div className="sketch-field" style={{ left: x + 14, top: y + 14 }} role="group" aria-label="Exact size">
      {labels.map((label, i) => (
        <label key={label}>
          <span>{label}</span>
          <input ref={i === 0 ? first : undefined} className="sx-input" data-mono data-size="sm" inputMode="decimal" aria-label={label} value={values[i] ?? ''} onChange={(e) => onChange(values.map((v, k) => (k === i ? e.target.value : v)))} onKeyDown={onKey} />
        </label>
      ))}
    </div>
  )
}
