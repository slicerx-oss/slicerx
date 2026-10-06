// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Typed calls for the modeling operations in sx-geom (packages/geom/src/json_cad.rs): booleans,
// arrays, measure, the face shape tool, text bodies and automatic import. Everything runs in the
// geometry worker. Units are millimeters and degrees.
//
// Frames: a mesh input can carry its plate transform (three.js Matrix4.elements, column-major,
// local to world). Picks, features, face frames and new bodies are in world coordinates. A mesh
// that replaces an input (a boolean result, a merged array, a join or cut) comes back in that
// input's local frame, so the object keeps its transform.
import { geom, type GeomMesh } from './client'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
/** 16 numbers, column-major, like three.js Matrix4.elements. */
export type Mat4 = number[]

/** A mesh, optionally with its local-to-world transform. */
export type MeshItem = GeomMesh | { mesh: GeomMesh; transform?: Mat4 }

export interface EdgeReport {
  boundaryEdges: number
  nonManifoldEdges: number
  flippedEdges: number
}

/** A mesh result with the checks callers show. */
export interface MeshResult {
  mesh: GeomMesh
  shells: number
  triangles: number
  bounds: { min: Vec3; max: Vec3 } | null
  volumeMm3: number
  edges: EdgeReport
  watertight: boolean
}

// Booleans

export type BoolOp = 'union' | 'difference' | 'intersection'

export interface BooleanOptions {
  /** auto picks exact for clean inputs and robust for soup or self-intersections. */
  engine?: 'auto' | 'exact' | 'robust'
  /** Treat inside-out shells as solid (scans, random winding). Forces robust. */
  keepInverted?: boolean
}

export interface BooleanReport {
  engine: 'exact' | 'robust'
  uncleanInputs: number
  triangles: number
  shells: number
  volumeMm3: number
  watertight: boolean
  empty: boolean
}

/** Union of a and b, a minus b, or their intersection. The result is in a[0]'s frame. */
export function booleanOp(op: BoolOp, a: MeshItem[], b: MeshItem[] = [], options: BooleanOptions = {}, signal?: AbortSignal) {
  return geom().call<MeshResult & { report: BooleanReport }>('boolean', { op, a, b, options }, signal)
}

// Arrays

export type ArraySpec =
  | { kind: 'linear'; count: number; step: Vec3; count2?: number; step2?: Vec3 }
  | { kind: 'circular'; count: number; center: Vec3; axis?: Vec3; angleDeg?: number; rotateCopies?: boolean }

export interface ArrayResult {
  count: number
  /** World transform of each copy, the original first. */
  transforms: Mat4[]
  /** Copies whose bounds overlap (they would fuse when merged). */
  overlapping: boolean
}

/** Transforms for each copy; nothing is baked until slicing. */
export function arrayCopies(mesh: MeshItem, spec: ArraySpec, signal?: AbortSignal) {
  return geom().call<ArrayResult>('array', { mesh, spec }, signal)
}

/** All copies unioned into one mesh, in the item's frame. */
export function arrayMerged(mesh: MeshItem, spec: ArraySpec, options: BooleanOptions = {}, signal?: AbortSignal) {
  return geom().call<ArrayResult & MeshResult & { report: BooleanReport }>('array', { mesh, spec, merge: true, options }, signal)
}

// Measure

export type Feature =
  | { kind: 'point'; at: Vec3 }
  | { kind: 'edge'; a: Vec3; b: Vec3 }
  | { kind: 'circle'; center: Vec3; axis: Vec3; radius: number; sweepDeg: number }
  | { kind: 'plane'; point: Vec3; normal: Vec3; areaMm2: number; triangles?: number[] }
  | { kind: 'cylinder'; point: Vec3; axis: Vec3; radius: number; triangles?: number[] }
  | { kind: 'surface'; at: Vec3; normal: Vec3; triangles?: number[] }

/** A ray hit: the triangle index and the world point. */
export interface Pick {
  triangle: number
  at: Vec3
}

/** Fields that do not apply are absent. */
export interface Measurement {
  distanceMm?: number
  from?: Vec3
  to?: Vec3
  deltaMm?: Vec3
  centerDistanceMm?: number
  angleDeg?: number
  parallel?: boolean
  radiusMm?: number
  diameterMm?: number
  lengthMm?: number
  areaMm2?: number
}

/** The feature under a pick: point, edge, circle, plane, cylinder or surface. */
export async function featureAt(mesh: MeshItem, pick: Pick, snapMm = 0, signal?: AbortSignal): Promise<Feature> {
  const r = await geom().call<{ feature: Feature }>('measure.feature', { mesh, pick, snapMm }, signal)
  return r.feature
}

/** One feature (its size) or two (distance and angle between them). */
export function measure(a: Feature, b?: Feature, signal?: AbortSignal) {
  return geom().call<Measurement>('measure', b ? { a, b } : { a }, signal)
}

// Face shape tool

export interface FaceFrame {
  origin: Vec3
  /** Outward normal. */
  normal: Vec3
  u: Vec3
  v: Vec3
}

export interface Polygon {
  outer: Vec2[]
  holes: Vec2[][]
}

export interface FacePick {
  frame: FaceFrame
  /** Outline in frame coordinates, for drawing and snaps. */
  outline: Polygon[]
  areaMm2: number
  at: Vec2
  min: Vec2
  max: Vec2
  triangles: number[]
}

export type Shape =
  | { type: 'rectangle'; widthMm: number; heightMm: number; cornerRadiusMm?: number }
  | { type: 'circle'; diameterMm: number }
  | { type: 'slot'; lengthMm: number; widthMm: number }
  | { type: 'polygon'; sides: number; diameterMm: number; fit?: 'inscribed' | 'circumscribed' }
  | { type: 'text'; text: string; sizeMm: number; letterSpacingMm?: number; lineSpacing?: number; align?: 'left' | 'center' | 'right' }

/** Free outlines for shapeProfile and extrudeShape, beside the typed shapes. */
export type FreeShape =
  /** Closed loops in frame coordinates; check them first with checkSketch. */
  | { type: 'sketch'; loops: SketchLoop[] }
  /** The filled outline of SVG artwork (colors merged), widthMm wide, centered on the placement, SVG up along v. */
  | { type: 'svg'; svg: string; widthMm: number; toleranceMm?: number }

export interface Placement {
  /** Center in frame coordinates. */
  center?: Vec2
  rotationDeg?: number
}

export interface ExtrudeSpec {
  distanceMm: number
  extent?: 'oneSide' | 'symmetric' | 'twoSides'
  distance2Mm?: number
  flip?: boolean
  /** -45 to 45; positive narrows away from the face. */
  taperDeg?: number
  operation?: 'new' | 'join' | 'cut'
}

export interface ExtrudeReport {
  volumeChangeMm3: number
  /** The tool reaches the target (always true for a new body). */
  touches: boolean
  shells: number
  watertight: boolean
  boolean?: BooleanReport
}

/** The flat face around a picked triangle. Fails on curved faces. */
export function pickFace(mesh: MeshItem, pick: Pick, signal?: AbortSignal) {
  return geom().call<FacePick>('face.pick', { mesh, triangle: pick.triangle, at: pick.at }, signal)
}

/** The shape's outline in frame coordinates, for the live preview. */
export async function shapeProfile(shape: Shape | FreeShape, placement: Placement = {}, fontBase64?: string, signal?: AbortSignal): Promise<Polygon[]> {
  const r = await geom().call<{ polygons: Polygon[] }>('shape.profile', { shape, placement, fontBase64 }, signal)
  return r.polygons
}

export interface ExtrudeRequest {
  /** From pickFace; the bed at the origin when absent. */
  frame?: FaceFrame
  shape: Shape | FreeShape
  placement?: Placement
  spec: ExtrudeSpec
  /** The body to join to or cut from. */
  target?: MeshItem
  fontBase64?: string
  /** Copies of the shape on its face, made in the same step (cad/pattern.ts). */
  pattern?: import('../cad/pattern').Pattern
}

/**
 * Extrudes a shape. Join and cut return the changed target in its own frame (frame: 'target');
 * a new body comes back in world coordinates (frame: 'world'). tool is the world tool body.
 */
export function extrudeShape(req: ExtrudeRequest, signal?: AbortSignal) {
  return geom().call<MeshResult & { frame: 'target' | 'world'; tool: GeomMesh; report: ExtrudeReport }>('shape.extrude', req, signal)
}

// Sketches: closed loops of lines, arcs and circles on a face frame (or the bed). No constraint
// solver: the engine checks what was typed and names the loop and segment of each problem.

/** One piece of a loop, starting where the previous one ended. */
export type SketchSegment =
  | { type: 'line'; to: Vec2 }
  /** angleDeg: direction in the plane, 0 along u, counterclockwise. */
  | { type: 'line'; lengthMm: number; angleDeg: number }
  /** turnDeg: relative to the end of the previous segment, positive turns left. */
  | { type: 'line'; lengthMm: number; turnDeg: number }
  /** Around center, sweepDeg positive counterclockwise. */
  | { type: 'arc'; center: Vec2; sweepDeg: number }
  | { type: 'arc'; to: Vec2; through: Vec2 }
  | { type: 'arc'; to: Vec2; radiusMm: number; clockwise?: boolean; large?: boolean }
  /** Tangent to the previous segment; positive sweepDeg turns left. */
  | { type: 'arc'; radiusMm: number; sweepDeg: number }

/** A loop closes when its last segment ends within 0.001 mm of start. */
export type SketchLoop =
  | { start: Vec2; segments: SketchSegment[] }
  | { type: 'circle'; center: Vec2; diameterMm: number }
  | { points: Vec2[] }

export type SketchIssueKind = 'open' | 'zeroLength' | 'selfCrossing' | 'loopsCross' | 'badArc' | 'tooSmall'

export interface SketchIssue {
  /** Counts from 0. */
  loop: number
  /** Counts from 0. */
  segment?: number
  kind: SketchIssueKind
  /** For people; counts from 1. */
  message: string
  at?: Vec2
}

export interface SketchCheck {
  ok: boolean
  polygons: Polygon[]
  areaMm2: number
  loops: { index: number; role: 'outer' | 'hole'; areaMm2: number; lengthMm: number }[]
  issues: SketchIssue[]
}

/** Checks a sketch. Bad geometry comes back as issues, never as a thrown error. */
export function checkSketch(loops: SketchLoop[], signal?: AbortSignal) {
  return geom().call<SketchCheck>('sketch.check', { loops }, signal)
}

export interface RevolveRequest {
  /** From pickFace; the bed when absent. */
  frame?: FaceFrame
  loops: SketchLoop[]
  /** In frame coordinates. The profile must stay on one side. */
  axis: { point: Vec2; direction: Vec2 }
  /** Sweep, up to 360 (the default), counterclockwise about direction by the right hand rule. */
  angleDeg?: number
  operation?: 'new' | 'join' | 'cut'
  target?: MeshItem
}

/** Revolves a sketch. Replies like extrudeShape. */
export function revolveSketch(req: RevolveRequest, signal?: AbortSignal) {
  return geom().call<MeshResult & { frame: 'target' | 'world'; tool: GeomMesh; report: ExtrudeReport }>('sketch.revolve', req, signal)
}

export interface SnapPoint {
  at: Vec2
  kind: 'vertex' | 'midpoint' | 'center'
  /** For centers of circles and arcs. */
  radiusMm?: number
}

export interface Snaps {
  points: SnapPoint[]
  /** The outline with straight runs merged, for edge snaps and the projected outline. */
  edges: { a: Vec2; b: Vec2 }[]
}

/** Snap targets on a sketch plane: the picked face's outline, and sharp edges of meshes lying in the plane. */
export function sketchSnaps(frame: FaceFrame, outline: Polygon[] = [], meshes: MeshItem[] = [], nearMm?: number, signal?: AbortSignal) {
  return geom().call<Snaps>('sketch.snaps', { frame, outline, meshes, nearMm }, signal)
}

/** Grows (positive) or shrinks a sketch's region. */
export function offsetSketch(source: { loops: SketchLoop[] } | { polygons: Polygon[] }, distanceMm: number, join: 'round' | 'miter' = 'round', signal?: AbortSignal) {
  return geom().call<{ polygons: Polygon[]; areaMm2: number }>('sketch.offset', { ...source, distanceMm, join }, signal)
}

// Push and pull

/** A face that moved, as face.push reports it (world). Pass it to evaluateDimensions. */
export interface MovedFace {
  frame: FaceFrame
  outline: Polygon[]
  distanceMm: number
}

export interface PushRequest {
  mesh: MeshItem
  /** The pick on the face, as for pickFace (world). */
  pick: Pick
  /** Positive pulls out and adds material, negative pushes in and cuts. Not 0. */
  distanceMm: number
  options?: BooleanOptions
}

export type PushResult = MeshResult & { tool: GeomMesh; operation: 'join' | 'cut'; report: ExtrudeReport; moved: MovedFace }

/** Moves the flat face (the whole connected flat region, holes included) along its normal. The body comes back in its own frame. */
export function pushFace(req: PushRequest, signal?: AbortSignal) {
  const { mesh, pick, distanceMm, options } = req
  return geom().call<PushResult>('face.push', { mesh, triangle: pick.triangle, at: pick.at, distanceMm, options }, signal)
}

/** The swept prism alone (world), with no boolean, for drawing while dragging. Run pushFace on release. */
export function pushPreview(face: { frame: FaceFrame; outline: Polygon[] }, distanceMm: number, signal?: AbortSignal) {
  return geom().call<{ tool: GeomMesh; operation: 'join' | 'cut' }>('face.push.preview', { frame: face.frame, outline: face.outline, distanceMm }, signal)
}

// Fillet and chamfer (docs/cad-fillet.md): round or bevel the straight edge where two flat faces
// meet. Convex edges lose material, concave edges gain it. Edges next to curved faces are reported
// as not supported.

/** An edge as the ops take it: its end points and the outward normal of its first face (world). Store it as is. */
export interface EdgeRef {
  a: Vec3
  b: Vec3
  /** The face that takes distanceMm in a two distance chamfer. */
  face: Vec3
  /** The ends moved with a face they lie on (a history replay): the edge is found along its line. */
  moved?: boolean
  /** A round edge (a hole's rim, a boss's root): the center of the circle; `a` is a corner of it and `b` the same. */
  center?: Vec3
}

export interface EdgeFace {
  normal: Vec3
  curved: boolean
  /** For the hover highlight. */
  triangles: number[]
}

export interface EdgePick {
  edge: EdgeRef
  lengthMm: number
  /** The picked face first; one entry when the mesh is open there. */
  faces: EdgeFace[]
  /** Angle between the faces inside the material: below 180 convex, above 180 concave. */
  dihedralDeg: number
  convex: boolean
  supported: boolean
  /** Why not, in words, when supported is false. */
  reason?: string
  /** The widest bevel that fits on each face, measured on the face from the edge. */
  maxDistanceMm: [number, number]
  maxRadiusMm: number
  /** This edge and the edges continuing it tangentially, in order. */
  chain: EdgeRef[]
  /** Every edge around the picked face's ring holding this edge, starting with it. */
  loop: { edge: EdgeRef; supported: boolean }[]
}

/** The sharp edge of the picked flat face nearest the pick. */
export function pickEdge(mesh: MeshItem, pick: Pick, signal?: AbortSignal) {
  return geom().call<EdgePick>('edge.pick', { mesh, triangle: pick.triangle, at: pick.at }, signal)
}

export type EdgeProfile =
  /** distanceMm on the edge's first face, distance2Mm (default equal) on the second. */
  | { kind: 'chamfer'; distanceMm: number; distance2Mm?: number }
  /** toleranceMm: chord tolerance of the round, default 0.01, from 0.001 to 1. */
  | { kind: 'fillet'; radiusMm: number; toleranceMm?: number }

export interface EdgeRequest {
  mesh: MeshItem
  /** One or more, from pickEdge. */
  edges: EdgeRef[]
  profile: EdgeProfile
  options?: BooleanOptions
}

export type EdgeResult = MeshResult & {
  report: { volumeChangeMm3: number; shells: number; watertight: boolean; boolean: BooleanReport }
  /** Per edge, in request order. */
  edges: { convex: boolean; dihedralDeg: number; lengthMm: number }[]
  /** Corners where three filleted edges meet. */
  corners: { at: Vec3; kind: 'sphere' }[]
}

function edgeBody(req: EdgeRequest) {
  const { kind, ...sizes } = req.profile
  return { op: kind === 'fillet' ? 'edge.fillet' : 'edge.chamfer', body: { mesh: req.mesh, edges: req.edges, ...sizes, options: req.options } }
}

/** Fillets or chamfers the edges. The body comes back in its own frame. Sizes that do not fit fail in words. */
export function edgeOp(req: EdgeRequest, signal?: AbortSignal) {
  const { op, body } = edgeBody(req)
  return geom().call<EdgeResult>(op, body, signal)
}

/** The pieces alone (world), no boolean: cut is what would go, join what would be added. Same checks as edgeOp. */
export function edgePreview(req: EdgeRequest, signal?: AbortSignal) {
  const { op, body } = edgeBody(req)
  return geom().call<{ cut: GeomMesh; join: GeomMesh }>(`${op}.preview`, body, signal)
}

// Holes (sx-geom hole.rs)

/** A round hole: its entry center (world) and the way out through it, its size and depth. */
export interface Hole {
  entry: Vec3
  axis: Vec3
  diameterMm: number
  depthMm: number
  /** Open at the far end too. */
  through: boolean
}

/** What a hole becomes, mm. A counterbore or a countersink is at the entry. */
export interface HoleSpec {
  diameterMm: number
  /** A blind hole's new depth; its own depth when absent. A through hole stays through. */
  depthMm?: number
  counterbore?: { diameterMm: number; depthMm: number }
  countersink?: { diameterMm: number; angleDeg: number }
}

/** The hole whose wall the pick is on, entered from the end nearest the pick. */
export function holeFind(mesh: MeshItem, pick: Pick, signal?: AbortSignal) {
  return geom().call<Hole>('hole.find', { mesh, triangle: pick.triangle, at: pick.at }, signal)
}

/** The hole made to `spec` in place, found again on the mesh first. The result is in the item's frame. */
export function holeApply(mesh: MeshItem, hole: Hole, spec: HoleSpec, signal?: AbortSignal) {
  return geom().call<MeshResult & { report: { volumeChangeMm3: number; watertight: boolean; shells: number } }>('hole.apply', { mesh, hole, spec }, signal)
}

// Shell (sx-geom shell.rs)

/** A face to leave open: a point on it and its outward normal, world. */
export interface OpenFace {
  at: Vec3
  normal: Vec3
}

export interface ShellReport {
  /** Every face moved in by the wall; otherwise `note` says why the voxel wall was used. */
  exact: boolean
  note?: string
  openFaces: number
  volumeChangeMm3: number
  watertight: boolean
  shells: number
}

/** The body hollowed to `wallMm` with the faces at `open` left open. The result is in the item's frame. */
export function shellBody(mesh: MeshItem, open: OpenFace[], wallMm: number, signal?: AbortSignal) {
  return geom().call<MeshResult & { report: ShellReport }>('shell', { mesh, open, wallMm }, signal)
}

// Threads (sx-geom thread.rs)

/** An ISO coarse size. */
export interface ThreadSize {
  name: string
  majorMm: number
  pitchMm: number
}

/** A round surface a thread can go on (world): where it starts, the way out through that end, its size and length. */
export interface ThreadTarget {
  start: Vec3
  axis: Vec3
  diameterMm: number
  lengthMm: number
  /** A hole's wall, not a boss or rod. */
  internal: boolean
  /** Open at the far end too; otherwise the thread stops half a pitch short of it. */
  openEnd: boolean
  /** The size that suits it, and every size there is. */
  suggested: string
  sizes: ThreadSize[]
}

/** Where a thread goes, as a history step keeps it. */
export type ThreadPlace = Omit<ThreadTarget, 'suggested' | 'sizes'>

export interface ThreadSpec {
  size: string
  /** From the start; the whole surface when absent. */
  lengthMm?: number
  /** Per side: an external thread this much smaller, an internal one this much larger. */
  clearanceMm: number
}

/** The hole, boss or rod the pick is on, starting at the end nearest the pick. */
export function threadFind(mesh: MeshItem, pick: Pick, signal?: AbortSignal) {
  return geom().call<ThreadTarget>('thread.find', { mesh, triangle: pick.triangle, at: pick.at }, signal)
}

/** The thread cut in place. The result is in the item's frame. */
export function threadApply(mesh: MeshItem, thread: ThreadPlace, spec: ThreadSpec, signal?: AbortSignal) {
  return geom().call<MeshResult & { report: { volumeChangeMm3: number; watertight: boolean; shells: number; lengthMm: number; maxLayerMm: number } }>('thread.apply', { mesh, thread, spec }, signal)
}

/** A sketch corner: vertex i of a loop is where segment i starts (points[i] for point loops). Counts from 0. */
export interface SketchCorner {
  loop: number
  vertex: number
}

export interface SketchCornerResult {
  /** Changed loops are rewritten with lines as { type: 'line', to } and new arcs as { type: 'arc', center, sweepDeg }. */
  loops: SketchLoop[]
  /** Per corner, in request order: the new arc or bevel line in the returned loop. */
  added: { loop: number; segment: number }[]
}

/** Rounds sketch corners between two straight segments. */
export function filletSketch(loops: SketchLoop[], corners: SketchCorner[], radiusMm: number, signal?: AbortSignal) {
  return geom().call<SketchCornerResult>('sketch.fillet', { loops, corners, radiusMm }, signal)
}

/** Bevels sketch corners: distanceMm back along the segment ending at the corner, distance2Mm (default equal) along the next. */
export function chamferSketch(loops: SketchLoop[], corners: SketchCorner[], distanceMm: number, distance2Mm?: number, signal?: AbortSignal) {
  return geom().call<SketchCornerResult>('sketch.chamfer', { loops, corners, distanceMm, distance2Mm }, signal)
}

// Dimensions that stay on the model: reference dimensions that read the model and never drive it.
// Anchors are stored in the object's local mesh frame, so moving, rotating, scaling and mirroring
// the object keeps them; evaluateDimensions finds them again after a mesh edit.

/** One end of a dimension, local to its object. Store it as is. */
export interface DimensionAnchor {
  /** The caller's object id. */
  object: string
  /** Local pick. */
  pick: Pick
  snapMm: number
  /** Local feature. */
  feature: Feature
}

export type DimensionKind = 'distance' | 'angle' | 'radius' | 'diameter' | 'length'

export interface Dimension {
  id: string
  /** distance and angle need b; radius, diameter and length read a alone. */
  kind: DimensionKind
  a: DimensionAnchor
  b?: DimensionAnchor
  /** The last value shown. */
  value?: number
}

export interface EvaluatedDimension {
  id: string
  status: 'ok' | 'lost'
  value?: number
  unit: 'mm' | 'deg'
  /** Differs from the stored value by more than 0.0005. */
  changed: boolean
  /** World coordinates, for drawing (from, to and so on). */
  measurement?: Measurement
  /** The anchors as found now; store them back. A lost dimension keeps its old anchors. */
  a: DimensionAnchor
  b?: DimensionAnchor
  lost?: ('a' | 'b')[]
  message?: string
}

/** An anchor for the feature under a world pick on an object, plus the world feature for drawing. */
export function dimensionAnchor(object: string, mesh: MeshItem, pick: Pick, snapMm = 0, signal?: AbortSignal) {
  return geom().call<{ anchor: DimensionAnchor; feature: Feature }>('dimension.anchor', { object, mesh, pick, snapMm }, signal)
}

/** Re-evaluates dimensions on the current objects. Pass each pushFace reply's moved (with its object id) so dimensions on the moved face follow it. */
export async function evaluateDimensions(dimensions: Dimension[], objects: Record<string, MeshItem>, moves: (MovedFace & { object: string })[] = [], signal?: AbortSignal): Promise<EvaluatedDimension[]> {
  const r = await geom().call<{ dimensions: EvaluatedDimension[] }>('dimension.evaluate', { dimensions, objects, moves }, signal)
  return r.dimensions
}

// Text

export interface TextOptions {
  /** Capital letter height. */
  sizeMm?: number
  letterSpacingMm?: number
  lineSpacing?: number
  align?: 'left' | 'center' | 'right'
  toleranceMm?: number
  kerning?: boolean
}

/** Text as a solid, heightMm tall, on the frame (the bed at the origin by default). */
export function textMesh(text: string, heightMm: number, options: TextOptions = {}, frame?: FaceFrame, fontBase64?: string, signal?: AbortSignal) {
  return geom().call<MeshResult & { min: Vec2; max: Vec2; missing: string[] }>('text.mesh', { text, heightMm, options, frame, fontBase64 }, signal)
}

// Automatic import

export type Unit = 'micron' | 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'

export interface AutoOptions {
  repair?: boolean
  /** Rebuild self-intersecting parts up to this many triangles; 0 turns it off. */
  rebuildMaxTriangles?: number
  maxHoleEdges?: number
  split?: boolean
  /** A unit the caller knows, for example a 3MF unit attribute. */
  declaredUnit?: Unit | null
}

export interface ObjectRepair {
  verticesMerged: number
  degenerateRemoved: number
  duplicatesRemoved: number
  trianglesFlipped: number
  holesFilled: number
  holesLeftOpen: number
  nonManifoldEdges: number
  boundaryEdgesAfter: number
  components: number
  watertight: boolean
  volumeMm3: number
  selfIntersectionsFixed: number
  selfIntersectingLeft: number
}

export interface UnitSuggestion {
  unit: Unit
  /** Multiply positions by this to get millimeters. */
  scale: number
  confidence: 'declared' | 'high' | 'low' | 'none'
  /** Apply scale now as an instance scale and show an undo toast. */
  autoApply: boolean
  reason: string
  sizeBefore: Vec3
  sizeAfter: Vec3
}

export interface AutoImport {
  name: string
  format: string
  objects: {
    name: string
    parts: { name: string; slot: number; color: string | null; mesh: GeomMesh; watertight: boolean }[]
    repair: ObjectRepair
  }[]
  unit: UnitSuggestion
  /** One sentence per change, for the import toast. */
  summary: string[]
  warnings: string[]
  slotColors: string[]
}

/** Reads an OBJ, AMF or STL, repairs it, suggests a unit and splits loose bodies. Meshes are unscaled. */
export function importAuto(file: { base64: string; name: string; format?: 'obj' | 'amf' | 'stl'; mtl?: string }, auto: AutoOptions = {}, signal?: AbortSignal) {
  const { base64, ...rest } = file
  return geom().call<AutoImport>('import.auto', { data: { base64 }, ...rest, auto }, signal)
}

// SVG artwork

export interface SvgOptions {
  heightMm?: number
  /** Thickness of a plate under the artwork; 0 for none. */
  baseMm?: number
  baseMarginMm?: number
  fitWidthMm?: number
  fitHeightMm?: number
  maxColors?: number
}

export interface SvgImport {
  parts: { name: string; color: string; slot: number; areaMm2: number; mesh: GeomMesh; watertight: boolean }[]
  slotColors: string[]
  sizeMm: Vec3
  mmPerUnit: number
  warnings: string[]
}

/** Extrudes SVG artwork: each fill color becomes a part with its own filament slot. Strokes, text and images are not read. */
export function extrudeSvg(svg: string, options: SvgOptions = {}, signal?: AbortSignal) {
  return geom().call<SvgImport>('extrude.svg', { svg, options }, signal)
}

// Fit check for print-in-place parts

export interface FitOptions {
  /** Smallest side-by-side gap the printer keeps open, per side. See gapFromHoleTolerance. */
  minGapMm: number
  /** Smallest gap between faces above one another. Default: the larger of minGapMm and layerHeightMm. */
  minVerticalGapMm?: number
  layerHeightMm?: number
}

export interface FitGap {
  /** Indices into FitReport.parts. */
  parts: [number, number]
  gapMm: number
  limitMm: number
  kind: 'horizontal' | 'vertical' | 'fused'
  /** Closest points on each part, world coordinates, for drawing the gap. */
  from: Vec3
  to: Vec3
}

export interface FitReport {
  parts: { bounds: { min: Vec3; max: Vec3 }; volumeMm3: number; triangles: number }[]
  /** Pairs of parts closer than their limit, closest first (at most 64). */
  gaps: FitGap[]
  limitMm: number
  verticalLimitMm: number
  /** One sentence per gap. */
  warnings: string[]
}

/**
 * The per-side gap from the hole tolerance calibration: that test measures the extra hole diameter
 * where a peg fits, which is twice the gap between mating faces.
 */
export function gapFromHoleTolerance(clearanceMm: number): number {
  return clearanceMm / 2
}

/** Warns where separate parts of one object come closer than the printer can keep apart. */
export function fitCheck(parts: MeshItem | MeshItem[], options: FitOptions, signal?: AbortSignal) {
  const where = Array.isArray(parts) ? { meshes: parts } : { mesh: parts }
  return geom().call<FitReport>('fit.check', { ...where, ...options }, signal)
}
