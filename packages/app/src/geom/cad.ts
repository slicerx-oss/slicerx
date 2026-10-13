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
import { geom, usesWorker, type GeomMesh, type TypedGeomMesh } from './client'
import type { ArraySpec, EdgeRef, ExtrudeSpec, FaceFrame, FreeShape, Hole, HoleSpec, Mat4, MovedFace, OpenFace, Placement, Polygon, Shape, SketchLoop, ThreadPlace, ThreadSpec, ThreadTarget, Vec2, Vec3 } from '@slicerx/cad-history'

export type { ArraySpec, EdgeRef, ExtrudeSpec, FaceFrame, FreeShape, Hole, HoleSpec, Mat4, MovedFace, OpenFace, Placement, Polygon, Shape, SketchLoop, SketchSegment, ThreadPlace, ThreadSize, ThreadSpec, ThreadTarget, Vec2, Vec3 } from '@slicerx/cad-history'

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
  /** Copies of the shape on its face, made in the same step (@slicerx/cad-history pattern.ts). */
  pattern?: import('@slicerx/cad-history').Pattern
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

/** The hole whose wall the pick is on, entered from the end nearest the pick. */
export function holeFind(mesh: MeshItem, pick: Pick, signal?: AbortSignal) {
  return geom().call<Hole>('hole.find', { mesh, triangle: pick.triangle, at: pick.at }, signal)
}

/** The hole made to `spec` in place, found again on the mesh first. The result is in the item's frame. */
export function holeApply(mesh: MeshItem, hole: Hole, spec: HoleSpec, signal?: AbortSignal) {
  return geom().call<MeshResult & { report: { volumeChangeMm3: number; watertight: boolean; shells: number } }>('hole.apply', { mesh, hole, spec }, signal)
}

// Shell (sx-geom shell.rs)

export interface ShellReport {
  /** Every face moved in by the wall; otherwise `note` says why the voxel wall was used. */
  exact: boolean
  note?: string
  openFaces: number
  /** The key of each open face as found (0 when it has none). */
  openKeys: number[]
  volumeChangeMm3: number
  watertight: boolean
  shells: number
}

/** The body hollowed to `wallMm` with the faces at `open` left open. The result is in the item's frame. */
export function shellBody(mesh: MeshItem, open: OpenFace[], wallMm: number, signal?: AbortSignal) {
  return geom().call<MeshResult & { report: ShellReport }>('shell', { mesh, open, wallMm }, signal)
}

// Threads (sx-geom thread.rs)

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

/** Solves a constrained sketch (sketch-constraints.ts builds the request); `drag` pulls one point toward a spot. */
export function solveSketch(sketch: import('../cad/sketch-constraints').SolverSketch, drag?: { point: number; to: Vec2 }, signal?: AbortSignal) {
  return geom().call<import('../cad/sketch-constraints').Solved>('sketch.solve', { ...sketch, ...(drag ? { drag } : {}) }, signal)
}

/** Rounds sketch corners between two straight segments. */
export function filletSketch(loops: SketchLoop[], corners: SketchCorner[], radiusMm: number, signal?: AbortSignal) {
  return geom().call<SketchCornerResult>('sketch.fillet', { loops, corners, radiusMm }, signal)
}

/**
 * What a sketch edit gives back: the loops, the loops each came from (a trimmed loop's pieces sit in its place, joined
 * end to end with open chains they meet; copies go at the end), and what a trim takes off.
 */
export interface SketchEdited {
  loops: SketchLoop[]
  from: number[][]
  removed?: SketchLoop
}

/** Takes off the piece of a segment under `at`, back to the nearest crossings either side; a lone curve goes whole. What is left joins the open chains its ends meet, closing when it can. */
export function trimSketch(loops: SketchLoop[], loop: number, segment: number, at: Vec2, signal?: AbortSignal) {
  return geom().call<SketchEdited>('sketch.trim', { loops, loop, segment, at }, signal)
}

/** Runs an open chain's end segment on to the nearest curve it would meet. */
export function extendSketch(loops: SketchLoop[], loop: number, end: 'start' | 'end', signal?: AbortSignal) {
  return geom().call<SketchEdited>('sketch.extend', { loops, loop, end }, signal)
}

/** Adds the picked loops mirrored across a line. */
export function mirrorSketch(loops: SketchLoop[], pick: number[], axis: { point: Vec2; direction: Vec2 }, signal?: AbortSignal) {
  return geom().call<SketchEdited>('sketch.mirror', { loops, pick, axis }, signal)
}

/** Copies of the picked loops: `count` in all, a step apart, or round a center through angleDeg (360 spreads them evenly). */
export type SketchSpread = { kind: 'line'; count: number; step: Vec2 } | { kind: 'circle'; count: number; center: Vec2; angleDeg: number }

export function patternSketch(loops: SketchLoop[], pick: number[], spread: SketchSpread, signal?: AbortSignal) {
  return geom().call<SketchEdited>('sketch.pattern', { loops, pick, ...spread }, signal)
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
    /** Typed arrays when the app's worker read the mesh from the engine's memory (`meshOutput: "raw"`). */
    parts: { name: string; slot: number; color: string | null; mesh: GeomMesh | TypedGeomMesh; watertight: boolean }[]
    repair: ObjectRepair
    /** A body split from a one-part file: a later crossing check rebuilds each of its shells on its own. */
    perShell?: boolean
  }[]
  unit: UnitSuggestion
  /** One sentence per change, for the import toast. */
  summary: string[]
  warnings: string[]
  slotColors: string[]
}

/** A binary STL as the app read it (export/stl-scan.ts): its corners welded exactly, as the engine's own read does. */
export interface ReadStl {
  positions: Float32Array | number[]
  indices: Uint32Array | number[]
}

/**
 * Reads an OBJ, AMF or STL, repairs it, suggests a unit and splits loose bodies. Meshes are unscaled. The file goes as
 * base64 or as its bytes, which the geometry worker encodes for the engine, off the page; an STL the app has read
 * already can go as that mesh (`stlMesh`), which the worker hands the engine in its raw form, so the engine neither
 * decodes nor reads the file again.
 */
export function importAuto(file: ({ base64: string } | { bytes: Uint8Array } | { stlMesh: ReadStl }) & { name: string; format?: 'obj' | 'amf' | 'stl'; mtl?: string }, auto: AutoOptions = {}, signal?: AbortSignal) {
  const { name, format, mtl } = file
  // The app's worker reads the meshes back from the engine's memory as typed arrays (geom-worker.ts, rawOut).
  const out = usesWorker() ? { meshOutput: 'raw' } : {}
  if ('stlMesh' in file) return geom().call<AutoImport>('import.auto', { stlMesh: file.stlMesh, name, format: 'stl', auto, ...out }, signal)
  const data = 'bytes' in file ? { bytes: file.bytes } : { base64: file.base64 }
  return geom().call<AutoImport>('import.auto', { data, name, ...(format ? { format } : {}), ...(mtl !== undefined ? { mtl } : {}), auto, ...out }, signal)
}

/** A part checked for faces that cross each other: whether it does, and the rebuilt mesh when it was rebuilt. */
export interface SelfCrossing {
  crossing: boolean
  mesh?: GeomMesh
}

/**
 * Checks a part for faces that cross each other and rebuilds it when it is small enough (as the import does, which
 * leaves it out with rebuildMaxTriangles 0, so a model shows before this runs). A mesh as typed arrays goes to the
 * engine without JSON.
 */
export function selfIntersections(mesh: GeomMesh | { positions: Float32Array; indices: Uint32Array }, options: { perShell?: boolean; rebuildMaxTriangles?: number } = {}, signal?: AbortSignal) {
  return geom().call<SelfCrossing>('import.selfIntersections', { mesh, ...options }, signal)
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
  /** Leave out parts that touch (they print as one piece), so they do not crowd out real gaps. */
  skipFused?: boolean
  /** Also report separate pieces closer than this that do not touch (kind `apart`), the closest pair per two pieces. */
  apartMm?: number
}

export interface FitGap {
  /** Indices into FitReport.parts (the bodies; each body's `item` is the mesh it came from). */
  parts: [number, number]
  gapMm: number
  limitMm: number
  /** `apart`: two pieces that do not touch at all, so they print loose. */
  kind: 'horizontal' | 'vertical' | 'fused' | 'apart'
  /** Closest points on each part, world coordinates, for drawing the gap. */
  from: Vec3
  to: Vec3
}

export interface FitReport {
  /** The bodies found, each with the index of the mesh it came from. */
  parts: { bounds: { min: Vec3; max: Vec3 }; volumeMm3: number; triangles: number; item: number }[]
  /** Pairs of parts closer than their limit, closest first (at most 64). */
  gaps: FitGap[]
  limitMm: number
  verticalLimitMm: number
  /** Bodies that touch, joined: how many separate pieces print. */
  pieces: number
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
