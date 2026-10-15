// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sketch mode. Pick the bed or a flat face, draw lines, rectangles, circles and three point arcs on
// it with snaps and typed sizes, fix what sketch.check reports, then extrude or revolve. The panel has
// two cards: drawing (tools, grid and snap, what shows) and the solid, which stays folded with the
// reason until the sketch has a closed profile. The live numbers sit beside the cursor in the view
// (cursor-pills.tsx). The camera stays free; Look at the sketch, among the view's camera buttons,
// turns it square on. Constraints go through the engine's solver (sketch-constraints.ts), and the
// drawing card says how defined the sketch is. Finishing records the sketch as a step of the
// object's history, where it opens again in this panel to be changed.
//
// Speed: the view reports the cursor at most once a frame (viewport cadtools.ts). The hover path
// here snaps, moves the rubber band in its fixed buffer and writes the cursor pills' text nodes; it
// renders no React. React renders on clicks, drags of points and edits only.
import { patternFromFields, patternProblem, type Pattern, type PatternFields } from '@slicerx/cad-history'
import { afterLoopChange, afterReverse, curveStates, dimMark, dofShort, dofText, dofTone, fromSolver, sketchMarks, toSolver, type DefState, type SketchConstraint, type SketchDim, type SketchGlyph, type Solved, type SolverMap } from './sketch-constraints'
import { dimensionFor, isDimension, measured, pointAt, pointHit, settle, type DimPick } from './sketch-dimension'
import { evaluate, namesIn } from './values'
import { fieldsOf, PatternSection } from './pattern-fields'
import { originFrame, type PickEvent, type SketchEvent, type SketchScene, type SketchTone } from '@slicerx/viewport'
import { Button, Icon, Seg, Select, Switch } from '@slicerx/ui'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePhoneLayout } from '../lib/phone-layout'
import { useSheetFold } from '../shell/sheet-fold'
import { claimPhoneSketchSlot, usePhoneSketchSlot } from '../workspaces/design/phone-slot'
import { touchWords } from './touch-words'
import { FAMILIES, familyName, familyOf, SketchVariants, VARIANTS, type Family } from './sketch-variants'
import { checkSketch, extendSketch, mirrorSketch, offsetSketch, patternSketch, pickFace, sketchSnaps, solveSketch, trimSketch, type FaceFrame, type MeshItem, type Polygon, type SketchCheck } from '../geom/cad'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { cameraBus } from '../plate/tools'
import { useShownOrigin } from '../state/model-mode'
import { get, set, toast, useApp } from '../state/store'
import { applyExtrude, applyRevolve, BED_FRAME, extrudeParams, frameToBed, revolveParams, wholeMesh, type ExtrudeInput, type RevolveInput } from './cad-ops'
import { editing, nowOf, saveEdit } from './history/ops'
import { bindNext, sketchNext } from './history/record'
import { defaultTarget, finishSketch, provideDraw, provideFinish, provideInUse, sketchById, takeSketchOpen, updateSketch, type SketchOpen } from './sketches'
import { chamferSketch, filletSketch } from './edge-api'
import { afterEdit, endNear, mirrorConstraints } from './sketch-edit'
import { goesIntoFace } from './extrude-direction'
import { CursorPills, type CursorPillsHandle } from './cursor-pills'
import { ShapeBoxes, type ShapeBoxesHandle, type ShapeBoxField } from './shape-boxes'
import { boxesOf, boxesState, boxKeyOf, boxValues, draftShape, keptShape, onShapeTool, placedShape, setBox, shapeAt, typedConstraints, type BoxKey, type BoxShape, type ScreenShape } from './sketch-boxes'
import { modelFeelFor, onModelFeel } from './model-feel-flag'
import { applyReason, CHECKING, profileState, provideSketchBoxes, provideSketchLook, setSketchMode, solidCard, surfaceOf } from './sketch-mode'
import { Actions, Card, Choice, close, type ChoiceOption, errorText, Message, Note, num, Num, pickWords, PointerHint, Row, Shell, useProbe, ToolFooter } from './panel-kit'
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
  liveValues,
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

/** What each tool wants clicked, in order: one line each in the 280 px pane, so the hint keeps one height and nothing below it moves. */
const HINTS: Record<DrawTool, string> = {
  select: 'Click to pick, drag a point to move.',
  line: 'Click points, drag an end for arcs.',
  rect: 'Click two opposite corners.',
  rect3: 'Click two corners, then the width.',
  rectCenter: 'Click the center, then a corner.',
  circle: 'Click the center, then the rim.',
  circle2: 'Click the two ends of a diameter.',
  arc: 'Click the start, end, then the arc.',
  arcCenter: 'Click the center, the start, the end.',
  arcTangent: 'Click an open end, then the end.',
  polygon: 'Click the center, then a corner.',
  polygonOut: 'Click the center, then mid-edge.',
  polygonEdge: "Click an edge's ends, then its side.",
  slot: 'Click both centers, then the width.',
  slotOverall: 'Click the two ends, then the width.',
  slotCenter: 'Click the center, an end, the width.',
  dimension: 'Click a line, circle or two points.',
  trim: 'Click a piece of a curve to remove.',
  extend: 'Click near the open end of a line.',
}

/** The line under the hint while nothing is being drawn: what else the tool takes. The live sizes take its place. */
const IDLE: Partial<Record<DrawTool, string>> = {
  select: 'Delete removes it, X makes it construction.',
  line: 'Right click stops. Type a number for sizes.',
  dimension: 'Then click where the value goes.',
  trim: 'It goes back to the nearest crossings.',
  extend: 'It runs on to the next curve.',
}
const idleText = (t: DrawTool): string => IDLE[t] ?? 'Type a number to give exact sizes.'

/** What Mirror and a round Pattern wait for, in place of the tool's hint; Esc stops either, on the line under it. */
const PENDING_HINTS = { mirror: 'Click the line to mirror across.', round: 'Click the point to pattern round.' }

const hintText = (t: DrawTool): string => HINTS[t]

/** Fusion's keys for the sketch tools it gives one. */
const TOOL_KEYS: Record<string, DrawTool> = { l: 'line', r: 'rect', c: 'circle', d: 'dimension', t: 'trim' }

/** The tool's name for the view's mode pill: its family's, or Extend for Trim's other way. */
const toolName = (t: DrawTool): string => (t === 'extend' ? 'Extend' : familyName(familyOf(t)))

/** A tool that draws, so the cursor pills show its numbers. */
const drawingTool = (t: DrawTool): boolean => t !== 'select' && t !== 'dimension' && t !== 'trim' && t !== 'extend'

type Extent = 'oneSide' | 'symmetric' | 'twoSides'
type Result = 'new' | 'join' | 'cut'

// the words alone, which read better than marks; each says in its tooltip what it does
const DIRECTIONS: ChoiceOption<Extent>[] = [
  { value: 'oneSide', label: 'One side', tip: { title: 'One side', body: 'The solid goes the distance to one side of the sketch.' } },
  { value: 'symmetric', label: 'Symmetric', tip: { title: 'Symmetric', body: 'Half the distance goes to each side of the sketch.' } },
  { value: 'twoSides', label: 'Two sides', tip: { title: 'Two sides', body: 'Each side of the sketch gets its own distance.' } },
]

const RESULTS: ChoiceOption<Result>[] = [
  { value: 'join', label: 'Join', tip: { title: 'Join', body: 'The solid merges into the body under the sketch.' } },
  { value: 'cut', label: 'Cut', tip: { title: 'Cut', body: 'The solid is taken out of the body under the sketch.' } },
  { value: 'new', label: 'New body', tip: { title: 'New body', body: 'The solid is its own part on the plate.' } },
]

const FINISH_WITH: ChoiceOption<'extrude' | 'revolve'>[] = [
  { value: 'extrude', label: 'Extrude', tip: { title: 'Extrude', body: 'Pushes the profile straight out of the sketch plane.' } },
  { value: 'revolve', label: 'Revolve', tip: { title: 'Revolve', body: 'Turns the profile around a line of the sketch.' } },
]

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

/** How far an on-screen keyboard covers the bottom of the window, px: the layout height below the visible part. */
export function keyboardLift(innerHeight: number, vv: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))
}

/** The sketch as one undo step holds it. */
interface SketchSnap {
  sketch: Entity[]
  constraints: SketchConstraint[]
}
/** Undo steps kept while a sketch is open. */
const HISTORY_STEPS = 200
/** Drag frames closer than this, ms, belong to one drag and one undo step. */
const DRAG_GAP_MS = 400

/** A key pressed inside the tool panel, where its own controls take Enter. */
const inPanel = (t: Element | null): boolean => !!t?.closest('.sx-block.cad')
/** Enter acts on the sketch only from the view; Esc from anywhere but a field. */
const enterHere = (e: KeyboardEvent, t: Element | null): boolean => e.key !== 'Enter' || !inPanel(t)

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
  const fold = useSheetFold()
  const view = cameraBus()?.cad
  const [sketch, setSketch] = useDraft<Entity[]>('sketch', init?.sketch ?? [])
  const [constraints, setConstraints] = useDraft<SketchConstraint[]>('constraints', init?.constraints ?? [])
  // The sketch's own undo and redo: each drawn, typed, edited or deleted change is a step; the solver settling a change
  // and the frames of one point drag fold into the step that started them.
  const hist = useRef<{ past: SketchSnap[]; future: SketchSnap[]; cur: SketchSnap; restoring: boolean }>({ past: [], future: [], cur: { sketch, constraints }, restoring: false })
  const mergeNext = useRef(false)
  // Finish sketch applies: a new sketch or a finished one opened again, not a body's step being edited
  const finishable = useRef(false)
  useEffect(() => {
    const h = hist.current
    const now = { sketch, constraints }
    if (JSON.stringify(h.cur) === JSON.stringify(now)) return
    if (!h.restoring && !mergeNext.current) {
      h.past.push(h.cur)
      if (h.past.length > HISTORY_STEPS) h.past.shift()
      h.future = []
    }
    h.cur = now
    h.restoring = false
    mergeNext.current = false
  }, [sketch, constraints])
  const [solved, setSolved] = useState<{ solved: Solved; map: SolverMap } | null>(null)
  const [draft, setDraft] = useDraft<Draft>('draft', emptyDraft(init ? 'select' : 'line'))
  const [selected, setSelected] = useDraft<{ e: number; seg: number } | null>('selected', init?.axis ?? null)
  const [pal, setPalState] = useState<SketchLook>(sessionLook)
  const setPal = (p: Partial<SketchLook>) => setPalState((l) => (sessionLook = { ...l, ...p }))
  const units = useApp((s) => s.units)
  const [check, setCheck] = useState<SketchCheck | null>(null)
  const [engineSnaps, setEngineSnaps] = useState<SnapTargets>({ points: [], edges: [] })
  // the cursor pills: the one typing goes to, and the typed text while a number is being typed
  const [typed, setTyped] = useState<string[] | null>(null)
  const [pillFocus, setPillFocus] = useState(0)
  const pills = useRef<CursorPillsHandle | null>(null)
  // The new Model feel (developer flag): the drawing tools' sizes sit on the shape as boxes, and a picked shape shows
  // its sizes there to change. `boxToken` puts the keyboard in a drawing box; the edit boxes keep their own text.
  const settingsMode = useApp((s) => s.settingsMode)
  const [, feelTurned] = useState(0)
  useEffect(() => onModelFeel(() => feelTurned((n) => n + 1)), [])
  const feel = modelFeelFor(settingsMode)
  const boxes = useRef<ShapeBoxesHandle | null>(null)
  const editBoxes = useRef<ShapeBoxesHandle | null>(null)
  const [boxToken, setBoxToken] = useState(0)
  const [editText, setEditText] = useState<string[] | null>(null)
  const [editFocus, setEditFocus] = useState(0)
  const [editToken, setEditToken] = useState(0)
  // a phone keeps its readout line under the hint, where a desktop has the cursor pills; a new tool starts it empty
  // and Select's says what is picked
  const readoutRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (readoutRef.current) readoutRef.current.textContent = draft.tool === 'select' ? pickedText(sketch, selected, ...readoutUnits(units)) : ''
  }, [draft.tool, selected, sketch, units])
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
  const [askPlane, setAskPlane] = useState(false)
  // the Other plane question is the newest thing open, so Esc answers it first (Keep drawing) before the ladder
  const askOpen = useRef(false)
  const [note, setNote] = useState<string | null>(null)
  // the dimension tool's picks so far, and its value field once the value is placed (or a kept one is edited)
  const [dimPicks, setDimPicks] = useState<DimPick[]>([])
  const [dimField, setDimField] = useState<DimField | null>(null)
  // a dimension or constraint glyph picked with Select, by constraint index
  const [pickedCon, setPickedCon] = useState<number | null>(null)
  // a new tool or step starts typing in its first pill, and a new tool's pills wait for the cursor
  const fieldKey = fieldsFor(draft)
    .map((f) => f.label)
    .join()
  useEffect(() => setPillFocus(0), [fieldKey])
  useEffect(() => pills.current?.hide(), [draft.tool])
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
  const live = useRef({ sketch, draft, selected, gridMm, engineSnaps, constraints, sides: sidesN, cursor: [0, 0] as V2, screen: [0, 0] as [number, number], landed: [] as Landing[], dimPicks, dimField, pickedCon, pending, copies, pillFocus, typed, dims: [] as SketchDim[], glyphs: [] as SketchGlyph[], solved: solved?.solved ?? null, feel, editText, editFocus })
  live.current = { ...live.current, sketch, draft, selected, gridMm, engineSnaps, constraints, sides: sidesN, dimPicks, dimField, pickedCon, pending, copies, pillFocus, typed, solved: solved?.solved ?? null, feel, editText, editFocus }

  // The typed numbers as the point they stand for, the cursor filling in a pill left empty; null while nothing is typed
  // or the numbers can't make a point (the pills then say why on Enter).
  const typedAt = (d: Draft, typedText: readonly string[] | null, cursor: V2): V2 | null => {
    if (!typedText || !typedText.some((v) => v.trim() !== '')) return null
    const kinds = fieldsFor(d)
    const u = get().units
    const values = typedText.map((v, i) => {
      if (v.trim() === '') return null
      try {
        return kinds[i]?.unit === 'mm' ? parseLength(v, u, currentValues()) : num(v)
      } catch {
        return NaN
      }
    })
    if (values.some((v) => v !== null && !Number.isFinite(v))) return null
    const p = typedPoint(d, values, cursor)
    return typeof p === 'string' ? null : p
  }

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or Ctrl+Y) inside the sketch: the drawing a step back or on, the line in progress
  // dropped, nothing of the model touched.
  const stepHistory = (dir: 'undo' | 'redo'): void => {
    const h = hist.current
    const snap = (dir === 'undo' ? h.past : h.future).pop()
    if (!snap) return
    ;(dir === 'undo' ? h.future : h.past).push(h.cur)
    h.restoring = true
    const l = live.current
    l.sketch = snap.sketch
    l.constraints = snap.constraints
    l.landed = []
    l.draft = emptyDraft(l.draft.tool)
    setSketch(snap.sketch)
    setConstraints(snap.constraints)
    setDraft(l.draft)
    setTyped(null)
    setSelected(null)
    setPickedCon(null)
    view?.setSketchCursor(null)
  }

  // typed numbers move the preview as they are typed, before the cursor moves
  useEffect(() => {
    const l = live.current
    if (!typed || !view || !drawingTool(l.draft.tool)) return
    const at = typedAt(l.draft, typed, l.cursor)
    if (at) view.setSketchCursor({ path: preview(l.draft, at, { sides: l.sides }, l.sketch), at, guide: null })
  }, [typed, view])

  // The boxes follow the shape as the step changes or numbers are typed, before the pointer moves (a phone has no
  // hover: its boxes sit on the shape from the first tap).
  const boxStep = `${draft.tool}:${draft.points.length}:${draft.points[0]?.join(',') ?? ''}`
  useEffect(() => {
    showBoxes(live.current.draft, live.current.cursor)
  }, [boxStep, typed, feel, view])
  // A shape's first click puts the keyboard in its first box, its value picked so typing replaces it. Not on a phone,
  // where it would raise the keyboard over the view.
  useEffect(() => {
    if (!feel || featureOnly || phone || !onShapeTool(draft)) return
    setPillFocus(0)
    setBoxToken((n) => n + 1)
  }, [boxStep, feel])
  // The boxes stay on their shape while the view turns, zooms or changes size (a side pane opened or shut).
  const redrawBoxes = useRef(() => undefined as void)
  redrawBoxes.current = () => {
    showBoxes(live.current.draft, live.current.cursor)
    showEditBoxes()
  }
  useEffect(() => {
    if (!view) return
    const off = view.on('camera', () => redrawBoxes.current())
    const canvas = view.canvas
    const ro = canvas && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => redrawBoxes.current()) : null
    if (canvas) ro?.observe(canvas)
    const onResize = () => redrawBoxes.current()
    window.addEventListener('resize', onResize)
    return () => {
      off()
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [view])

  // The live numbers beside the cursor for the tool's next step, or the step's readout when it takes no typed number.
  const showPills = (d: Draft, at: V2, screen: readonly [number, number], snapName: string | null): void => {
    if (showBoxes(d, at)) return pills.current?.hide()
    const p = pills.current
    if (!p) return
    if (!drawingTool(d.tool)) return p.hide()
    const [f, u] = readoutUnits(get().units)
    const kinds = fieldsFor(d)
    const values = kinds.length ? liveValues(d, at).map((v, i) => (v === null ? '' : kinds[i]?.unit === 'mm' ? f(v) : v.toFixed(1))) : [readout(d, at, f, u)]
    p.show(screen[0], screen[1], values, snapName)
  }

  // A plane point on screen, client px, or null while the view can't say.
  const screenAt = (p: V2): V2 | null => {
    const s = view?.screenOf?.(frameToBed(plane.frame, p))
    return s && Number.isFinite(s[0]) && Number.isFinite(s[1]) ? [s[0], s[1]] : null
  }
  const onScreen = (sh: ReturnType<typeof draftShape>): ScreenShape | null => {
    if (!sh) return null
    if (sh.kind === 'rect') {
      const c = sh.corners.map(screenAt)
      return c.every((x): x is V2 => x !== null) ? { kind: 'rect', corners: c as [V2, V2, V2, V2] } : null
    }
    if (sh.kind === 'line') {
      const a = screenAt(sh.a)
      const b = screenAt(sh.b)
      return a && b ? { kind: 'line', a, b } : null
    }
    const c = screenAt(sh.center)
    const r = screenAt(sh.rim)
    return c && r ? { kind: 'circle', center: c, rim: r } : null
  }
  // The boxes for the drawing tool's step on the shape it would leave with the pointer at `at` (typed values hold
  // their sizes); false when the step has none, so the cursor pills take it.
  const showBoxes = (d: Draft, at: V2): boolean => {
    const b = boxes.current
    if (!live.current.feel || featureOnly || !onShapeTool(d)) {
      b?.hide()
      return false
    }
    const held = typedAt(d, live.current.typed, at) ?? at
    const sh = onScreen(draftShape(d, held))
    if (!b) return true
    if (!sh) {
      b.hide()
      return true
    }
    const [f] = readoutUnits(get().units)
    const kinds = fieldsFor(d)
    b.show(sh, liveValues(d, held).map((v, i) => (v === null ? '' : kinds[i]?.unit === 'mm' ? f(v) : v.toFixed(1))))
    return true
  }

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
            if (JSON.stringify(next) !== JSON.stringify(sketch)) {
              mergeNext.current = true
              setSketch(next)
            }
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
  const editShape: BoxShape | null = feel && !featureOnly && draft.tool === 'select' ? shapeAt(sketch, selected) : null
  const editKey = editShape ? JSON.stringify(editShape) : ''
  const editValues = useMemo(() => (editShape ? boxValues(sketch, constraints, editShape) : []), [editKey, sketch, constraints])
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
    const boxed = new Set(editValues.flatMap((v) => (v.index >= 0 ? [v.index] : [])))
    const dimPoints = dimPicks.flatMap((p) => ('point' in p ? [pointAt(sketch, p.point)] : [])).filter((p): p is V2 => p !== null)
    view.setSketch({
      frame: plane.frame,
      // the plane being drawn on, as a tinted frame of its own, apart from the world grid
      ...(featureOnly || phone ? {} : { plane: { min: plane.min, max: plane.max } }),
      paths,
      // points hide when Show points is off, but a picked sketch keeps its handles to drag
      handles: featureOnly ? [] : draft.tool === 'select' ? hs.points : pal.points ? [...hs.points, ...draft.points, ...dimPoints] : [...draft.points, ...dimPoints],
      dragHandles: draft.tool === 'select' && !featureOnly,
      ...(arcFrom && !featureOnly ? { dragFrom: arcFrom } : {}),
      ...(pal.grid && !featureOnly ? { grid: { stepMm: Number(pal.step) * 10, min: plane.min, max: plane.max } } : {}),
      marks: shown.flatMap((i) => (i.at ? [i.at] : [])),
      // a picked shape's box shows each of its sizes, so the label at its side's middle steps out from under it
      ...(pal.dimensions ? { dims: dims.map((d) => ({ ...d, ...(d.of === editing || d.of === -1 ? { picked: true } : {}), ...(boxed.has(d.of) ? { hideLabel: true } : {}) })) } : {}),
      // the origin always shows, for dimensions to measure from
      fixed: featureOnly ? [] : [[0, 0], ...(pal.constraints ? marks.fixed : [])],
      ...(pal.constraints ? { glyphs: glyphs.map((g) => (g.of === pickedCon ? { ...g, picked: true } : g)) } : {}),
      ...(pal.profiles ? { profiles: profileRings(sketch) } : {}),
    })
  }, [view, plane, sketch, constraints, draft, selected, issues, hs, pal, engineSnaps, finish, axis, states, featureOnly, arcFrom, marks, dimPicks, dimField, pickedCon, units, editValues])

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
    setTyped(null)
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
      if (readoutRef.current) readoutRef.current.textContent = c ? `${DIM_NAMES[c.type]} ${dimValueText(c, c.value, u)} ${c.type === 'angle' ? '°' : u.length}` : ''
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
  const lastDrag = useRef(0)
  const dragTo = (ref: HandleRef, to: V2): void => {
    const l = live.current
    // the frames of one drag are one undo step
    const t = performance.now()
    if (t - lastDrag.current < DRAG_GAP_MS) mergeNext.current = true
    lastDrag.current = t
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
          mergeNext.current = true
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
          // typed numbers hold the preview to them; the cursor only fills what is left empty
          const held = typedAt(l.draft, l.typed, s.at)
          view.setSketchCursor({ path: preview(l.draft, held ?? s.at, { sides: l.sides }, l.sketch), at: held ?? s.at, guide: held ? null : 'guide' in s && s.guide ? s.guide : null })
          const r = readoutRef.current
          if (r) {
            const u = readoutUnits(get().units)
            const base = l.draft.tool === 'select' ? pickedText(l.sketch, l.selected, ...u) : readout(l.draft, s.at, ...u)
            r.textContent = `${base}${s.kind ? `${base ? ', ' : ''}snap: ${SNAP_NAMES[s.kind].toLowerCase()}` : ''}`
            showBoxes(l.draft, s.at)
          } else showPills(l.draft, s.at, ev.screen, s.kind ? SNAP_NAMES[s.kind] : null)
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
        // typed sizes in the boxes on the shape: a click places it with them, as Enter does
        if (l.feel && onShapeTool(l.draft) && l.typed?.some((v) => v.trim() !== '')) return commitRef.current()
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
        setTyped(null)
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
      // typed numbers left in the pills (Tab took focus out of them): Enter places the point, Esc drops them
      if (l.typed && (e.key === 'Enter' || e.key === 'Escape') && !e.metaKey && !e.ctrlKey && !e.altKey && enterHere(e, t)) {
        e.preventDefault()
        if (e.key === 'Enter') commitRef.current()
        else setTyped(null)
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
      if (l.draft.tool === 'dimension' && (e.key === 'Escape' || e.key === 'Enter') && enterHere(e, t)) {
        // the picks go; with none, Esc leaves the tool for Select
        e.preventDefault()
        if (e.key === 'Escape' && !l.dimPicks.length && !l.dimField) pickRef.current('select')
        dropDim()
        view?.setSketchCursor(null)
        return
      }
      const kinds = drawingTool(l.draft.tool) && !featureOnly ? fieldsFor(l.draft) : []
      if (/^[0-9.\-]$/.test(e.key) && kinds.length && !e.metaKey && !e.ctrlKey) {
        // a number goes into the focused pill; the others keep following the cursor until typed in
        e.preventDefault()
        const at = Math.min(l.pillFocus, kinds.length - 1)
        showPills(l.draft, l.cursor, l.screen, null)
        setTyped(kinds.map((_, i) => (i === at ? e.key : '')))
        if (l.feel && onShapeTool(l.draft)) setBoxToken((n) => n + 1)
      } else if (/^[0-9.]$/.test(e.key) && l.feel && l.draft.tool === 'select' && !featureOnly && shapeAt(l.sketch, l.selected) && !e.metaKey && !e.ctrlKey) {
        // a number with a shape picked goes into its first box
        e.preventDefault()
        const n = boxesOf(shapeAt(l.sketch, l.selected)!.kind).length
        const at = Math.min(l.editFocus, n - 1)
        setEditText(Array.from({ length: n }, (_, i) => (i === at ? e.key : '')))
        setEditToken((k) => k + 1)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && l.draft.tool === 'select' && !featureOnly) {
        const sel = l.selected
        if (sel) {
          const next = deleteSegment(l.sketch, sel.e, sel.seg)
          setConstraints((c) => afterLoopChange(c, sel.e, next.length - l.sketch.length + 1))
          setPickedCon(null)
          setSketch(next)
          setSelected(null)
        }
      } else if ((e.key === 'Escape' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey && !e.altKey && enterHere(e, t)) {
        // Esc steps back one level at a time: the segment being drawn, then the tool (to Select), then the pick. It
        // never closes the sketch; Cancel does. A bare Enter ends the line being drawn and nothing more: Finish sketch
        // is its button or Ctrl/Cmd+Enter.
        if (l.draft.points.length) {
          e.preventDefault()
          setDraft(emptyDraft(l.draft.tool))
          view?.setSketchCursor(null)
        } else if (e.key === 'Escape') {
          // held here even with nothing left to step back, so the view's own Esc (clear the model's selection) and
          // the panel never take it as closing the sketch
          e.preventDefault()
          if (l.draft.tool !== 'select') pickRef.current('select')
          else if (l.selected || l.pickedCon !== null) {
            setSelected(null)
            setPickedCon(null)
          }
        }
      }
    }
    // Undo, redo and Finish sketch go first, ahead of the plate's own keys: inside a sketch, Ctrl/Cmd+Z steps the
    // drawing back, not the model.
    const onModKey = (e: KeyboardEvent) => {
      // Esc steps the sketch back before the view or anything else sees it (onKey's ladder), unless a menu or dialog
      // is open to take it
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !featureOnly && !document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"]')) {
        if (askOpen.current) {
          e.preventDefault()
          e.stopPropagation()
          setAskPlane(false)
          document.querySelector<HTMLElement>('[data-section="cad-tool"] [data-testid="sketch-other-plane"]')?.focus()
          return
        }
        onKey(e)
        if (e.defaultPrevented) e.stopPropagation()
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey || featureOnly) return
      const t = e.target as HTMLElement | null
      // a box on the shape showing only its live size is no text being edited: undo still steps the sketch
      const liveBox = t instanceof HTMLInputElement && t.classList.contains('shape-box-input') && !t.closest('[data-typed]')
      const field = liveBox ? false : t instanceof HTMLInputElement ? t.type !== 'radio' && t.type !== 'checkbox' : t && (t.tagName === 'TEXTAREA' || t.isContentEditable)
      const k = e.key.toLowerCase()
      if (e.key === 'Enter') {
        // only a sketch that finishes on its own; a body's step being edited leaves Ctrl/Cmd+Enter to the app (slice)
        if (!finishable.current) return
        e.preventDefault()
        e.stopPropagation()
        finishRef.current()
        return
      }
      if (field || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)
      if (!redo && !(k === 'z' && !e.shiftKey)) return
      e.preventDefault()
      e.stopPropagation()
      stepHistory(redo ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onModKey, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onModKey, true)
    }
  }, [view])

  // Enter in the pills: the point the typed numbers give, placed like a click there with no snap, so the next segment
  // starts from it. Numbers that can't make a point change nothing and say why.
  const commitField = () => {
    const l = live.current
    const kinds = fieldsFor(l.draft)
    // the boxes on the shape place it with the live size where nothing is typed
    const onShape = l.feel && !featureOnly && onShapeTool(l.draft)
    const text = l.typed ?? (onShape ? kinds.map(() => '') : null)
    if (!text) return
    const read = (v: string, i: number) => {
      try {
        return kinds[i]?.unit === 'mm' ? parseLength(v, get().units, currentValues()) : num(v)
      } catch {
        return NaN
      }
    }
    const values = text.map((v, i) => (v.trim() === '' ? null : read(v, i)))
    if (values.some((v) => v !== null && !Number.isFinite(v))) return setNote('Type numbers only.')
    const p = typedPoint(l.draft, values, l.cursor)
    if (typeof p === 'string') return setNote(p)
    setNote(null)
    const before = l.sketch
    const tool = l.draft.tool
    apply(click(l.sketch, l.draft, p, { sides: l.sides }), { at: p, kind: null }, false)
    if (onShape) keepTyped(before, tool, kinds.map((k) => k.label), values)
    setPillFocus(0)
    // the preview starts from the new point at once, before the cursor moves again
    view?.setSketchCursor({ path: preview(live.current.draft, l.cursor, { sides: l.sides }, live.current.sketch), at: l.cursor, guide: null })
  }
  const commitRef = useRef(commitField)
  commitRef.current = commitField

  // The sizes typed in the boxes of a shape just placed drive it from now on: each becomes a dimension. One the sketch
  // can't take (it would over-define it) is kept driven, as the dimension tool keeps it.
  const keepTyped = (before: Entity[], tool: DrawTool, labels: readonly string[], values: readonly (number | null)[]): void => {
    const l = live.current
    const shape = placedShape(before, l.sketch, tool)
    if (!shape) return
    const typed: Partial<Record<BoxKey, number>> = {}
    labels.forEach((label, i) => {
      const k = boxKeyOf(label)
      const v = values[i]
      if (k && v !== null && v !== undefined) typed[k] = v
    })
    const more = typedConstraints(shape, typed, l.constraints)
    if (!more.length) return
    const list = [...l.constraints, ...more]
    l.constraints = list
    setConstraints(list)
    const sk = l.sketch
    void settle(sk, list).then(
      (r) => {
        const now = live.current
        if (now.constraints !== list || now.sketch !== sk) return
        if (!r.constraints.some((c, i) => isDimension(c) && c.driven && !(isDimension(list[i]!) && list[i]!.driven))) return
        mergeNext.current = true
        now.constraints = r.constraints
        setConstraints(r.constraints)
      },
      () => undefined,
    )
  }

  // Esc in a drawing box with nothing typed: the shape being drawn goes, the tool stays; the view takes the keys again.
  const dropShape = (): void => {
    const l = live.current
    setDraft(emptyDraft(l.draft.tool))
    l.draft = emptyDraft(l.draft.tool)
    setTyped(null)
    setPillFocus(0)
    view?.setSketchCursor(null)
    boxes.current?.hide()
    view?.canvas?.focus()
  }

  // A tool key (L, R, C, D, T) from a box showing only its live size picks that tool, as it does in the view.
  const boxToolKey = (k: string): boolean => {
    const t = TOOL_KEYS[k]
    if (!t || featureOnly) return false
    pickRef.current(t)
    view?.canvas?.focus()
    return true
  }

  // Tab past the last box goes on to the panel, Shift+Tab before the first back to the view.
  const leaveBoxes = (back: boolean): void => {
    const first = back ? null : document.querySelector<HTMLElement>('[data-section="cad-tool"] :is(button, input, select, [tabindex="0"]):not(:disabled)')
    ;(first ?? view?.canvas)?.focus()
  }

  // A picked shape's boxes: its sizes now, and Enter sets the typed ones (an emptied box frees its size).
  useEffect(() => {
    setEditText(null)
    setEditFocus(0)
  }, [editKey])
  const showEditBoxes = (): void => {
    const b = editBoxes.current
    if (!b) return
    const sh = editShape ? onScreen(keptShape(sketch, editShape)) : null
    if (!sh) return b.hide()
    const [f] = readoutUnits(get().units)
    b.show(sh, editValues.map((v) => (v.unit === '°' ? v.value.toFixed(1) : f(v.value))))
  }
  useEffect(showEditBoxes)

  // A box's text as a value: mm in the display unit (names from the value table work), degrees for an angle.
  const readBox = (key: BoxKey, text: string): number => {
    const t = text.trim()
    return key === 'angle' ? evaluate(t, (n) => currentValues()[n]) : parseLength(t, get().units, currentValues())
  }

  const commitEdit = async (cleared: readonly number[]): Promise<void> => {
    const l = live.current
    const shape = shapeAt(l.sketch, l.selected)
    if (!shape) return
    const vals = boxValues(l.sketch, l.constraints, shape)
    let sk: Entity[] = l.sketch
    let cons = l.constraints
    let driven = false
    try {
      for (const [i, v] of vals.entries()) {
        const text = l.editText?.[i] ?? ''
        let value: number | null
        let expr: string | undefined
        if (text.trim() !== '') {
          value = readBox(v.key, text)
          if (!Number.isFinite(value)) throw new Error('Type a number.')
          if (namesIn(text).length) expr = text.trim()
        } else if (cleared.includes(i) && v.index >= 0) value = null
        else continue
        const r = await setBox(sk, cons, shape, v.key, value, expr ? { expr } : {})
        sk = r.sketch
        cons = r.constraints
        driven ||= r.driven
      }
    } catch (e) {
      return setNote(errorText(e))
    }
    setNote(driven ? 'The other constraints already set that size, so it is kept driven and changes nothing.' : null)
    l.sketch = sk
    l.constraints = cons
    setSketch(sk)
    setConstraints(cons)
    setEditText(null)
    view?.canvas?.focus()
  }

  // The open sketch's boxes for the app link: read them, and set one as the person does by typing in it.
  useEffect(() => {
    if (featureOnly) return
    return provideSketchBoxes({
      read: () => {
        const l = live.current
        return boxesState(l.sketch, l.constraints, l.solved?.dof ?? null)
      },
      set: async (req) => {
        const l = live.current
        const shape = shapeAt(l.sketch, { e: req.loop, seg: req.seg ?? 0 })
        if (!shape) throw new Error(`loop ${req.loop}${req.seg !== undefined ? ` segment ${req.seg}` : ''} has no boxes: pick a rectangle, a straight line or a circle that is not construction`)
        const key = boxesOf(shape.kind).find((b) => b.key === req.box)?.key
        if (!key) throw new Error(`a ${shape.kind === 'rect' ? 'rectangle' : shape.kind} has ${boxesOf(shape.kind).map((b) => b.key).join(' and ')}, not ${req.box}`)
        let value: number | null = null
        let expr: string | undefined
        if (typeof req.value === 'string') {
          // an expression in mm, as a client's numbers are, whatever the person shows
          value = key === 'angle' ? evaluate(req.value, (n) => currentValues()[n]) : parseLength(req.value, { ...get().units, length: 'mm' }, currentValues())
          if (namesIn(req.value).length) expr = req.value.trim()
        } else value = req.value
        const r = await setBox(l.sketch, l.constraints, shape, key, value, expr ? { expr } : {})
        const now = live.current
        now.sketch = r.sketch
        now.constraints = r.constraints
        setSketch(r.sketch)
        setConstraints(r.constraints)
        return { ...boxesState(r.sketch, r.constraints, r.solved.dof), driven: r.driven }
      },
    })
  }, [featureOnly])

  const pickRef = useRef<(t: DrawTool) => void>(() => undefined)
  const pickTool = (t: DrawTool) => {
    if (VARIANTS[familyOf(t)]) lastVariant[familyOf(t)] = t
    setDraft(emptyDraft(t))
    setTyped(null)
    dropDim()
    setPickedCon(null)
    setPending(null)
    view?.setSketchCursor(null)
    if (t !== 'select') setSelected(null)
  }
  pickRef.current = pickTool

  const look = () => {
    const ext = extent(sketch)
    const c: V2 = ext ? ext.center : [(plane.min[0] + plane.max[0]) / 2, (plane.min[1] + plane.max[1]) / 2]
    const r = ext ? ext.radius * 1.4 : Math.hypot(plane.max[0] - plane.min[0], plane.max[1] - plane.min[1]) / 2
    view?.lookAtPlane(frameToBed(plane.frame, c), plane.frame.normal, r)
  }

  const lookRef = useRef(look)
  lookRef.current = look
  // the view's camera buttons get Look at the sketch, and its mode pill says where and with what the sketch draws
  const name = toolName(draft.tool)
  useEffect(() => (featureOnly ? undefined : () => setSketchMode(null)), [featureOnly])
  useEffect(() => (featureOnly ? undefined : provideSketchLook(() => lookRef.current())), [featureOnly])

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
  // Flip says where the extrusion goes now; the engine's flip is relative to the operation
  const intoFace = goesIntoFace(flip, op)
  const loops = toLoops(sketch)
  const loopsKey = useMemo(() => toLoops(sketch), [sketch])
  // A sketch step opened from the history saves into its place; the steps after it run again.
  const saveSketch = async (params: Parameters<typeof saveEdit>[1]) => {
    await saveEdit(host.slicer, params)
    return { message: `Changed step ${(init?.index ?? 0) + 1} and ran the steps after it.`, warn: false }
  }
  // a step of a body opened from its history saves into its place; a finished sketch makes a new step on it
  const stepEdit = init !== undefined && !init.from
  // What the drawing is as a profile, and why Extrude or Revolve can't run yet; the footer shows the reason under it.
  const closedProfiles = useMemo(() => profileRings(sketch).length, [sketch])
  const profile = profileState({ drawn: sketch.length > 0, closedProfiles, checked: check !== null, ok: check?.ok === true, issues })
  const reason = applyReason({ profile, drawing: draft.points.length > 0, checked: check !== null, ...(issues[0] ? { firstIssue: issues[0].message } : {}), finish, axis: !!axis, op, target: !!target })
  const ready = reason === null
  // the view's mode pill and the app's read-back: where and with what the sketch draws, and what it is as a profile
  useEffect(() => {
    if (!featureOnly) setSketchMode({ on: surfaceOf(plane, init !== undefined), label: plane.label, tool: name, profile, dof: solved ? solved.solved.dof : null, ready, reason, loops: loopsKey })
  }, [featureOnly, plane, init, name, profile, solved, ready, reason, loopsKey])
  const go = async () => {
    if (!ready) return
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
  finishable.current = !stepEdit && !featureOnly
  useEffect(() => (stepEdit || featureOnly ? undefined : provideFinish(() => void finishRef.current())), [stepEdit, featureOnly])
  const usedId = featureOnly ? init?.from?.id : undefined
  useEffect(() => (usedId ? provideInUse(usedId) : undefined), [usedId])

  const fields = fieldsFor(draft)
  const sel = selected ? sketch[selected.e] : undefined
  // the ribbon's Sketch tab drives the same tools; it reads them from here while the editor is open
  const drawRef = useRef({ pickTool, look })
  drawRef.current = { pickTool, look }
  const family = familyOf(draft.tool)
  const canMirror = draft.tool === 'select' && sel !== undefined && selected !== null
  const mirroring = pending?.kind === 'mirror'
  const mirrorE = selected?.e ?? -1
  // in a layout effect, so the ribbon's Finish sketch and the panel's Extrude trade the primary look in one frame
  useLayoutEffect(() => {
    if (featureOnly) return undefined
    return provideDraw({
      family,
      pick: (f) => drawRef.current.pickTool(lastVariant[f as Family] ?? VARIANTS[f as Family]?.[0]?.value ?? (f as DrawTool)),
      look: () => drawRef.current.look(),
      mirror: canMirror ? () => setPending((p) => (p?.kind === 'mirror' ? null : { kind: 'mirror', e: mirrorE })) : null,
      mirroring,
      ready,
    })
  }, [featureOnly, family, canMirror, mirroring, mirrorE, ready])
  const driven = constraints.filter((c) => isDimension(c) && c.driven).length
  const words = (t: string) => (phone ? touchWords(t) : t)
  // On a desktop the panel has two cards, drawing and then the solid, which stays folded with the reason until the
  // sketch has a closed profile. A phone keeps its one sheet of controls.
  const card = phone ? { open: true, reason: null } : solidCard({ featureOnly, closedProfiles, issues, drawn: sketch.length > 0 || draft.points.length > 0 })
  const [lenFmt, lenUnit] = readoutUnits(units)
  const dof = solved ? (
    // the header's few words; the tooltip and the accessible name carry the whole line
    <span
      className="sketch-dof"
      role="status"
      data-testid="sketch-dof"
      data-dof={solved.solved.dof}
      data-tone={dofTone(solved.solved)}
      aria-label={`${dofText(solved.solved)}${driven ? `, ${driven} driven` : ''}`}
      data-tip-title={dofText(solved.solved)}
      data-tip-demo="still-sketch-status"
      {...(driven ? { 'data-tip-body': `${driven} driven: the other constraints already set ${driven === 1 ? 'this size' : 'these sizes'}, so ${driven === 1 ? 'it shows' : 'they show'} in parentheses and changes nothing.` } : {})}
    >
      {dofShort(solved.solved)}
    </span>
  ) : null
  const idle = words(pending ? 'Esc stops.' : idleText(draft.tool))
  // On a phone the sheet folds to its header once drawing starts, so the view has the room; the header then shows the
  // tool and the sketch's state, with a button to open the sheet again. Finish sketch stays in the bar below either way.
  // It folds once, at the sketch's first point; after that only the button folds or opens it, so a sheet opened by hand
  // stays open while the next shapes are drawn.
  const drawingNow = draft.points.length > 0
  const foldedOnce = useRef(false)
  useEffect(() => {
    if (!phone || !drawingNow || foldedOnce.current) return
    foldedOnce.current = true
    fold?.setFolded(true)
  }, [phone, drawingNow])
  // Folding hides the sheet's body: focus inside it moves to the sheet's button, so it is never lost on a hidden field.
  const folded = fold?.folded ?? false
  useEffect(() => {
    const slot = fold?.slot
    if (!folded || !slot) return
    const body = slot.closest('.pane')?.querySelector('.sx-rail-body')
    if (body?.contains(document.activeElement)) slot.querySelector<HTMLElement>('[data-testid="sketch-sheet-toggle"]')?.focus()
  }, [folded, fold?.slot])
  // A phone's on-screen keyboard: the sheet lifts above it, and the focused field scrolls into view in the sheet.
  useEffect(() => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport
    const rail = fold?.slot?.closest<HTMLElement>('.pane')
    if (!phone || !vv || !rail) return
    const fit = () => {
      rail.style.setProperty('--kb-lift', `${keyboardLift(window.innerHeight, vv)}px`)
      const a = document.activeElement
      if (a instanceof HTMLElement && rail.contains(a)) a.scrollIntoView({ block: 'nearest' })
    }
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    return () => {
      vv.removeEventListener('resize', fit)
      vv.removeEventListener('scroll', fit)
      rail.style.removeProperty('--kb-lift')
    }
  }, [phone, fold?.slot])
  // Opened on a phone, the sheet is tall enough to show the drawing's controls whole, through the Show chips, above its
  // footer; the solid's settings below them scroll. The CSS caps it at the room between the top bar and the phone's bar.
  useEffect(() => {
    const rail = fold?.slot?.closest<HTMLElement>('.pane')
    const body = rail?.querySelector<HTMLElement>('.sx-rail-body')
    if (!phone || !rail || !body || folded || featureOnly) return
    const fit = () => {
      const show = body.querySelector('.sketch-show')
      const foot = body.querySelector<HTMLElement>('.cad-footer')
      if (!show || !foot) return rail.style.removeProperty('--sheet-fit')
      // the chips' bottom at the top of the scroll, and the footer's top with the fade above it
      const chips = show.getBoundingClientRect().bottom + body.scrollTop
      // the fade shows only while more is below, so its room is kept either way (24 px, as cad.css draws it)
      const fade = parseFloat(getComputedStyle(foot, '::before').height) || 24
      const short = chips - (foot.getBoundingClientRect().top - fade)
      rail.style.setProperty('--sheet-fit', `${Math.ceil(rail.getBoundingClientRect().height + short)}px`)
    }
    fit()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    for (const el of body.children) ro?.observe(el)
    window.addEventListener('resize', fit)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', fit)
      rail.style.removeProperty('--sheet-fit')
    }
  }, [phone, fold?.slot, folded, featureOnly])
  const summary =
    phone && fold?.slot && !featureOnly
      ? createPortal(
          <span className="sketch-summary" data-testid="sketch-summary">
            <span className="sketch-summary-tool">{familyName(familyOf(draft.tool))}</span>
            <span className="sketch-summary-state">{solved ? dofText(solved.solved) : 'Sketch'}</span>
            <Button size="sm" variant="ghost" className="sketch-summary-toggle" data-testid="sketch-sheet-toggle" aria-expanded={!fold.folded} iconEnd={fold.folded ? 'chevron-up' : 'chevron-down'} onClick={() => fold.setFolded(!fold.folded)}>
              {fold.folded ? 'Settings' : 'Less'}
            </Button>
          </span>,
          fold.slot,
        )
      : null
  const drawing = (
    <>
      <PhonePicker>
        <Seg label="Drawing tool" size="sm" full className="sketch-tools" value={familyOf(draft.tool)} onChange={(f) => pickTool(lastVariant[f] ?? VARIANTS[f]?.[0]?.value ?? (f as DrawTool))} options={FAMILIES} />
        {/* the ways to draw the family, shown only when it has more than one; the phone bar keeps its row */}
        <SketchVariants tool={draft.tool} onPick={pickTool} sides={sides} onSides={setSides} reserve={phone} />
      </PhonePicker>
      <p className="cad-hint sketch-hint" role="status" {...(phone ? {} : { 'data-tip-title': familyName(familyOf(draft.tool)), 'data-tip-body': idle })}>
        <Icon name={phone ? 'info' : 'mouse-left'} size={15} />{' '}
        <span className="sketch-hint-text">{words(pending ? PENDING_HINTS[pending.kind] : hintText(draft.tool))}</span>
      </p>
      {phone ? (
        <>
          {/* the live sizes while drawing; between shapes, what else the tool takes */}
          <p className="cad-hint sketch-readout"><span ref={readoutRef} className="sx-mono" aria-live="off" data-idle={idle} /></p>
          {/* the sheet's summary says it on a docked sheet */}
          {solved && !fold?.slot ? (
            <p className="sketch-dof" role="status" data-testid="sketch-dof" data-dof={solved.solved.dof} data-tone={dofTone(solved.solved)} data-tip-demo="still-sketch-status" {...(driven ? { 'data-tip-title': 'Driven dimensions', 'data-tip-body': 'The other constraints already set these sizes, so they show in parentheses and change nothing.' } : { 'data-tip-title': 'Sketch status' })}>
              {dofText(solved.solved)}
              {driven ? <span className="sketch-driven">, {driven} driven</span> : null}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="sketch-palette" role="group" aria-label="Sketch palette">
        {phone ? <Button size="sm" className="tp-pill" icon="top-view" data-tip="sketch.look" onClick={look}>Look at the sketch</Button> : null}
        {/* Grid shows the grid and Snap snaps to its step: one row, two controls, so snapping works with the grid hidden */}
        <div className="sketch-grid-snap" data-testid="sketch-grid-snap">
          <label className="tp-label" htmlFor="sk-grid">Grid</label>
          <Switch id="sk-grid" checked={pal.grid} onChange={(on) => setPal({ grid: on })} label="Grid" />
          <label className="tp-label sketch-snap-label" htmlFor="sk-step" data-tip-title="Snap" data-tip-body="Points land on this step whether the grid shows or not. Off places them where you click.">Snap</label>
          <Select id="sk-step" aria-label="Snap step" value={pal.snap ? pal.step : 'off'} onChange={(e) => setPal(e.target.value === 'off' ? { snap: false } : { snap: true, step: e.target.value })}>
            <option value="off">Off</option>
            {gridSteps(units, pal.step).map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </Select>
        </div>
        <Row label={<span data-tip-title="Section" data-tip-body="Cut away the model in front of the sketch plane">Section</span>} htmlFor="sk-section">
          <Switch id="sk-section" checked={pal.section} onChange={(on) => setPal({ section: on })} label="Section" />
        </Row>
        {/* what the sketch shows: filters, so chips */}
        <div className="tp-row sketch-show">
          <span className="tp-label" id="sk-show-label">Show</span>
          {/* the chips' own column is what decides one row or two, whatever the label beside it takes */}
          <div className="sketch-show-room">
            <div className="tp-chips" role="group" aria-labelledby="sk-show-label">
              {(['profiles', 'points', 'dimensions', 'constraints'] as const).map((k) => (
                <button key={k} id={`sk-show-${k}`} type="button" className="tp-chip" aria-pressed={pal[k]} aria-label={`Show ${k}`} onClick={() => setPal({ [k]: !pal[k] })}>
                  {k[0]!.toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
  // what Select picked and what to do with it: in the drawing card on a desktop, after the check's messages on a phone
  const picks = (
    <>
      {draft.tool === 'select' && sel ? (
        <>
          {phone ? null : <p className="sketch-picked sx-mono" data-testid="sketch-picked">{pickedText(sketch, selected, lenFmt, lenUnit)}</p>}
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
            {copies.kind === 'line' ? (
              <>
                <Num id="sk-step-x" label="Step across" unit="mm" value={copies.dx} onChange={(dx) => setCopies({ ...copies, dx })} onEnter={() => void copyLoop(selected!.e)} />
                <Num id="sk-step-y" label="Step up" unit="mm" value={copies.dy} onChange={(dy) => setCopies({ ...copies, dy })} onEnter={() => void copyLoop(selected!.e)} />
              </>
            ) : (
              <Num id="sk-pattern-angle" label="Angle" unit="°" value={copies.angle} onChange={(angle) => setCopies({ ...copies, angle })} />
            )}
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
  )
  const messages = issues.length ? (
    <div className="cad-issues">
      {issues.slice(0, 6).map((i, k) => (
        <Message key={k} text={i.message} />
      ))}
    </div>
  ) : null
  const distanceField = <Num id="sk-dist" label={extentKind === 'symmetric' ? 'Total distance' : 'Distance'} unit="mm" value={distance} onChange={setDistance} onEnter={() => void go()} />
  const finishWith = <Choice id="sk-finish" label="Finish with" bare value={finish} onChange={setFinish} options={FINISH_WITH} />
  const solid = (
    <>
      {featureOnly || !phone ? null : finishWith}
      {finish === 'extrude' ? (
        <>
          {/* Flip sits beside Direction, at the right of its label line, on a phone too */}
          <div className="sketch-direction">
            <Choice id="sk-direction" label="Direction" value={extentKind} onChange={setExtentKind} options={DIRECTIONS} />
            <Button
              size="sm"
              className="tp-pill"
              icon="mirror"
              data-testid="sketch-flip"
              aria-pressed={flip}
              tip={{ title: 'Flip', body: intoFace ? 'Goes into the face now. Flip sends it out of the face.' : 'Goes out of the face now. Flip sends it into the face.' }}
              onClick={() => setFlip(!flip)}
            >
              Flip
            </Button>
          </div>
          {distanceField}
          {extentKind === 'twoSides' ? <Num id="sk-dist2" label="Other side" unit="mm" value={distance2} onChange={setDistance2} onEnter={() => void go()} /> : <Num id="sk-taper" label="Draft" unit="°" value={taper} onChange={setTaper} onEnter={() => void go()} />}
          <PatternSection value={patternFields} onChange={setPatternFields} />
        </>
      ) : (
        <>
          <Note>{axis ? 'The picked line is the axis.' : featureOnly ? 'Click a straight line of the sketch: it becomes the axis.' : 'Pick a straight line of the sketch with Select: it becomes the axis.'}</Note>
          <Num id="sk-angle" label="Angle" unit="°" value={angle} onChange={setAngle} onEnter={() => void go()} />
        </>
      )}
      <Choice id="sk-result" label="Result" value={op} onChange={setOperation} options={RESULTS.map((o) => (o.value === 'new' ? o : { ...o, disabled: !canInto }))} />
      {canInto ? null : <Note testId="sketch-result-reason">{featureOnly ? 'Join and Cut need a body on the plate.' : 'Join and Cut need a body: sketch on one of its faces.'}</Note>}
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
    </>
  )
  // Other plane sits in the header beside the face being sketched on, on a phone too, so the footer holds only Cancel and the primary
  // with something drawn, Other plane asks first: the drawing belongs to this plane and would go
  const change = featureOnly ? null : (
    <Button size="sm" className="tp-pill" data-testid="sketch-other-plane" aria-expanded={sketch.length ? askPlane : undefined} onClick={() => (sketch.length ? setAskPlane(!askPlane) : onRestart())} disabled={busy} tip={{ title: 'Sketch on another plane or face' }}>
      Other plane
    </Button>
  )
  askOpen.current = askPlane && sketch.length > 0
  const planeAsk = askPlane && sketch.length ? (
    <div className="cad-issues" role="group" aria-label="Other plane" data-testid="sketch-plane-ask">
      <Message text="Another plane starts a new sketch, and this drawing goes. Finish sketch first to keep it." />
      <div className="cad-row sketch-loop-actions">
        <Button size="sm" className="tp-pill" data-testid="sketch-plane-keep" onClick={() => setAskPlane(false)}>
          Keep drawing
        </Button>
        <Button size="sm" className="tp-pill" data-testid="sketch-plane-drop" onClick={onRestart}>
          Drop it and pick a plane
        </Button>
      </div>
    </div>
  ) : null
  return (
    <Shell title={featureOnly ? (finish === 'extrude' ? 'Extrude' : 'Revolve') : 'Sketch'} aside={plane.label} {...(change ? { action: change } : {})}>
      {planeAsk}
      {featureOnly ? (
        <>
          {messages}
          {solid}
        </>
      ) : phone ? (
        <>
          {drawing}
          {messages}
          {picks}
          {solid}
        </>
      ) : (
        <>
          <Card title="Drawing" sub={familyName(familyOf(draft.tool))} state={dof ?? undefined} testId="sketch-drawing" dense>
            {drawing}
            {picks}
          </Card>
          <Card
            title="Solid"
            testId="sketch-solid"
            dense
            muted={!card.open}
            {...(card.reason ? { reason: card.reason } : {})}
            // Extrude or Revolve, at the header's right once the card opens
            state={card.open ? <Seg label="Finish with" size="sm" className="sketch-finish-with" value={finish} onChange={setFinish} options={FINISH_WITH} /> : undefined}
          >
            {messages}
            {solid}
          </Card>
        </>
      )}
      {note ? <Message text={note} /> : null}
      {summary}
      <ToolFooter
        verb={finish === 'extrude' ? 'Extrude' : 'Revolve'}
        verbs={['Extrude', 'Revolve']}
        onApply={go}
        busy={busy}
        disabled={!ready}
        // the check's tenth of a second is no reason to show: the line would only blink and move the settings above
        reason={check === null && reason === CHECKING ? null : phone && reason ? reason.replace('(Esc or a right click)', '(press and hold)') : reason}
        // one primary at a time: Finish sketch while drawing, Extrude once the profile can make a solid
        primary={ready || featureOnly}
        // the sketch steps its own Esc and Enter; Extrude or Revolve from a finished sketch is a plain tool
        keys={featureOnly}
      />
      {feel && !featureOnly && onShapeTool(draft) ? (
        <ShapeBoxes
          key={`draw:${draft.tool}`}
          ref={boxes}
          mode="draw"
          fields={fields.map((f): ShapeBoxField => ({ key: boxKeyOf(f.label)!, label: f.label, unit: f.unit === 'mm' ? units.length : f.unit }))}
          area={() => view?.canvas?.getBoundingClientRect() ?? null}
          focus={Math.min(pillFocus, Math.max(0, fields.length - 1))}
          text={typed}
          focusToken={boxToken}
          onFocus={setPillFocus}
          onChange={(t) => setTyped(t.some((v) => v !== '') ? t : null)}
          onCommit={() => commitField()}
          onEscape={dropShape}
          onLeave={leaveBoxes}
          onToolKey={boxToolKey}
          view={() => view?.canvas}
        />
      ) : null}
      {editShape ? (
        <ShapeBoxes
          key={`edit:${editKey}`}
          ref={editBoxes}
          mode="edit"
          fields={editValues.map((v): ShapeBoxField => ({ key: v.key, label: v.label, unit: v.unit === 'mm' ? units.length : v.unit, set: v.set }))}
          area={() => view?.canvas?.getBoundingClientRect() ?? null}
          focus={Math.min(editFocus, Math.max(0, editValues.length - 1))}
          text={editText}
          focusToken={editToken}
          onFocus={setEditFocus}
          onChange={(t) => setEditText(t)}
          onCommit={(cleared) => void commitEdit(cleared)}
          onEscape={() => {
            setEditText(null)
            view?.canvas?.focus()
          }}
          onLeave={leaveBoxes}
          onToolKey={boxToolKey}
        />
      ) : null}
      {featureOnly || !drawingTool(draft.tool) || (feel && onShapeTool(draft)) ? null : (
        <CursorPills
          ref={pills}
          area={() => view?.canvas?.getBoundingClientRect() ?? null}
          fields={fields.map((f) => ({ label: f.label, unit: f.unit === 'mm' ? units.length : f.unit }))}
          text={!fields.length}
          focus={Math.min(pillFocus, Math.max(0, fields.length - 1))}
          editing={typed}
          onFocus={setPillFocus}
          onChange={setTyped}
          onCommit={commitField}
          // Esc in an empty pill ends typing and starts again from the first pill
          onCancel={() => (setTyped(null), setPillFocus(0), view?.canvas?.focus())}
          // Tab past the last pill goes on to the panel, Shift+Tab before the first back to the view; the typed numbers
          // stay for Enter in the view
          onLeave={(back) => {
            const first = back ? null : document.querySelector<HTMLElement>('[data-section="cad-tool"] :is(button, input, select, [tabindex="0"]):not(:disabled)')
            ;(first ?? view?.canvas)?.focus()
          }}
        />
      )}
      {dimField
        ? createPortal(
            <CursorField
              key={`${dimField.index ?? 'new'}:${dimField.x}:${dimField.y}`}
              x={dimField.x}
              y={dimField.y}
              labels={[{ label: DIM_NAMES[dimField.c.type], unit: dimField.c.type === 'angle' ? '°' : units.length }]}
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
