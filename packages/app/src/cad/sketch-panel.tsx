// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sketch mode. Pick the bed or a flat face, draw lines, rectangles, circles and three point arcs on
// it with snaps and typed sizes, fix what sketch.check reports, then extrude or revolve. The camera
// stays free; "Look at the sketch" turns it square on. Constraints go through the engine's solver
// (sketch-constraints.ts), and the palette says how defined the sketch is. Finishing records the
// sketch as a step of the object's history, where it opens again in this panel to be changed.
//
// Speed: the view reports the cursor at most once a frame (viewport cadtools.ts). The hover path
// here snaps, moves the rubber band in its fixed buffer and writes one text node; it renders no
// React. React renders on clicks, drags of points and edits only.
import { patternFromFields, patternProblem, type Pattern, type PatternFields } from '@slicerx/cad-history'
import { afterLoopChange, afterReverse, curveStates, dimMark, dofText, dofTone, fromSolver, sketchMarks, toSolver, type DefState, type SketchConstraint, type SketchDim, type SketchGlyph, type Solved, type SolverMap } from './sketch-constraints'
import { dimensionFor, isDimension, measured, pointAt, pointHit, type DimPick } from './sketch-dimension'
import { evaluate, namesIn } from './values'
import { fieldsOf, PatternSection } from './pattern-fields'
import { originFrame, type PickEvent, type SketchEvent, type SketchScene, type SketchTone } from '@slicerx/viewport'
import { Button, Field, Icon, Seg, Select, Switch, type SegOption } from '@slicerx/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePhoneLayout } from '../lib/phone-layout'
import { claimPhoneSketchSlot, usePhoneSketchSlot } from '../workspaces/design/phone-slot'
import { touchWords } from './touch-words'
import { checkSketch, extendSketch, mirrorSketch, offsetSketch, patternSketch, pickFace, sketchSnaps, solveSketch, trimSketch, type FaceFrame, type MeshItem, type Polygon, type SketchCheck } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { useShownOrigin } from '../state/model-mode'
import { get, set, toast, useApp } from '../state/store'
import { applyExtrude, applyRevolve, BED_FRAME, extrudeParams, frameToBed, revolveParams, wholeMesh, type ExtrudeInput, type RevolveInput } from './cad-ops'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext, sketchNext } from './history/record'
import { defaultTarget, finishSketch, provideFinish, provideInUse, sketchById, takeSketchOpen, updateSketch, type SketchOpen } from './sketches'
import { chamferSketch, filletSketch } from './edge-api'
import { afterEdit, endNear, mirrorConstraints } from './sketch-edit'
import { flipFor, goesIntoFace } from './extrude-direction'
import { Actions, Choice, close, errorText, Message, Note, num, Num, pickWords, PointerHint, Row, Shell, useProbe, ToolFooter } from './panel-kit'
import { useDraft, useDraftObject } from './park'
import { formatLength, fraction, parseLength, type UnitPrefs } from './units'
import { currentValues } from './value-table'
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
  segStart,
  sketchTargets,
  snap,
  toLoops,
  typedPoint,
  type Draft,
  type DrawTool,
  type Entity,
  type HandleRef,
  type SnapTargets,
  type V2,
  pickedText,
  profileRings,
  toggleConstruction,
  dist,
  dragArc,
  dragArcPreview,
  lineArcFrom,
} from './sketch-model'
import { inferred, reversedChain, type Landing } from './sketch-infer'

interface Plane {
  frame: FaceFrame
  outline: Polygon[]
  target?: { objectId: string; partIndex: number }
  label: string
  /** The area worth a grid, in plane coordinates. */
  min: V2
  max: V2
  /** Just picked: the camera turns square on to it as the sketch opens. */
  fresh?: boolean
}

/** What each tool wants clicked, in order. */
const HINTS: Record<DrawTool, string> = {
  select: 'Click a line to pick it, drag a point to move it. Delete removes it, X makes it construction.',
  line: 'Click point after point, or drag from the end for a tangent arc. Click the first point to close, right click to stop.',
  rect: 'Click two opposite corners.',
  rect3: 'Click the two ends of one edge, then out to the width.',
  rectCenter: 'Click the center, then a corner.',
  circle: 'Click the center, then a point on the rim.',
  circle2: 'Click the two ends of a diameter.',
  arc: 'Click the start, the end, then a point on the arc.',
  arcCenter: 'Click the center, the start, then where it ends.',
  arcTangent: 'Click the open end of a line or arc, then where the arc ends.',
  polygon: 'Click the center, then a corner.',
  polygonOut: 'Click the center, then the middle of an edge.',
  polygonEdge: 'Click the two ends of one edge, then the side it goes on.',
  slot: 'Click the two arc centers, then out to the width.',
  slotOverall: 'Click the two ends, then out to the width.',
  slotCenter: 'Click the center, an arc center, then out to the width.',
  dimension: 'Click a line, a circle or two points, then where the value goes. Type the size and press Enter.',
  trim: 'Click the piece of a curve to take off. It goes back to the nearest crossings.',
  extend: 'Click near the open end of a line or arc to run it on to the next curve.',
}

/** What Mirror and a round Pattern wait for, in place of the tool's hint. */
const PENDING_HINTS = { mirror: 'Click the straight line to mirror across. Esc stops.', round: 'Click the point to pattern round. Esc stops.' }

const hintText = (t: DrawTool): string => `${HINTS[t]}${t !== 'select' && t !== 'dimension' && t !== 'trim' && t !== 'extend' ? ' Type a number to give exact sizes.' : ''}`
// the longest hint sizes the hint's box, so picking a tool moves nothing below it
const HINT_SIZER = (Object.keys(HINTS) as DrawTool[]).map(hintText).reduce((a, b) => (b.length > a.length ? b : a))

/** Fusion's keys for the sketch tools it gives one. */
const TOOL_KEYS: Record<string, DrawTool> = { l: 'line', r: 'rect', c: 'circle', d: 'dimension', t: 'trim' }

type Family = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'slot' | 'trim' | 'dimension'

/** The tool families, as icons; a family with ways to draw it shows them in the row below. */
const FAMILIES: SegOption<Family>[] = [
  { value: 'select', label: '', icon: 'select-object', title: 'Select' },
  { value: 'line', label: '', icon: 'sk-line', title: 'Line', tip: { title: 'Line', key: 'L' } },
  { value: 'rect', label: '', icon: 'sk-rect', title: 'Rectangle', tip: { title: 'Rectangle', key: 'R' } },
  { value: 'circle', label: '', icon: 'sk-circle', title: 'Circle', tip: { title: 'Circle', key: 'C' } },
  { value: 'arc', label: '', icon: 'sk-arc', title: 'Arc' },
  { value: 'polygon', label: '', icon: 'sk-polygon', title: 'Polygon' },
  { value: 'slot', label: '', icon: 'sk-slot', title: 'Slot' },
  { value: 'trim', label: '', icon: 'cut', title: 'Trim', tip: { title: 'Trim', key: 'T' } },
  { value: 'dimension', label: '', icon: 'ruler', title: 'Dimension', tip: { title: 'Dimension', key: 'D' } },
]

const VARIANTS: Partial<Record<Family, SegOption<DrawTool>[]>> = {
  rect: [{ value: 'rect', label: '2-point' }, { value: 'rect3', label: '3-point' }, { value: 'rectCenter', label: 'Center' }],
  circle: [{ value: 'circle', label: 'Center' }, { value: 'circle2', label: '2-point' }],
  arc: [{ value: 'arc', label: '3-point' }, { value: 'arcCenter', label: 'Center' }, { value: 'arcTangent', label: 'Tangent' }],
  polygon: [{ value: 'polygon', label: 'Inscribed' }, { value: 'polygonOut', label: 'Circumscribed' }, { value: 'polygonEdge', label: 'Edge' }],
  slot: [{ value: 'slot', label: 'Center to center' }, { value: 'slotOverall', label: 'Overall' }, { value: 'slotCenter', label: 'Center point' }],
  trim: [{ value: 'trim', label: 'Trim' }, { value: 'extend', label: 'Extend' }],
}

const familyOf = (t: DrawTool): Family => (Object.entries(VARIANTS).find(([, v]) => v.some((o) => o.value === t))?.[0] as Family | undefined) ?? (t as Family)

/** The way each family was last drawn this session, so picking the family again draws it the same way. */
const lastVariant: Partial<Record<Family, DrawTool>> = {}

/** The sketch palette's toggles, kept for the session. */
export interface SketchLook {
  grid: boolean
  snap: boolean
  /** The snap step, mm; the grid draws a line every ten steps. */
  step: string
  section: boolean
  profiles: boolean
  points: boolean
  dimensions: boolean
  constraints: boolean
}
let sessionLook: SketchLook = { grid: true, snap: true, step: '1', section: false, profiles: true, points: true, dimensions: true, constraints: true }

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
  constraints: SketchConstraint[]
  /** A finished sketch opened from the timeline, rather than a step of a body. */
  from?: SketchOpen
  /** For Extrude or Revolve from a finished sketch: the body Join and Cut start on */
  target?: { objectId: string; partIndex: number } | null
}

function sketchEdit(bed: { widthMm: number; depthMm: number }): { plane: Plane; init: SketchInit } | { note: string } | null {
  const ed = editing()
  const p = ed?.step.params
  if (!ed || !p || !((p.op === 'shape.extrude' && p.shape.type === 'sketch') || p.op === 'sketch.revolve')) return null
  const loops = p.op === 'sketch.revolve' ? p.loops : p.shape.type === 'sketch' ? p.shape.loops : []
  const sketch = fromLoops(loops)
  const constraints = (p.op === 'sketch.revolve' ? p.constraints : p.shape.type === 'sketch' ? p.shape.constraints : undefined) ?? []
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
      constraints,
      ...(p.op === 'shape.extrude' && p.pattern ? { pattern: p.pattern } : {}),
    },
  }
}

/** A finished sketch from the timeline as the editor's starting state. */
function finishedEdit(open: SketchOpen, bed: { widthMm: number; depthMm: number }): { plane: Plane; init: SketchInit } | { note: string } | null {
  const k = sketchById(get().timeline, open.id)
  if (!k) return null
  const sketch = fromLoops(k.loops)
  if (!sketch) return { note: 'This sketch has segments given by length and angle, which sketch mode cannot show.' }
  const ext = extent(sketch)
  const r = ext ? ext.radius + 20 : 50
  const c = ext?.center ?? [0, 0]
  const target = defaultTarget(k, get().plate)
  const plane: Plane = {
    frame: k.frame ?? BED_FRAME,
    outline: [],
    label: k.name,
    min: k.frame ? [c[0] - r, c[1] - r] : [0, 0],
    max: k.frame ? [c[0] + r, c[1] + r] : [bed.widthMm, bed.depthMm],
  }
  return {
    plane,
    init: {
      index: -1,
      sketch,
      finish: open.mode === 'revolve' ? 'revolve' : 'extrude',
      fields: { distance: '5', extent: 'oneSide', distance2: '5', taper: '0', flip: false, angle: '360' },
      // a sketch drawn on a face joins it, as it would have before Finish sketch
      operation: target && k.on?.body === target.objectId ? 'join' : 'new',
      axis: null,
      constraints: (k.constraints ?? []) as SketchConstraint[],
      from: open,
      ...(open.mode === 'edit' ? {} : { target }),
    },
  }
}

export function SketchTool() {
  const bedSize = useApp((s) => s.bed)
  const [edit] = useState(() => {
    const open = takeSketchOpen()
    return open ? finishedEdit(open, bedSize) : sketchEdit(bedSize)
  })
  // A plane on a part that moved in Slice moves with it.
  const [plane, setPlane] = useDraft<Plane | null>('plane', edit && 'plane' in edit ? edit.plane : null, (p, now) => (p && now ? { ...p, frame: now.frame(p.frame) } : p))
  useDraftObject(plane?.target?.objectId)
  const [note, setNote] = useState<string | null>(edit && 'note' in edit ? edit.note : null)
  const bed = useApp((s) => s.bed)
  const { origin } = useShownOrigin()
  // Before a pick, the origin planes show at the origin, a third of the bed across.
  const planeSize = Math.min(bed.widthMm, bed.depthMm) / 3
  useEffect(() => {
    const view = cameraBus()?.cad
    if (!view || plane) return
    view.setOriginPlanes({ center: origin, sizeMm: planeSize })
    return () => view.setOriginPlanes(null)
  }, [plane, origin, planeSize])

  const onPick = useCallback(
    (hit: PickEvent) => {
      setNote(null)
      const e = hit.objectId ? get().plate.find((p) => p.id === hit.objectId) : undefined
      const part = e?.parts[hit.partIndex ?? 0]
      if (e && part && hit.point && hit.triangle !== null) {
        void pickFace({ mesh: toGeom(part), transform: e.transform }, { triangle: hit.triangle, at: hit.point }).then(
          (f) => setPlane({ frame: f.frame, outline: f.outline, target: { objectId: e.id, partIndex: hit.partIndex ?? 0 }, label: `A face of ${e.name}`, min: [f.min[0] - 10, f.min[1] - 10], max: [f.max[0] + 10, f.max[1] + 10], fresh: true }),
          (err: unknown) => setNote(pickWords(err, true)),
        )
      } else if (hit.originPlane) {
        const frame = originFrame(hit.originPlane, origin)
        const r = planeSize
        setPlane({ frame, outline: [], label: `The ${hit.originPlane.toUpperCase()} plane`, min: [-r, -r], max: [r, r], fresh: true })
      } else if (hit.bed) setPlane({ frame: BED_FRAME, outline: [], label: 'The bed', min: [0, 0], max: [bed.widthMm, bed.depthMm], fresh: true })
    },
    [bed, origin, planeSize],
  )
  useProbe(onPick, plane === null)

  if (!plane) {
    return (
      <Shell title="Sketch" aside="No plane yet">
        <PointerHint text="Click an origin plane (XY, XZ or YZ), the bed or a flat face to sketch on." />
        {note ? <Message text={note} /> : null}
        <Actions quiet={<Button variant="ghost" onClick={close}>Cancel</Button>} />
      </Shell>
    )
  }
  return <SketchEditor plane={plane} onRestart={() => setPlane(null)} {...(edit && 'init' in edit ? { init: edit.init } : {})} />
}

const toneOf = (s: DefState | undefined): SketchTone => (s === 'defined' ? 'defined' : s === 'fixed' ? 'fixed' : 'normal')

/** The readout's length format and unit: two decimals in mm, the inch precision in inches. */
function readoutUnits(u: UnitPrefs): [(mm: number) => string, string] {
  return u.length === 'mm' ? [(v) => v.toFixed(2), 'mm'] : [(v) => formatLength(v, u), 'in']
}

// grid steps in mm, by the display unit; a step picked in the other unit stays listed
const GRID_MM = ['0.5', '1', '5']
const GRID_IN = ['0.79375', '1.5875', '3.175', '6.35']

function gridSteps(u: UnitPrefs, now: string): { value: string; label: string }[] {
  const list = u.length === 'mm' ? GRID_MM : GRID_IN
  const all = now !== 'off' && !list.includes(now) ? [...list, now].sort((a, b) => Number(a) - Number(b)) : list
  return all.map((v) => ({ value: v, label: u.length === 'mm' ? `${Number(v)} mm` : `${fraction(Number(v) / 25.4, 64)} in` }))
}

/** The dimension tool's value field: a new dimension being placed, or a kept one (`index`) being changed. */
interface DimField {
  x: number
  y: number
  c: Extract<SketchConstraint, { value: number }>
  index?: number
  text: string
}

const DIM_NAMES: Record<Extract<SketchConstraint, { value: number }>['type'], string> = {
  length: 'Length',
  distance: 'Distance',
  horizontalDistance: 'Horizontal',
  verticalDistance: 'Vertical',
  lineDistance: 'Distance',
  diameter: 'Diameter',
  radius: 'Radius',
  angle: 'Angle',
}

// a dimension's value as the field shows it, in the display unit
const dimValueText = (c: SketchConstraint, v: number, u: UnitPrefs): string => (c.type === 'angle' ? String(Number(v.toFixed(3))) : formatLength(v, u))

const samePick = (a: DimPick, b: DimPick): boolean => JSON.stringify(a) === JSON.stringify(b)

function SketchEditor({ plane, onRestart, init }: { plane: Plane; onRestart: () => void; init?: SketchInit }) {
  // Extrude or Revolve from a finished sketch's menu: only that feature's settings; Edit sketch changes the shape
  const featureOnly = init?.from !== undefined && init.from.mode !== 'edit'
  const host = useHost()
  const phone = usePhoneLayout()
  const view = cameraBus()?.cad
  const [sketch, setSketch] = useDraft<Entity[]>('sketch', init?.sketch ?? [])
  const [constraints, setConstraints] = useDraft<SketchConstraint[]>('constraints', init?.constraints ?? [])
  const [solved, setSolved] = useState<{ solved: Solved; map: SolverMap } | null>(null)
  const [draft, setDraft] = useDraft<Draft>('draft', emptyDraft(init ? 'select' : 'line'))
  const [selected, setSelected] = useDraft<{ e: number; seg: number } | null>('selected', init?.axis ?? null)
  const [pal, setPalState] = useState<SketchLook>(sessionLook)
  const setPal = (p: Partial<SketchLook>) => setPalState((l) => (sessionLook = { ...l, ...p }))
  const units = useApp((s) => s.units)
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
  const [copies, setCopies] = useDraft<{ kind: 'line' | 'circle'; count: string; dx: string; dy: string; angle: string }>('copies', { kind: 'line', count: '3', dx: '10', dy: '0', angle: '360' })
  // Mirror waits for its line, a round pattern for its center
  const [pending, setPending] = useState<{ kind: 'mirror' | 'round'; e: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // the dimension tool's picks so far, and its value field once the value is placed (or a kept one is edited)
  const [dimPicks, setDimPicks] = useState<DimPick[]>([])
  const [dimField, setDimField] = useState<DimField | null>(null)
  // a dimension or constraint glyph picked with Select, by constraint index
  const [pickedCon, setPickedCon] = useState<number | null>(null)
  const readoutRef = useRef<HTMLSpanElement | null>(null)
  // a new tool starts with an empty readout; Select's says what is picked
  useEffect(() => {
    if (readoutRef.current) readoutRef.current.textContent = draft.tool === 'select' ? pickedText(sketch, selected, ...readoutUnits(units)) : ''
  }, [draft.tool, selected, sketch, units])
  // a dimension typed with a name from the value table follows it: the value is read again as the sketch opens
  useEffect(() => {
    const u = get().units
    const values = currentValues()
    let changed = false
    const next = constraints.map((c) => {
      if (!isDimension(c) || !c.expr || c.driven) return c
      let v: number
      try {
        v = c.type === 'angle' ? evaluate(c.expr, (n) => values[n]) : parseLength(c.expr, u, values)
      } catch {
        return c
      }
      if (!Number.isFinite(v) || Math.abs(v - c.value) < 1e-9) return c
      changed = true
      return { ...c, value: v }
    })
    if (changed) setConstraints(next)
    // once, as the sketch opens
  }, [])
  const gridMm = pal.snap ? Number(pal.step) : 0
  // a polygon's side count, 3 to 64
  const [sides, setSides] = useDraft<string>('sides', '6')
  const sidesN = Math.max(3, Math.min(64, Math.round(Number(sides)) || 6))

  // What the hover path reads without a render.
  // landed: the clicks of the shape being drawn and what each snapped to, for the constraints it leaves
  // dims and glyphs: what the view shows, to read its picks by
  const live = useRef({ sketch, draft, selected, gridMm, engineSnaps, constraints, sides: sidesN, cursor: [0, 0] as V2, screen: [0, 0] as [number, number], landed: [] as Landing[], dimPicks, dimField, pickedCon, pending, copies, dims: [] as SketchDim[], glyphs: [] as SketchGlyph[], solved: solved?.solved ?? null })
  live.current = { ...live.current, sketch, draft, selected, gridMm, engineSnaps, constraints, sides: sidesN, dimPicks, dimField, pickedCon, pending, copies, solved: solved?.solved ?? null }

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

  // The solver runs a moment after each change: it says how defined the sketch is, and moves the drawing to meet
  // its constraints. A conflict leaves the drawing as it is.
  useEffect(() => {
    if (!sketch.length) return void setSolved(null)
    const ac = new AbortController()
    const t = setTimeout(() => {
      const { solver, map } = toSolver(sketch, constraints)
      solveSketch(solver, undefined, ac.signal).then(
        (s) => {
          if (ac.signal.aborted) return
          setSolved({ solved: s, map })
          if ((s.status === 'ok' || s.status === 'redundant') && solver.constraints.length) {
            const next = fromSolver(sketch, s, map)
            if (JSON.stringify(next) !== JSON.stringify(sketch)) setSketch(next)
          }
        },
        (e: unknown) => !ac.signal.aborted && setNote(errorText(e)),
      )
    }, 60)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [sketch, constraints])
  const states = useMemo(() => (solved ? curveStates(sketch, constraints, solved.solved, solved.map) : null), [solved, sketch, constraints])

  // The chain being drawn is open on purpose; its open end is not a problem yet.
  const issues = useMemo(() => (check?.issues ?? []).filter((i) => !(i.kind === 'open' && i.loop === draft.chain)), [check, draft.chain])
  const hs = useMemo(() => handles(sketch), [sketch])
  const axis = finish === 'revolve' ? axisOf(sketch, selected) : null

  // The drawn sketch to the view: on edits, never per cursor move.
  const marks = useMemo(() => sketchMarks(sketch, constraints, (c) => measured(sketch, c), (mm) => formatLength(mm, units)), [sketch, constraints, units])
  const arcFrom = useMemo(() => lineArcFrom(sketch, draft), [sketch, draft])
  useEffect(() => {
    if (!view) return
    const paths: SketchScene['paths'][number][] = engineSnaps.edges.map((e) => ({ points: [e.a, e.b], tone: 'soft' as SketchTone }))
    // crossings and open ends are what Trim and Extend work on and leave, so they do not show as problems then; red is
    // what a trim takes off
    const trimming = draft.tool === 'trim' || draft.tool === 'extend'
    const shown = trimming ? issues.filter((i) => i.kind !== 'loopsCross' && i.kind !== 'selfCrossing' && i.kind !== 'open') : issues
    const bad = new Set(shown.map((i) => `${i.loop}:${i.segment ?? -1}`))
    const dimCurves = new Set(dimPicks.flatMap((p) => ('curve' in p ? [`${p.curve.e}:${p.curve.seg}`] : [])))
    sketch.forEach((e, i) => {
      for (const p of entityPaths(e)) {
        const isSel = (selected?.e === i && selected.seg === p.seg) || dimCurves.has(`${i}:${p.seg}`)
        const tone: SketchTone = bad.has(`${i}:${p.seg}`) || bad.has(`${i}:-1`) ? 'issue' : isSel ? (finish === 'revolve' && axis ? 'axis' : 'selected') : e.construction ? 'construction' : toneOf(states?.get(`${i}:${p.seg}`))
        paths.push({ points: p.points, ...(p.closed ? { closed: true } : {}), tone })
      }
    })
    // the one being placed shows with the kept ones, picked
    const placing = dimField && dimField.index === undefined ? dimMark(sketch, dimField.c, dimField.c.value, -1, (mm) => formatLength(mm, units)) : null
    const editing = dimField?.index ?? pickedCon
    const dims = [...marks.dims, ...(placing ? [placing] : [])]
    const glyphs = pal.constraints ? marks.glyphs : []
    live.current.dims = pal.dimensions ? dims : []
    live.current.glyphs = glyphs
    const dimPoints = dimPicks.flatMap((p) => ('point' in p ? [pointAt(sketch, p.point)] : [])).filter((p): p is V2 => p !== null)
    view.setSketch({
      frame: plane.frame,
      paths,
      // points hide when Show points is off, but a picked sketch keeps its handles to drag
      handles: featureOnly ? [] : draft.tool === 'select' ? hs.points : pal.points ? [...hs.points, ...draft.points, ...dimPoints] : [...draft.points, ...dimPoints],
      dragHandles: draft.tool === 'select' && !featureOnly,
      ...(arcFrom && !featureOnly ? { dragFrom: arcFrom } : {}),
      ...(pal.grid && !featureOnly ? { grid: { stepMm: Number(pal.step) * 10, min: plane.min, max: plane.max } } : {}),
      marks: shown.flatMap((i) => (i.at ? [i.at] : [])),
      ...(pal.dimensions ? { dims: dims.map((d) => (d.of === editing || d.of === -1 ? { ...d, picked: true } : d)) } : {}),
      // the origin always shows, for dimensions to measure from
      fixed: featureOnly ? [] : [[0, 0], ...(pal.constraints ? marks.fixed : [])],
      ...(pal.constraints ? { glyphs: glyphs.map((g) => (g.of === pickedCon ? { ...g, picked: true } : g)) } : {}),
      ...(pal.profiles ? { profiles: profileRings(sketch) } : {}),
    })
  }, [view, plane, sketch, constraints, draft, selected, issues, hs, pal, engineSnaps, finish, axis, states, featureOnly, arcFrom, marks, dimPicks, dimField, pickedCon, units])

  // Section cuts away the model in front of the sketch plane while the sketch is open.
  useEffect(() => {
    if (!view || !pal.section || featureOnly) return
    view.setSection({ point: plane.frame.origin, normal: plane.frame.normal })
    return () => view.setSection(null)
  }, [view, plane, pal.section, featureOnly])
  useEffect(() => () => view?.setSketch(null), [view])

  const targets = (skip?: Parameters<typeof sketchTargets>[1]): SnapTargets[] => [live.current.engineSnaps, sketchTargets(live.current.sketch, skip)]

  // a drawing tool's step: the new sketch and draft, and the constraints it leaves unless Ctrl or Cmd was held
  const apply = (r: { sketch: Entity[]; draft: Draft }, at: Landing, quiet: boolean): void => {
    const l = live.current
    const landed = [...l.landed, quiet ? { at: at.at, kind: null } : at]
    // a chain turned round to go on from its start keeps its constraints on the same points
    const turned = reversedChain(l.sketch, r.sketch)
    const was = l.sketch[turned]
    let cons = turned >= 0 && was?.kind === 'chain' ? afterReverse(l.constraints, turned, was.segs.length) : l.constraints
    if (!quiet) {
      const more = inferred(l.sketch, r.sketch, landed, cons, l.draft.tool)
      if (more.length) cons = [...cons, ...more]
    }
    const grew = JSON.stringify(r.sketch) !== JSON.stringify(l.sketch)
    // the next click can come before the next render
    l.landed = !r.draft.points.length ? [] : grew ? [landed[landed.length - 1]!] : landed
    l.sketch = r.sketch
    l.draft = r.draft
    if (cons !== l.constraints) {
      l.constraints = cons
      setConstraints(cons)
    }
    setSketch(r.sketch)
    setDraft(r.draft)
    setField(null)
  }

  // A kept dimension opens in the value field at a screen spot.
  const editDim = (i: number, at: [number, number]): void => {
    const l = live.current
    const c = l.constraints[i]
    if (!c || !isDimension(c)) return
    const v = c.driven ? (measured(l.sketch, c) ?? c.value) : c.value
    setPickedCon(i)
    setSelected(null)
    setDimField({ x: at[0], y: at[1], c, index: i, text: c.expr ?? dimValueText(c, v, get().units) })
    view?.setSketchCursor(null)
  }

  // the constraint a press on a dimension value or glyph names
  const markOf = (m: NonNullable<SketchEvent['mark']>): number | undefined => ('dim' in m ? live.current.dims[m.dim]?.of : live.current.glyphs[m.glyph]?.of)

  // The dimension tool: pick a line, circle or arc, or two points or lines; the value follows the cursor; a click puts
  // it down and opens its field.
  const dimEvent = (ev: SketchEvent, tol: number): void => {
    const l = live.current
    if (ev.kind === 'hover') {
      const c = !l.dimField && l.dimPicks.length ? dimensionFor(l.sketch, l.dimPicks, ev.at) : null
      const m = c ? dimMark(l.sketch, c, c.value, -1, (mm) => formatLength(mm, get().units)) : null
      view?.setSketchCursor(m ? { dim: m } : null)
      const u = get().units
      if (readoutRef.current) readoutRef.current.textContent = c ? `${DIM_NAMES[c.type]} ${dimValueText(c, c.value, u)} ${c.type === 'angle' ? '\u00b0' : u.length}` : ''
      return
    }
    if (l.dimField) return void commitDim()
    const kept = ev.mark ? markOf(ev.mark) : undefined
    if (kept !== undefined && ev.mark && 'dim' in ev.mark && kept >= 0) return editDim(kept, ev.screen)
    const p = pointHit(l.sketch, ev.at, tol)
    const k = p ? null : hitTest(l.sketch, ev.at, tol)
    const pick: DimPick | null = p ? { point: p } : k ? { curve: k } : null
    const picks = l.dimPicks
    if (pick && picks.length < 2 && !picks.some((q) => samePick(q, pick))) {
      const next = [...picks, pick]
      l.dimPicks = next
      setDimPicks(next)
      return
    }
    const c = picks.length ? dimensionFor(l.sketch, picks, ev.at) : null
    if (!c) {
      // picks that make no dimension start again from this one
      l.dimPicks = pick ? [pick] : []
      setDimPicks(l.dimPicks)
      return
    }
    view?.setSketchCursor(null)
    setDimField({ x: ev.screen[0], y: ev.screen[1], c, text: dimValueText(c, c.value, get().units) })
  }

  // Enter in the value field: the dimension drives the sketch, unless it would over-define it; then it is driven, and
  // only shows the size.
  const commitDim = async (): Promise<void> => {
    const l = live.current
    const f = l.dimField
    if (!f) return
    const u = get().units
    let v: number
    try {
      v = f.c.type === 'angle' ? evaluate(f.text, (n) => currentValues()[n]) : parseLength(f.text, u, currentValues())
    } catch {
      v = NaN
    }
    if (!Number.isFinite(v) || (f.c.type === 'angle' ? v < 0 || v >= 360 : v <= 0)) return setNote(f.c.type === 'angle' ? 'An angle is from 0 up to 360 degrees.' : 'A dimension is a size more than 0.')
    setNote(null)
    const { driven: _d, expr: _e, ...base } = f.c
    const expr = namesIn(f.text).length ? f.text.trim() : undefined
    const c = { ...base, value: v, ...(expr ? { expr } : {}) } as SketchConstraint
    const k = f.index ?? l.constraints.length
    const list = f.index === undefined ? [...l.constraints, c] : l.constraints.map((x, i) => (i === f.index ? c : x))
    const before = l.solved?.status
    const { solver, map } = toSolver(l.sketch, list)
    try {
      const out = await solveSketch(solver)
      const j = map.from.indexOf(k)
      const over = out.redundant.includes(j) || out.conflicting.includes(j) || (out.status === 'conflict' && before !== 'conflict')
      if (over) {
        const now = measured(l.sketch, c)
        // the status line counts it, so nothing below moves
        list[k] = { ...c, value: now === null ? v : Math.round(now * 1e6) / 1e6, driven: true } as SketchConstraint
      }
    } catch (e) {
      return setNote(errorText(e))
    }
    l.constraints = list
    setConstraints(list)
    setDimField(null)
    setDimPicks([])
    l.dimPicks = []
  }

  const dropDim = (): void => {
    setDimField(null)
    setDimPicks([])
    live.current.dimPicks = []
  }

  // a point drag pulls it toward the cursor as far as the constraints let it
  const dragAbort = useRef<AbortController | null>(null)
  const dragTo = (ref: HandleRef, to: V2): void => {
    const l = live.current
    const moved = moveHandle(l.sketch, ref, to)
    const key = ref.at === 'start' ? `${ref.e}:start` : ref.at === 'to' ? `${ref.e}:to:${ref.seg}` : ref.at === 'center' ? `${ref.e}:center` : null
    if (!l.constraints.length || key === null) return setSketch(moved)
    const { solver, map } = toSolver(moved, l.constraints)
    const point = map.point.get(key)
    if (point === undefined) return setSketch(moved)
    dragAbort.current?.abort()
    const ac = (dragAbort.current = new AbortController())
    const met = (s: Solved) => s.status === 'ok' || s.status === 'redundant'
    // held right at the cursor when the constraints let it get there; else pulled toward it
    const held = { ...solver, constraints: [...solver.constraints, { type: 'fix', point }] }
    solveSketch(held, undefined, ac.signal)
      .then((s) => (met(s) ? s : solveSketch(solver, { point, to }, ac.signal)))
      .then(
        (s) => {
          if (ac.signal.aborted) return
          const next = met(s) ? fromSolver(moved, s, map) : moved
          l.sketch = next
          setSketch(next)
        },
        () => undefined,
      )
  }

  // the sketch and its constraints after an engine edit, kept in step for the next event
  const takeEdit = (next: Entity[], cons: SketchConstraint[]): void => {
    const l = live.current
    l.sketch = next
    l.constraints = cons
    setConstraints(cons)
    setSketch(next)
    setPickedCon(null)
    setNote(null)
  }

  // Trim and Extend: a hover shows what the click does (what a trim takes off in red), a click does it.
  const editAbort = useRef<AbortController | null>(null)
  const editEvent = async (ev: SketchEvent, tol: number): Promise<void> => {
    const l = live.current
    const sketch = l.sketch
    const trim = l.draft.tool === 'trim'
    const hit = hitTest(sketch, ev.at, tol)
    const end = hit && !trim ? endNear(sketch, hit.e, hit.seg, ev.at) : null
    editAbort.current?.abort()
    if (!hit || (!trim && !end)) {
      view?.setSketchCursor(null)
      if (ev.kind === 'click' && hit) setNote('Only an open end extends: click near the end of a line or arc that is not part of a closed loop.')
      return
    }
    const ac = (editAbort.current = new AbortController())
    try {
      const r = trim ? await trimSketch(toLoops(sketch), hit.e, hit.seg, ev.at, ac.signal) : await extendSketch(toLoops(sketch), hit.e, end!, ac.signal)
      if (ac.signal.aborted || l.sketch !== sketch) return
      if (ev.kind === 'hover') {
        const shown = fromLoops(trim ? (r.removed ? [r.removed] : []) : [r.loops[hit.e]!])?.[0]
        const path = shown ? entityPaths(shown).flatMap((q, i) => (i ? q.points.slice(1) : q.closed ? [...q.points, q.points[0]!] : q.points)) : null
        return view?.setSketchCursor(path ? { path, ...(trim ? { cut: true } : {}) } : null)
      }
      const next = fromLoops(r.loops)
      if (!next) throw new Error('The edited sketch could not be shown.')
      view?.setSketchCursor(null)
      takeEdit(next, afterEdit(sketch, next, r, l.constraints, hit.e))
      setSelected(null)
    } catch (e) {
      if (ac.signal.aborted) return
      if (ev.kind === 'click') setNote(errorText(e))
      else view?.setSketchCursor(null)
    }
  }

  // Mirror: the waiting loop copied across the clicked line, each point held symmetric to its original.
  const mirrorAcross = async (e: number, axis: { e: number; seg: number }): Promise<void> => {
    const l = live.current
    const sketch = l.sketch
    const c = sketch[axis.e]
    const s = c?.kind === 'chain' ? c.segs[axis.seg] : undefined
    if (!c || c.kind !== 'chain' || s?.kind !== 'line') return setNote('Click a straight line to mirror across.')
    const a = segStart(c, axis.seg)
    try {
      const r = await mirrorSketch(toLoops(sketch), [e], { point: a, direction: [s.to[0] - a[0], s.to[1] - a[1]] })
      const next = fromLoops(r.loops)
      if (!next) throw new Error('The mirrored sketch could not be shown.')
      takeEdit(next, [...afterEdit(sketch, next, r, l.constraints), ...mirrorConstraints(next, [[e, next.length - 1]], axis)])
      setPending(null)
      setSelected({ e: next.length - 1, seg: 0 })
    } catch (err) {
      setNote(errorText(err))
    }
  }

  // Pattern: copies of the picked loop along a step, or round a center through an angle.
  const copyLoop = async (e: number, center?: V2): Promise<void> => {
    const l = live.current
    const sketch = l.sketch
    // a round copy runs from the view's click, so the fields are read as they are now
    const copies = l.copies
    const count = Math.round(num(copies.count))
    if (!(count >= 2 && count <= 200)) return setNote('A pattern has 2 to 200 copies, the first one included.')
    const kind = center ? 'circle' : 'line'
    const step: V2 = [num(copies.dx), num(copies.dy)]
    const angleDeg = num(copies.angle)
    if (kind === 'line' && !(step.every(Number.isFinite) && (step[0] || step[1]))) return setNote('Give a step across or up, in mm.')
    if (kind === 'circle' && !(Number.isFinite(angleDeg) && angleDeg !== 0 && Math.abs(angleDeg) <= 360)) return setNote('The angle is up to 360 degrees, not 0; 360 spreads the copies evenly.')
    try {
      const r = await patternSketch(toLoops(sketch), [e], center ? { kind: 'circle', count, center, angleDeg } : { kind: 'line', count, step })
      const next = fromLoops(r.loops)
      if (!next) throw new Error('The patterned sketch could not be shown.')
      takeEdit(next, afterEdit(sketch, next, r, l.constraints))
      setPending(null)
    } catch (err) {
      setNote(errorText(err))
    }
  }

  // Events from the view.
  useEffect(() => {
    if (!view) return
    return view.on('sketch', (ev: SketchEvent) => {
      const l = live.current
      const tol = SNAP_PX * ev.mmPerPx
      const anchor = l.draft.points.length ? l.draft.points[l.draft.points.length - 1]! : null
      if (l.draft.tool === 'dimension' && (ev.kind === 'hover' || ev.kind === 'click')) {
        l.screen = ev.screen
        return dimEvent(ev, tol)
      }
      if ((l.draft.tool === 'trim' || l.draft.tool === 'extend') && (ev.kind === 'hover' || ev.kind === 'click')) {
        l.screen = ev.screen
        return void editEvent(ev, tol)
      }
      if (ev.kind === 'hover' || ev.kind === 'click') {
        const s = ev.alt ? { at: ev.at, kind: null } : snap(ev.at, targets(), { anchor: l.draft.tool === 'line' || l.draft.tool === 'arc' ? anchor : null, parallel: l.draft.tool === 'line', gridMm: l.gridMm, tolMm: tol })
        l.cursor = s.at
        l.screen = ev.screen
        if (ev.kind === 'hover') {
          view.setSketchCursor({ path: preview(l.draft, s.at, { sides: l.sides }, l.sketch), at: s.at, guide: 'guide' in s && s.guide ? s.guide : null })
          const r = readoutRef.current
          const u = readoutUnits(get().units)
          const base = l.draft.tool === 'select' ? pickedText(l.sketch, l.selected, ...u) : readout(l.draft, s.at, ...u)
          if (r) r.textContent = `${base}${s.kind ? `${base ? ', ' : ''}snap: ${SNAP_NAMES[s.kind].toLowerCase()}` : ''}`
          return
        }
        if (l.draft.tool === 'select' && l.pending) {
          const w = l.pending
          if (w.kind === 'round') return void copyLoop(w.e, s.at)
          const axis = hitTest(l.sketch, ev.at, tol)
          return axis ? void mirrorAcross(w.e, axis) : setNote('Click a straight line to mirror across.')
        }
        if (l.draft.tool === 'select') {
          // a press on a dimension's value picks it, and a second one opens it; one on a glyph picks its constraint
          const of = ev.mark ? markOf(ev.mark) : undefined
          if (of !== undefined && of >= 0) {
            if (ev.mark && 'dim' in ev.mark && l.pickedCon === of) return editDim(of, ev.screen)
            setPickedCon(of)
            setSelected(null)
            return
          }
          setPickedCon(null)
          setSelected(hitTest(l.sketch, ev.at, tol))
          return
        }
        apply(click(l.sketch, l.draft, s.at, { sides: l.sides }), { at: s.at, kind: ev.alt ? null : s.kind }, !!ev.ctrl)
        return
      }
      // a drag off the line's open end draws a tangent arc, placed on release
      if ((ev.kind === 'drag' || ev.kind === 'release') && ev.handle === -1) {
        const from = lineArcFrom(l.sketch, l.draft)
        if (!from) return
        const s = ev.alt ? { at: ev.at, kind: null } : snap(ev.at, targets(), { gridMm: l.gridMm, tolMm: tol })
        l.cursor = s.at
        if (ev.kind === 'drag') return view.setSketchCursor({ path: dragArcPreview(l.sketch, l.draft, s.at), at: s.at })
        view.setSketchCursor(null)
        // a press that never left the end draws nothing
        if (dist(s.at, from) >= tol) apply(dragArc(l.sketch, l.draft, s.at), { at: s.at, kind: ev.alt ? null : s.kind }, !!ev.ctrl)
        return
      }
      if (ev.kind === 'context') {
        // A right click ends the line being drawn.
        setDraft(emptyDraft(l.draft.tool))
        view.setSketchCursor(null)
        return
      }
      if (ev.kind === 'drag' && ev.handle !== undefined && !featureOnly) {
        const ref = handles(l.sketch).refs[ev.handle]
        if (!ref) return
        const s = ev.alt ? { at: ev.at } : snap(ev.at, targets(ref), { gridMm: l.gridMm, tolMm: tol })
        dragTo(ref, s.at)
      }
    })
  }, [view])

  // Typing a number with a drawing tool opens the field at the cursor; Delete removes the picked segment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      // a focused tool radio or checkbox takes no text, so keys still reach the sketch
      const typing = t instanceof HTMLInputElement ? t.type !== 'radio' && t.type !== 'checkbox' : t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (typing) return
      const l = live.current
      // X turns the picked curve into construction geometry and back, as in Fusion
      if (e.key.toLowerCase() === 'x' && !e.metaKey && !e.ctrlKey && !e.altKey && !featureOnly && l.draft.tool === 'select' && l.selected) {
        e.preventDefault()
        setSketch(toggleConstruction(l.sketch, l.selected.e))
        return
      }
      // Fusion's tool keys: L line, R 2-point rectangle, C center circle
      const key = TOOL_KEYS[e.key.toLowerCase()]
      if (key && !e.metaKey && !e.ctrlKey && !e.altKey && !featureOnly) {
        e.preventDefault()
        setDraft(emptyDraft(key))
        setField(null)
        dropDim()
        setPickedCon(null)
        view?.setSketchCursor(null)
        return
      }
      if (l.pending && e.key === 'Escape') {
        e.preventDefault()
        setPending(null)
        return
      }
      if (l.pickedCon !== null && l.draft.tool === 'select' && !featureOnly && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Enter')) {
        // a picked dimension or constraint: Delete removes it, Enter opens a dimension's value
        e.preventDefault()
        const i = l.pickedCon
        if (e.key === 'Enter') return editDim(i, l.screen)
        const next = l.constraints.filter((_, k) => k !== i)
        l.constraints = next
        setConstraints(next)
        setPickedCon(null)
        return
      }
      if (l.draft.tool === 'dimension' && (e.key === 'Escape' || e.key === 'Enter')) {
        // the picks go; Enter does not finish the sketch from here
        e.preventDefault()
        dropDim()
        view?.setSketchCursor(null)
        return
      }
      if (/^[0-9.\-]$/.test(e.key) && l.draft.tool !== 'select' && l.draft.tool !== 'dimension' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setField({ x: l.screen[0], y: l.screen[1], values: [e.key, ''], focus: 0 })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && l.draft.tool === 'select' && !featureOnly) {
        const sel = l.selected
        if (sel) {
          const next = deleteSegment(l.sketch, sel.e, sel.seg)
          setConstraints((c) => afterLoopChange(c, sel.e, next.length - l.sketch.length + 1))
          setPickedCon(null)
          setSketch(next)
          setSelected(null)
        }
      } else if (e.key === 'Escape' || e.key === 'Enter') {
        if (l.draft.points.length) {
          // the line being drawn ends; the tool's own Esc and Enter wait for the next press
          e.preventDefault()
          setDraft(emptyDraft(l.draft.tool))
          view?.setSketchCursor(null)
        } else if (e.key === 'Enter' && l.sketch.length && !featureOnly) {
          e.preventDefault()
          finishRef.current()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const commitField = () => {
    if (!field) return
    const kinds = fieldsFor(draft)
    const read = (v: string, i: number) => (kinds[i]?.unit === 'mm' ? parseLength(v, units, currentValues()) : num(v))
    const values = field.values.map((v, i) => (v.trim() === '' ? null : read(v, i)))
    if (values.some((v) => Number.isNaN(v))) return setNote('Type numbers only.')
    const p = typedPoint(draft, values, live.current.cursor)
    if (typeof p === 'string') return setNote(p)
    setNote(null)
    const r = click(sketch, draft, p, { sides: sidesN })
    setSketch(r.sketch)
    setDraft(r.draft)
    setField(null)
  }

  const pickTool = (t: DrawTool) => {
    if (VARIANTS[familyOf(t)]) lastVariant[familyOf(t)] = t
    setDraft(emptyDraft(t))
    setField(null)
    dropDim()
    setPickedCon(null)
    setPending(null)
    view?.setSketchCursor(null)
    if (t !== 'select') setSelected(null)
  }

  const look = () => {
    const ext = extent(sketch)
    const c: V2 = ext ? ext.center : [(plane.min[0] + plane.max[0]) / 2, (plane.min[1] + plane.max[1]) / 2]
    const r = ext ? ext.radius * 1.4 : Math.hypot(plane.max[0] - plane.min[0], plane.max[1] - plane.min[1]) / 2
    view?.lookAtPlane(frameToBed(plane.frame, c), plane.frame.normal, r)
  }

  // A plane just picked: the camera turns square on to it, as Look at the sketch does.
  const looked = useRef(false)
  useEffect(() => {
    if (looked.current || !plane.fresh || init) return
    looked.current = true
    look()
  })

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
      // what still holds on the shortened lines stays; a round is tangent to both and takes the radius, the rest equal to the first
      const kept = afterEdit(sketch, next, { from: next.map((_, i) => [i]) }, constraints)
      const rounds: SketchConstraint[] = []
      if (cornerKind === 'fillet') {
        r.added.forEach((a, k) => {
          const n = (next[a.loop] as { segs?: unknown[] } | undefined)?.segs?.length ?? 0
          const arc = { e: a.loop, seg: a.segment }
          rounds.push({ type: 'tangent', a: arc, b: { e: a.loop, seg: (a.segment + n - 1) % n } }, { type: 'tangent', a: arc, b: { e: a.loop, seg: (a.segment + 1) % n } })
          const first = r.added[0]!
          rounds.push(k ? { type: 'equal', a: { e: first.loop, seg: first.segment }, b: arc } : { type: 'radius', circle: arc, value: d })
        })
      }
      setConstraints([...kept, ...rounds])
      setSketch(next)
      setSelected(null)
    } catch (e) {
      setNote(errorText(e))
    }
  }

  // from a finished sketch's menu the body to join or cut is picked here; otherwise it is the face's
  const [picked, setPicked] = useState(init?.target ?? null)
  const target = featureOnly ? picked : plane.target
  const bodies = useApp((s) => s.plate)
  const canInto = featureOnly ? bodies.length > 0 : !!plane.target
  const op = canInto ? operation : 'new'
  // The switch shows where the extrusion goes; the engine's flip is relative to the operation.
  const intoFace = goesIntoFace(flip, op)
  const setIntoFace = (on: boolean) => setFlip(flipFor(on, op))
  const loops = toLoops(sketch)
  // A sketch step opened from the history saves into its place; the steps after it run again.
  const saveSketch = async (params: Parameters<typeof saveEdit>[1]) => {
    await saveEdit(host.slicer, params)
    return { message: `Changed step ${(init?.index ?? 0) + 1} and ran the steps after it.`, warn: false }
  }
  // a step of a body opened from its history saves into its place; a finished sketch makes a new step on it
  const stepEdit = init !== undefined && !init.from
  const ready = sketch.length > 0 && check?.ok === true && draft.points.length === 0 && issues.length === 0
  const go = async () => {
    if (!ready || (op !== 'new' && !target)) return
    setBusy(true)
    setNote(null)
    try {
      const into = op !== 'new' && target ? { target } : {}
      let r: { message: string; warn: boolean }
      if (finish === 'extrude') {
        const d = num(distance)
        if (!(d > 0)) throw new Error('The distance must be more than 0 mm.')
        const d2 = num(distance2)
        if (extentKind === 'twoSides' && !(d2 > 0)) throw new Error('The second distance must be more than 0 mm.')
        const tp = num(taper)
        if (!Number.isFinite(tp) || Math.abs(tp) > 45) throw new Error('The draft is between -45 and 45 degrees.')
        const pattern = patternFromFields(patternFields, num)
        const bad = pattern ? patternProblem(pattern) : null
        if (bad) throw new Error(bad)
        bindNext(distance)
        const input: ExtrudeInput = { frame: plane.frame, shape: { type: 'sketch', loops, ...(constraints.length ? { constraints } : {}) }, placement: {}, spec: { distanceMm: d, extent: extentKind, ...(extentKind === 'twoSides' ? { distance2Mm: d2 } : {}), ...(flip ? { flip } : {}), ...(tp ? { taperDeg: tp } : {}), operation: op }, ...into, name: 'Sketch body', ...(pattern ? { pattern } : {}) }
        sketchNext(init?.from?.id ?? null)
        r = stepEdit ? await saveSketch(extrudeParams(input)) : await applyExtrude(host.slicer, input)
      } else {
        if (!axis) throw new Error('Pick a straight line of the sketch as the axis.')
        const a = num(angle)
        if (!(a > 0 && a <= 360)) throw new Error('The angle is more than 0 and at most 360 degrees.')
        bindNext(angle)
        const input: RevolveInput = { frame: plane.frame, loops, ...(constraints.length ? { constraints } : {}), axis, angleDeg: a, operation: op, ...into, name: 'Revolved body' }
        sketchNext(init?.from?.id ?? null)
        r = stepEdit ? await saveSketch(revolveParams(input)) : await applyRevolve(host.slicer, input)
      }
      toast(r.message, r.warn ? 'warn' : 'ok')
      set({ objectTool: null })
    } catch (e) {
      setNote(errorText(e))
    } finally {
      sketchNext(null)
      setBusy(false)
    }
  }

  // Finish sketch: the sketch goes in the timeline as it is, no solid; the camera stays where it is.
  const finishOnly = async () => {
    if (busy || !sketch.length || draft.points.length) return
    setBusy(true)
    setNote(null)
    try {
      const s = { frame: plane.frame === BED_FRAME ? undefined : plane.frame, loops, constraints, ...(plane.target ? { on: { body: plane.target.objectId, part: plane.target.partIndex } } : {}) }
      if (init?.from) {
        const r = await updateSketch(host.slicer, init.from.id, s)
        toast(r.replayed ? `Changed ${plane.label} and rebuilt ${r.replayed === 1 ? 'the body' : `${r.replayed} bodies`} made from it.` : `Changed ${plane.label}.`, 'ok')
      } else toast(`${finishSketch(s).name} is in the timeline. Extrude or revolve it from its menu there.`, 'ok')
      set({ objectTool: null })
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const finishRef = useRef(finishOnly)
  finishRef.current = finishOnly
  useEffect(() => (stepEdit || featureOnly ? undefined : provideFinish(() => void finishRef.current())), [stepEdit, featureOnly])
  const usedId = featureOnly ? init?.from?.id : undefined
  useEffect(() => (usedId ? provideInUse(usedId) : undefined), [usedId])

  const fields = fieldsFor(draft)
  const sel = selected ? sketch[selected.e] : undefined
  const driven = constraints.filter((c) => isDimension(c) && c.driven).length
  const words = (t: string) => (phone ? touchWords(t) : t)
  return (
    <Shell
      title={featureOnly ? (finish === 'extrude' ? 'Extrude' : 'Revolve') : 'Sketch'}
      aside={plane.label}
      {...(featureOnly ? {} : { action: <Button size="sm" className="tp-pill" data-testid="sketch-other-plane" onClick={onRestart} disabled={busy} tip={{ title: 'Sketch on another plane or face' }}>Other plane</Button> })}
    >
      {featureOnly ? null : (
        <>
          <PhonePicker>
            <Seg label="Drawing tool" size="sm" full className="sketch-tools" value={familyOf(draft.tool)} onChange={(f) => pickTool(lastVariant[f] ?? VARIANTS[f]?.[0]?.value ?? (f as DrawTool))} options={FAMILIES} />
            {/* the ways to draw the family; the row is always there, so nothing below moves */}
            <div className="sketch-variants">
              {VARIANTS[familyOf(draft.tool)] ? (
                <Seg label="Draw it by" size="sm" full={familyOf(draft.tool) !== 'polygon'} value={draft.tool} onChange={pickTool} options={VARIANTS[familyOf(draft.tool)]!} />
              ) : null}
              {familyOf(draft.tool) === 'polygon' ? (
                <label className="sketch-sides" data-tip-title="Sides" data-tip-body="How many sides the polygon has, 3 to 64.">
                  <Icon name="sk-polygon" size={14} />
                  <input id="sk-sides" className="sx-input" data-mono data-size="sm" inputMode="numeric" aria-label="Sides" value={sides} onChange={(e) => setSides(e.target.value)} />
                </label>
              ) : null}
            </div>
          </PhonePicker>
          <p className="cad-hint sketch-hint" role="status">
            <Icon name={phone ? 'info' : 'mouse-left'} size={15} />{' '}
            <span className="sketch-hint-text" data-sizer={phone ? touchWords(HINT_SIZER) : HINT_SIZER}>
              <span>{words(pending ? PENDING_HINTS[pending.kind] : hintText(draft.tool))}</span>
            </span>
          </p>
          <p className="cad-hint sketch-readout"><span ref={readoutRef} className="sx-mono" aria-live="off" /></p>
          {solved ? (
            <p className="sketch-dof" role="status" data-testid="sketch-dof" data-dof={solved.solved.dof} data-tone={dofTone(solved.solved)} {...(driven ? { 'data-tip-title': 'Driven dimensions', 'data-tip-body': 'The other constraints already set these sizes, so they show in parentheses and change nothing.' } : {})}>
              {dofText(solved.solved)}
              {driven ? <span className="sketch-driven">, {driven} driven</span> : null}
            </p>
          ) : null}
          <div className="sketch-palette" role="group" aria-label="Sketch palette">
            <Button size="sm" className="tp-pill" icon="top-view" data-tip="sketch.look" onClick={look}>Look at the sketch</Button>
            <Row label="Grid" htmlFor="sk-grid">
              <Switch id="sk-grid" checked={pal.grid} onChange={(on) => setPal({ grid: on })} label="Grid" />
            </Row>
            {/* the step, or Off: one row for snapping */}
            <Row label="Snap to grid" htmlFor="sk-step">
              <Select id="sk-step" aria-label="Snap step" value={pal.snap ? pal.step : 'off'} onChange={(e) => setPal(e.target.value === 'off' ? { snap: false } : { snap: true, step: e.target.value })}>
                <option value="off">Off</option>
                {gridSteps(units, pal.step).map((g) => (
                  <option key={g.value} value={g.value}>{g.label}</option>
                ))}
              </Select>
            </Row>
            <Row label={<span data-tip-title="Section" data-tip-body="Cut away the model in front of the sketch plane">Section</span>} htmlFor="sk-section">
              <Switch id="sk-section" checked={pal.section} onChange={(on) => setPal({ section: on })} label="Section" />
            </Row>
            {/* what the sketch shows: filters, so chips */}
            <div className="tp-row" data-wide="">
              <span className="tp-label" id="sk-show-label">Show</span>
              <div className="tp-chips" role="group" aria-labelledby="sk-show-label">
                {(['profiles', 'points', 'dimensions', 'constraints'] as const).map((k) => (
                  <button key={k} id={`sk-show-${k}`} type="button" className="tp-chip" aria-pressed={pal[k]} aria-label={`Show ${k}`} onClick={() => setPal({ [k]: !pal[k] })}>
                    {k[0]!.toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      {issues.length ? (
        <div className="cad-issues">
          {issues.slice(0, 6).map((i, k) => (
            <Message key={k} text={i.message} />
          ))}
        </div>
      ) : null}
      {featureOnly ? null : (
        <>
          {draft.tool === 'select' && sel ? (
            <>
              <div className="cad-row sketch-loop-actions">
                <Button size="sm" className="tp-pill" icon="mirror" aria-pressed={pending?.kind === 'mirror'} data-tip-title="Mirror" data-tip-body="Adds a copy of this loop across the straight line you click next, held symmetric to it." onClick={() => setPending(pending?.kind === 'mirror' ? null : { kind: 'mirror', e: selected!.e })}>Mirror</Button>
                <Button size="sm" className="tp-pill" aria-pressed={sel.construction === true} data-tip-title="Construction" data-tip-key="X" data-tip-body="A construction curve stays in the sketch for constraints and snaps, and makes no profile." onClick={() => setSketch((s) => toggleConstruction(s, selected!.e))}>Construction</Button>
                <Button size="sm" className="tp-pill" icon="delete" onClick={() => { const e = selected!.e; setConstraints((c) => afterLoopChange(c, e, 0)); setSketch((s) => s.filter((_, i) => i !== e)); setSelected(null) }}>Delete loop</Button>
              </div>
              <Num id="sk-offset" label="Offset" unit="mm" value={offset} onChange={setOffset} onEnter={() => void doOffset()} />
              <Button full data-tip-title="Offset" data-tip-body="Adds a copy of this loop grown by the distance; a negative one shrinks it." onClick={() => void doOffset()}>Offset the loop</Button>
              {/* copies of the loop in this sketch; the extrude's Pattern below copies the solid */}
              <fieldset className="sketch-copies">
                <legend>Copy in sketch</legend>
                <Choice id="sk-copy-kind" label="Kind" ariaLabel="Copy kind" value={copies.kind} onChange={(kind) => (setCopies({ ...copies, kind }), setPending(null))} options={[{ value: 'line', label: 'Line' }, { value: 'circle', label: 'Circle' }]} />
                <Num id="sk-copies" label="Copies" unit="" value={copies.count} onChange={(count) => setCopies({ ...copies, count })} />
                <>
                  {copies.kind === 'line' ? (
                    <>
                      <Num id="sk-step-x" label="Step across" unit="mm" value={copies.dx} onChange={(dx) => setCopies({ ...copies, dx })} onEnter={() => void copyLoop(selected!.e)} />
                      <Num id="sk-step-y" label="Step up" unit="mm" value={copies.dy} onChange={(dy) => setCopies({ ...copies, dy })} onEnter={() => void copyLoop(selected!.e)} />
                    </>
                  ) : (
                    <Num id="sk-pattern-angle" label="Angle" unit="°" value={copies.angle} onChange={(angle) => setCopies({ ...copies, angle })} />
                  )}
                </>
                <Button full pressed={pending?.kind === 'round'} data-tip-title="Add copies" data-tip-body="Copies of this loop in the sketch, the original counted: along the step, or round a point you click next." onClick={() => (copies.kind === 'line' ? void copyLoop(selected!.e) : setPending(pending?.kind === 'round' ? null : { kind: 'round', e: selected!.e }))}>
                  {copies.kind === 'line' ? 'Add copies' : 'Add copies round a point'}
                </Button>
              </fieldset>
            </>
          ) : null}
          {draft.tool === 'select' && sel?.kind === 'chain' ? (
            <>
              <Choice id="sk-corner-kind" label="Corner shape" value={cornerKind} onChange={setCornerKind} options={[{ value: 'fillet', label: 'Round' }, { value: 'chamfer', label: 'Bevel' }]} />
              <Num id="sk-corner" label={cornerKind === 'fillet' ? 'Radius' : 'Distance'} unit="mm" value={corner} onChange={setCorner} onEnter={() => void doCorners(false)} />
              <div className="cad-row sketch-corner-actions">
                <Button size="sm" className="tp-pill" data-tip="sketch.corners" onClick={() => void doCorners(false)}>Corners of this line</Button>
                <Button size="sm" className="tp-pill" onClick={() => void doCorners(true)}>Every corner of the loop</Button>
              </div>
        </>
      ) : null}
        </>
      )}
      {featureOnly ? null : <Choice id="sk-finish" label="Finish with" bare value={finish} onChange={setFinish} options={[{ value: 'extrude', label: 'Extrude' }, { value: 'revolve', label: 'Revolve' }]} />}
      {finish === 'extrude' ? (
        <>
          <Choice id="sk-direction" label="Direction" value={extentKind} onChange={setExtentKind} options={[{ value: 'oneSide', label: 'One side' }, { value: 'symmetric', label: 'Symmetric' }, { value: 'twoSides', label: 'Two sides' }]} />
          <Num id="sk-dist" label={extentKind === 'symmetric' ? 'Total distance' : 'Distance'} unit="mm" value={distance} onChange={setDistance} onEnter={() => void go()} />
          {extentKind === 'twoSides' ? <Num id="sk-dist2" label="Other side" unit="mm" value={distance2} onChange={setDistance2} /> : <Num id="sk-taper" label="Draft" unit="°" value={taper} onChange={setTaper} />}
          <Row label="Extrude into the face" htmlFor="sk-flip">
            <Switch id="sk-flip" checked={intoFace} onChange={setIntoFace} label="Extrude into the face" />
          </Row>
          <PatternSection value={patternFields} onChange={setPatternFields} />
        </>
      ) : (
        <>
          <Note>{axis ? 'The picked line is the axis.' : featureOnly ? 'Click a straight line of the sketch: it becomes the axis.' : 'Pick a straight line of the sketch with Select: it becomes the axis.'}</Note>
          <Num id="sk-angle" label="Angle" unit="°" value={angle} onChange={setAngle} onEnter={() => void go()} />
        </>
      )}
      <Choice id="sk-result" label="Result" value={op} onChange={setOperation} options={[{ value: 'join', label: 'Join', disabled: !canInto }, { value: 'cut', label: 'Cut', disabled: !canInto }, { value: 'new', label: 'New body' }]} />
      {featureOnly && op !== 'new' ? (
        <Row label={op === 'join' ? 'Join to' : 'Cut from'} htmlFor="sk-into" wide>
          <Select
            id="sk-into"
            size="sm"
            className="sketch-into"
            value={picked?.objectId ?? ''}
            onChange={(e) => {
              const id = e.target.value
              setPicked(id ? { objectId: id, partIndex: init?.target?.objectId === id ? init.target.partIndex : 0 } : null)
            }}
          >
            {picked ? null : <option value="">Pick a body</option>}
            {bodies.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Row>
      ) : null}
      <Note>{stepEdit ? 'Applying changes this step; the steps after it run again.' : featureOnly ? `Made from ${plane.label}. Edit sketch in its menu changes the shape.` : 'Finish sketch keeps it in the timeline without a solid. Extrude or revolve here turns it into one.'}</Note>
      {note ? <Message text={note} /> : null}
      <ToolFooter
        verb={finish === 'extrude' ? 'Extrude' : 'Revolve'}
        verbs={['Extrude', 'Revolve']}
        onApply={go}
        busy={busy}
        disabled={!ready || (op !== 'new' && !target)}
      />
      {field && fields.length
        ? createPortal(
            <CursorField
              x={field.x}
              y={field.y}
              labels={fields.map((f) => ({ label: f.label, unit: f.unit === 'mm' ? units.length : f.unit }))}
              values={field.values}
              onChange={(values) => setField({ ...field, values })}
              onCommit={commitField}
              onCancel={() => setField(null)}
            />,
            document.body,
          )
        : null}
      {dimField
        ? createPortal(
            <CursorField
              key={`${dimField.index ?? 'new'}:${dimField.x}:${dimField.y}`}
              x={dimField.x}
              y={dimField.y}
              labels={[{ label: DIM_NAMES[dimField.c.type], unit: dimField.c.type === 'angle' ? '\u00b0' : units.length }]}
              values={[dimField.text]}
              selectAll
              onChange={(v) => setDimField({ ...dimField, text: v[0] ?? '' })}
              onCommit={() => void commitDim()}
              onCancel={() => {
                setDimField(null)
                if (dimField.index === undefined) dropDim()
              }}
            />,
            document.body,
          )
        : null}
    </Shell>
  )
}

/**
 * The drawing tools' two rows: in the panel, or on a phone in Model's bar along the bottom of the view
 * (workspaces/design/phone-slot.ts), so they stay under the thumb while the sheet is low or folded. Same component,
 * same state; only where it shows changes.
 */
function PhonePicker({ children }: { children: ReactNode }) {
  const slot = usePhoneSketchSlot()
  useEffect(() => (slot ? claimPhoneSketchSlot() : undefined), [slot])
  return slot ? createPortal(<div className="sketch-picker-phone">{children}</div>, slot) : <>{children}</>
}

/** The small field at the cursor: one or two numbers, Tab between them, Enter to place, Escape to drop. */
function CursorField({ x, y, labels, values, onChange, onCommit, onCancel, selectAll }: { x: number; y: number; labels: { label: string; unit: string }[]; values: string[]; onChange: (v: string[]) => void; onCommit: () => void; onCancel: () => void; selectAll?: boolean }) {
  const first = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const el = first.current
    if (!el) return
    el.focus()
    // The key that opened the field is already in it; the caret goes after it. A value to change is all picked.
    if (selectAll) el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
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
      {labels.map(({ label, unit }, i) => (
        <label key={label}>
          <span>
            {label} <span className="cad-num-unit">{unit}</span>
          </span>
          <input ref={i === 0 ? first : undefined} className="sx-input" data-mono data-size="sm" inputMode="decimal" aria-label={`${label} ${unit}`} value={values[i] ?? ''} onChange={(e) => onChange(values.map((v, k) => (k === i ? e.target.value : v)))} onKeyDown={onKey} />
        </label>
      ))}
    </div>
  )
}
